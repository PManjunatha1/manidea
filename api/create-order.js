'use strict';

const express               = require('express');
const { randomBytes }       = require('crypto');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const EMAIL_REGEX    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_10_REGEX = /^[6-9]\d{9}$/;
const RETURN_URL     = 'https://manidea.in/payment-status?order_id={order_id}';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function generateOrderId() {
  return `ORD_${Date.now()}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

// Safely converts any value to a trimmed string. Never returns null/undefined.
function toStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

// Normalises phone to bare 10-digit Indian number.
// Accepts: "9876543210", "+919876543210", "919876543210", 9876543210 (number type)
function normalisePhone(raw) {
  const s = toStr(raw).replace(/\s+/g, '').replace(/-/g, '');
  if (PHONE_10_REGEX.test(s))          return s;
  if (/^\+91[6-9]\d{9}$/.test(s))     return s.slice(3);
  if (/^91[6-9]\d{9}$/.test(s))       return s.slice(2);
  return s;
}

// Normalises amount to a finite positive number.
// Accepts: 500 (number), "500" (string), "500.00", 99.99
function normaliseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return NaN;
  const n = Number(String(raw).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Reads a field from the request body accepting BOTH camelCase and snake_case.
 *
 * Android may send either format depending on the version of the app.
 * camelCase key is checked first, snake_case key is the fallback.
 *
 * Examples:
 *   pick(body, 'customerId',    'customer_id')
 *   pick(body, 'orderAmount',   'order_amount')
 *   pick(body, 'customerPhone', 'customer_phone')
 */
function pick(body, camelKey, snakeKey) {
  const val = body[camelKey] !== undefined ? body[camelKey] : body[snakeKey];
  return val;
}

/**
 * Validates the full request body.
 * Accepts BOTH camelCase and snake_case field names from Android.
 * Returns missingFields, invalidFields, and sanitised fields object.
 */
function validateBody(body) {
  const missingFields = [];
  const invalidFields = [];
  const raw = body || {};

  // ── customer_id / customerId ────────────────────────────────────────────────
  const rawCustomerId = pick(raw, 'customerId', 'customer_id');
  const customerId    = toStr(rawCustomerId);
  if (!customerId) {
    missingFields.push({
      field:        'customerId / customer_id',
      received:     rawCustomerId,
      receivedType: typeof rawCustomerId,
      reason:       'Required. Send as "customerId" or "customer_id".'
    });
  }

  // ── customer_name / customerName ────────────────────────────────────────────
  const rawCustomerName = pick(raw, 'customerName', 'customer_name');
  const customerName    = toStr(rawCustomerName);
  // customerName is optional — Cashfree accepts empty string

  // ── customer_email / customerEmail ──────────────────────────────────────────
  const rawCustomerEmail = pick(raw, 'customerEmail', 'customer_email');
  const customerEmail    = toStr(rawCustomerEmail).toLowerCase();
  // customerEmail is optional — only validate format if provided
  if (customerEmail && !EMAIL_REGEX.test(customerEmail)) {
    invalidFields.push({
      field:        'customerEmail / customer_email',
      received:     rawCustomerEmail,
      receivedType: typeof rawCustomerEmail,
      reason:       `Email format is invalid. Received: "${customerEmail}"`
    });
  }

  // ── customer_phone / customerPhone ──────────────────────────────────────────
  const rawPhone      = pick(raw, 'customerPhone', 'customer_phone');
  const customerPhone = normalisePhone(rawPhone);

  if (rawPhone === null || rawPhone === undefined || toStr(rawPhone) === '') {
    missingFields.push({
      field:        'customerPhone / customer_phone',
      received:     rawPhone,
      receivedType: typeof rawPhone,
      reason:       'Required. Send as "customerPhone" or "customer_phone".'
    });
  } else if (!PHONE_10_REGEX.test(customerPhone)) {
    invalidFields.push({
      field:        'customerPhone / customer_phone',
      received:     rawPhone,
      receivedType: typeof rawPhone,
      normalised:   customerPhone,
      reason:       `Must be a 10-digit Indian mobile number (starts 6-9). ` +
                    `Received: "${rawPhone}" (${typeof rawPhone}), normalised: "${customerPhone}".`
    });
  }

  // ── order_amount / orderAmount ──────────────────────────────────────────────
  const rawAmount = pick(raw, 'orderAmount', 'order_amount');
  const amount    = normaliseAmount(rawAmount);

  if (rawAmount === null || rawAmount === undefined || rawAmount === '') {
    missingFields.push({
      field:        'orderAmount / order_amount',
      received:     rawAmount,
      receivedType: typeof rawAmount,
      reason:       'Required. Send as "orderAmount" or "order_amount".'
    });
  } else if (isNaN(amount)) {
    invalidFields.push({
      field:        'orderAmount / order_amount',
      received:     rawAmount,
      receivedType: typeof rawAmount,
      reason:       `Must be a number. Received: "${rawAmount}" (${typeof rawAmount}).`
    });
  } else if (amount <= 0) {
    invalidFields.push({
      field:        'orderAmount / order_amount',
      received:     rawAmount,
      receivedType: typeof rawAmount,
      reason:       `Must be greater than 0. Received: ${amount}.`
    });
  }

  return {
    isValid: missingFields.length === 0 && invalidFields.length === 0,
    missingFields,
    invalidFields,
    fields: { customerId, customerName, customerEmail, customerPhone, amount }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/create-order
// ─────────────────────────────────────────────────────────────────────────────
router.get('/create-order', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'POST /api/create-order to create a payment order.',
    note:    'Both camelCase and snake_case field names are accepted.',
    acceptedFormats: {
      camelCase: {
        customerId:    'string (required)',
        customerPhone: 'string or number (required)',
        orderAmount:   'number (required)',
        customerName:  'string (optional)',
        customerEmail: 'string (optional)'
      },
      snakeCase: {
        customer_id:    'string (required)',
        customer_phone: 'string or number (required)',
        order_amount:   'number (required)',
        customer_name:  'string (optional)',
        customer_email: 'string (optional)'
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-order
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-order', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = Date.now();

  // ── STEP 1: Log complete incoming request ──────────────────────────────────
  console.info('[create-order] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:     new Date().toISOString(),
    contentType:   req.headers['content-type'],
    contentLength: req.headers['content-length'],
    userAgent:     req.headers['user-agent'],
    bodyRaw:       req.body,
    bodyKeys:      req.body ? Object.keys(req.body) : [],
    bodyTypes:     req.body
      ? Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, typeof v]))
      : {}
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
        elapsed:      `${Date.now() - startTime}ms`
      }));

      return res.status(400).json({
        success:       false,
        reason:        'Validation failed. Check missingFields and invalidFields.',
        missingFields,
        invalidFields,
        receivedBody:  req.body,
        hint:          'Both camelCase (customerId) and snake_case (customer_id) are accepted.',
        requestId
      });
    }

    // ── STEP 3: Build Cashfree payload ─────────────────────────────────────────
    // Android sends camelCase OR snake_case.
    // Cashfree SDK always requires snake_case inside customer_details.
    // That conversion happens ONLY here.
    const orderId = generateOrderId();

    const cashfreePayload = {
      order_id:       orderId,
      order_amount:   fields.amount,
      order_currency: 'INR',
      customer_details: {
        customer_id:    fields.customerId,
        customer_name:  fields.customerName  || '',
        customer_email: fields.customerEmail || '',
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

    // ── STEP 5: Guard empty Cashfree response ──────────────────────────────────
    if (!data || !data.payment_session_id) {
      console.error('[create-order] NO_SESSION ' + JSON.stringify({ requestId, data }));
      return res.status(502).json({
        success:          false,
        reason:           'Payment gateway did not return a session. Please retry.',
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

    console.error('[create-order] EXCEPTION ' + JSON.stringify({
      requestId,
      errorMessage:   err.message,
      errorStack:     err.stack,
      cashfreeStatus: cfHttpStatus,
      cashfreeError:  cfError,
      receivedBody:   req.body,
      elapsed:        `${Date.now() - startTime}ms`
    }));

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

    if (err.message && err.message.includes('CASHFREE_')) {
      return res.status(500).json({
        success: false,
        reason:  'Server configuration error. Contact support.',
        message: err.message,
        requestId
      });
    }

    next(err);
  }
});

module.exports = router;
