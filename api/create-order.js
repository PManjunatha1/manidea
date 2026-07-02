'use strict';

const express               = require('express');
const { randomBytes }       = require('crypto');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Valid Indian mobile: 10 digits, first digit 6-9.
const PHONE_10_REGEX = /^[6-9]\d{9}$/;

// Cashfree return URL — {order_id} is replaced by Cashfree automatically.
const RETURN_URL = 'https://manidea.in/payment-status?order_id={order_id}';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function generateOrderId() {
  return `ORD_${Date.now()}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Converts any value to a trimmed string safely.
 * Handles: string, number, null, undefined, boolean.
 * Never returns null or undefined — always returns a string.
 */
function toStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

/**
 * Normalises a phone value to a bare 10-digit Indian number string.
 *
 * Android may send any of these:
 *   "9876543210"       → "9876543210"   (plain string)
 *   "+919876543210"    → "9876543210"   (E.164 string)
 *   "919876543210"     → "9876543210"   (91-prefix string)
 *   9876543210         → "9876543210"   (JSON number)
 *   919876543210       → "9876543210"   (JSON number with 91 prefix)
 *
 * Returns the normalised string. If unrecognised, returns the raw string
 * so the error message shows exactly what was received.
 */
function normalisePhone(raw) {
  // Convert number type to string first (Android often sends phone as integer)
  const s = toStr(raw).replace(/\s+/g, '').replace(/-/g, '');

  // Already a valid 10-digit number
  if (PHONE_10_REGEX.test(s)) return s;

  // E.164 format: +91XXXXXXXXXX
  if (/^\+91[6-9]\d{9}$/.test(s)) return s.slice(3);

  // 91-prefix without +: 91XXXXXXXXXX (12 digits total)
  if (/^91[6-9]\d{9}$/.test(s)) return s.slice(2);

  // Return as-is so the validation error shows what was actually received
  return s;
}

/**
 * Normalises orderAmount to a finite positive number.
 *
 * Android may send any of these:
 *   500        → 500     (JSON number — most common)
 *   "500"      → 500     (string)
 *   "500.00"   → 500     (string with decimals)
 *   99.99      → 99.99   (float)
 *
 * Returns NaN if the value cannot be parsed as a finite positive number.
 */
function normaliseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return NaN;
  // Remove commas (locale formatting like "1,000")
  const n = Number(String(raw).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Validates the full request body.
 *
 * Returns:
 *   missingFields  — fields that are absent or empty
 *   invalidFields  — fields present but with wrong format/value
 *   fields         — sanitised, normalised values ready for Cashfree
 *
 * The Android contract (camelCase) is preserved here.
 * Conversion to Cashfree snake_case happens only in the route handler.
 */
function validateBody(body) {
  const missingFields = [];
  const invalidFields = [];
  const raw = body || {};

  // ── customerId ──────────────────────────────────────────────────────────────
  const customerId = toStr(raw.customerId);
  if (!customerId) {
    missingFields.push({
      field: 'customerId',
      received: raw.customerId,
      receivedType: typeof raw.customerId,
      reason: 'customerId is required and must not be empty.'
    });
  }

  // ── customerName ────────────────────────────────────────────────────────────
  const customerName = toStr(raw.customerName);
  if (!customerName) {
    missingFields.push({
      field: 'customerName',
      received: raw.customerName,
      receivedType: typeof raw.customerName,
      reason: 'customerName is required and must not be empty.'
    });
  }

  // ── customerEmail ───────────────────────────────────────────────────────────
  const customerEmail = toStr(raw.customerEmail).toLowerCase();
  if (!customerEmail) {
    missingFields.push({
      field: 'customerEmail',
      received: raw.customerEmail,
      receivedType: typeof raw.customerEmail,
      reason: 'customerEmail is required.'
    });
  } else if (!EMAIL_REGEX.test(customerEmail)) {
    invalidFields.push({
      field: 'customerEmail',
      received: raw.customerEmail,
      receivedType: typeof raw.customerEmail,
      reason: `customerEmail format is invalid. Received: "${customerEmail}"`
    });
  }

  // ── customerPhone ───────────────────────────────────────────────────────────
  // Normalise first, then validate. This handles +91, 91, and plain 10-digit.
  const rawPhone      = raw.customerPhone;
  const customerPhone = normalisePhone(rawPhone);

  if (rawPhone === null || rawPhone === undefined || toStr(rawPhone) === '') {
    missingFields.push({
      field: 'customerPhone',
      received: rawPhone,
      receivedType: typeof rawPhone,
      reason: 'customerPhone is required.'
    });
  } else if (!PHONE_10_REGEX.test(customerPhone)) {
    invalidFields.push({
      field: 'customerPhone',
      received: rawPhone,
      receivedType: typeof rawPhone,
      normalised: customerPhone,
      reason: `customerPhone must be a 10-digit Indian mobile number starting with 6-9. ` +
               `Received: "${rawPhone}" (type: ${typeof rawPhone}), normalised to: "${customerPhone}".`
    });
  }

  // ── orderAmount ─────────────────────────────────────────────────────────────
  const rawAmount = raw.orderAmount;
  const amount    = normaliseAmount(rawAmount);

  if (rawAmount === null || rawAmount === undefined || rawAmount === '') {
    missingFields.push({
      field: 'orderAmount',
      received: rawAmount,
      receivedType: typeof rawAmount,
      reason: 'orderAmount is required.'
    });
  } else if (isNaN(amount)) {
    invalidFields.push({
      field: 'orderAmount',
      received: rawAmount,
      receivedType: typeof rawAmount,
      reason: `orderAmount must be a number. Received: "${rawAmount}" (type: ${typeof rawAmount}).`
    });
  } else if (amount <= 0) {
    invalidFields.push({
      field: 'orderAmount',
      received: rawAmount,
      receivedType: typeof rawAmount,
      reason: `orderAmount must be greater than 0. Received: ${amount}.`
    });
  }

  const isValid = missingFields.length === 0 && invalidFields.length === 0;

  return {
    isValid,
    missingFields,
    invalidFields,
    fields: {
      customerId,
      customerName,
      customerEmail,
      customerPhone,
      amount
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/create-order
// ─────────────────────────────────────────────────────────────────────────────
router.get('/create-order', (_req, res) => {
  res.status(200).json({
    success:        true,
    message:        'Send a POST request to /api/create-order to create a payment order.',
    requiredFields: ['customerId', 'customerName', 'customerEmail', 'customerPhone', 'orderAmount'],
    phoneFormats:   ['9876543210', '+919876543210', '919876543210'],
    amountFormats:  ['500', 500, 99.99]
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-order
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-order', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = Date.now();

  // ── STEP 1: Log the complete incoming request ──────────────────────────────
  // Visible in Vercel logs. Shows EXACTLY what Android sent including types.
  console.info('[create-order] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:     new Date().toISOString(),
    method:        req.method,
    path:          req.path,
    contentType:   req.headers['content-type'],
    contentLength: req.headers['content-length'],
    userAgent:     req.headers['user-agent'],
    bodyRaw:       req.body,
    bodyTypes: req.body ? {
      customerId:    typeof req.body.customerId,
      customerName:  typeof req.body.customerName,
      customerEmail: typeof req.body.customerEmail,
      customerPhone: typeof req.body.customerPhone,
      orderAmount:   typeof req.body.orderAmount,
      orderCurrency: typeof req.body.orderCurrency
    } : null
  }));

  try {
    // ── STEP 2: Validate ───────────────────────────────────────────────────────
    const { isValid, missingFields, invalidFields, fields } = validateBody(req.body);

    if (!isValid) {
      console.warn('[create-order] VALIDATION_FAILED ' + JSON.stringify({
        requestId,
        missingFields,
        invalidFields,
        receivedBody: req.body,
        elapsed: `${Date.now() - startTime}ms`
      }));

      return res.status(400).json({
        success:       false,
        reason:        'Request validation failed. See missingFields and invalidFields for details.',
        missingFields,
        invalidFields,
        receivedBody:  req.body,
        requestId
      });
    }

    // ── STEP 3: Build Cashfree payload ─────────────────────────────────────────
    // Android sends camelCase. Cashfree SDK requires snake_case.
    // Conversion happens ONLY here — Android contract is never changed.
    const orderId = generateOrderId();

    const cashfreePayload = {
      order_id:       orderId,
      order_amount:   fields.amount,
      order_currency: 'INR',
      customer_details: {
        customer_id:    fields.customerId,
        customer_name:  fields.customerName,
        customer_email: fields.customerEmail,
        customer_phone: fields.customerPhone
      },
      order_meta: {
        return_url: RETURN_URL
      }
    };

    console.info('[create-order] CASHFREE_REQUEST ' + JSON.stringify({
      requestId,
      cashfreePayload,
      elapsed: `${Date.now() - startTime}ms`
    }));

    // ── STEP 4: Call Cashfree SDK ──────────────────────────────────────────────
    const cashfree = getCashfreeClient();
    const response  = await cashfree.PGCreateOrder(cashfreePayload);
    const data      = response?.data;

    console.info('[create-order] CASHFREE_RESPONSE ' + JSON.stringify({
      requestId,
      httpStatus:   response?.status,
      responseData: data,
      elapsed:      `${Date.now() - startTime}ms`
    }));

    // ── STEP 5: Guard against empty/incomplete Cashfree response ───────────────
    if (!data || !data.payment_session_id) {
      console.error('[create-order] NO_SESSION_IN_RESPONSE ' + JSON.stringify({
        requestId,
        responseData: data
      }));
      return res.status(502).json({
        success:          false,
        reason:           'Payment gateway did not return a payment session. Please retry.',
        cashfreeResponse: data || null,
        requestId
      });
    }

    // ── STEP 6: Success ────────────────────────────────────────────────────────
    console.info('[create-order] SUCCESS ' + JSON.stringify({
      requestId,
      orderId:     data.order_id,
      orderStatus: data.order_status,
      elapsed:     `${Date.now() - startTime}ms`
    }));

    return res.status(200).json({
      success:          true,
      orderId:          data.order_id,
      paymentSessionId: data.payment_session_id,
      orderStatus:      data.order_status,
      requestId
    });

  } catch (err) {
    const cfError      = err?.response?.data;
    const cfHttpStatus = err?.response?.status;

    // Log everything — stack trace, Cashfree error body, received request body
    console.error('[create-order] EXCEPTION ' + JSON.stringify({
      requestId,
      errorMessage:   err.message,
      errorStack:     err.stack,
      cashfreeStatus: cfHttpStatus,
      cashfreeError:  cfError,
      receivedBody:   req.body,
      elapsed:        `${Date.now() - startTime}ms`
    }));

    // Cashfree returned a structured error (4xx/5xx from Cashfree servers)
    if (cfError) {
      return res.status(502).json({
        success:       false,
        reason:        'Payment gateway rejected the request.',
        cashfreeError: {
          code:    cfError.code    || 'UNKNOWN',
          type:    cfError.type    || 'UNKNOWN',
          message: cfError.message || err.message
        },
        receivedBody: req.body,
        requestId
      });
    }

    // Missing environment variables
    if (err.message && err.message.includes('CASHFREE_')) {
      return res.status(500).json({
        success: false,
        reason:  'Server configuration error. Contact support.',
        message: err.message,
        requestId
      });
    }

    // Unknown error — pass to global error handler in index.js
    next(err);
  }
});

module.exports = router;
