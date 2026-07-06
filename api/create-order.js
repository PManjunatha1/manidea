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

// Converts any value to a trimmed string. Never returns null or undefined.
function toStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

// Normalises phone to a bare 10-digit Indian number.
// Handles: "9876543210", "+919876543210", "919876543210", 9876543210 (number)
function normalisePhone(raw) {
  const s = toStr(raw).replace(/\s+/g, '').replace(/-/g, '');
  if (PHONE_10_REGEX.test(s))       return s;           // already 10-digit
  if (/^\+91[6-9]\d{9}$/.test(s))  return s.slice(3);  // +91XXXXXXXXXX
  if (/^91[6-9]\d{9}$/.test(s))    return s.slice(2);  // 91XXXXXXXXXX
  return s;
}

// Normalises amount to a finite positive number.
// Handles: 500 (number), "500" (string), "500.00", 99.99
function normaliseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return NaN;
  const n = Number(String(raw).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// Reads a field accepting BOTH camelCase and snake_case.
// camelCase is checked first; snake_case is the fallback.
function pick(body, camelKey, snakeKey) {
  return body[camelKey] !== undefined ? body[camelKey] : body[snakeKey];
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// Returns a flat errors array — one object per failed field.
// Each object has: { field, message, received, receivedType }
// ─────────────────────────────────────────────────────────────────────────────
function validateBody(body) {
  const errors = [];
  const raw    = body || {};

  // ── customer_id ─────────────────────────────────────────────────────────────
  const rawCustomerId = pick(raw, 'customerId', 'customer_id');
  const customerId    = toStr(rawCustomerId);
  if (!customerId) {
    errors.push({
      field:        'customer_id',
      message:      'customer_id is required and must not be empty.',
      received:     rawCustomerId,
      receivedType: typeof rawCustomerId
    });
  }

  // ── customer_phone ───────────────────────────────────────────────────────────
  const rawPhone      = pick(raw, 'customerPhone', 'customer_phone');
  const customerPhone = normalisePhone(rawPhone);
  if (rawPhone === null || rawPhone === undefined || toStr(rawPhone) === '') {
    errors.push({
      field:        'customer_phone',
      message:      'customer_phone is required.',
      received:     rawPhone,
      receivedType: typeof rawPhone
    });
  } else if (!PHONE_10_REGEX.test(customerPhone)) {
    errors.push({
      field:        'customer_phone',
      message:      `customer_phone is invalid. Must be a 10-digit Indian mobile number starting with 6-9. Received: "${rawPhone}", normalised: "${customerPhone}".`,
      received:     rawPhone,
      receivedType: typeof rawPhone
    });
  }

  // ── order_amount ─────────────────────────────────────────────────────────────
  const rawAmount = pick(raw, 'orderAmount', 'order_amount');
  const amount    = normaliseAmount(rawAmount);
  if (rawAmount === null || rawAmount === undefined || rawAmount === '') {
    errors.push({
      field:        'order_amount',
      message:      'order_amount is required.',
      received:     rawAmount,
      receivedType: typeof rawAmount
    });
  } else if (isNaN(amount)) {
    errors.push({
      field:        'order_amount',
      message:      `order_amount must be a number. Received: "${rawAmount}" (type: ${typeof rawAmount}).`,
      received:     rawAmount,
      receivedType: typeof rawAmount
    });
  } else if (amount <= 0) {
    errors.push({
      field:        'order_amount',
      message:      `order_amount must be greater than 0. Received: ${amount}.`,
      received:     rawAmount,
      receivedType: typeof rawAmount
    });
  }

  // ── customer_name (optional) ─────────────────────────────────────────────────
  const rawCustomerName = pick(raw, 'customerName', 'customer_name');
  const customerName    = toStr(rawCustomerName);

  // ── customer_email (optional, validate format only if provided) ──────────────
  const rawCustomerEmail = pick(raw, 'customerEmail', 'customer_email');
  const customerEmail    = toStr(rawCustomerEmail).toLowerCase();
  if (customerEmail && !EMAIL_REGEX.test(customerEmail)) {
    errors.push({
      field:        'customer_email',
      message:      `customer_email is invalid. Received: "${customerEmail}".`,
      received:     rawCustomerEmail,
      receivedType: typeof rawCustomerEmail
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    fields: { customerId, customerName, customerEmail, customerPhone, amount }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/create-order  — usage info
// ─────────────────────────────────────────────────────────────────────────────
router.get('/create-order', (_req, res) => {
  res.status(200).json({
    success: true,
    method:  'POST /api/create-order',
    note:    'Both camelCase and snake_case field names are accepted.',
    fields: {
      customer_id:    'string  — required',
      customer_phone: 'string  — required  (10-digit Indian mobile, or +91/91 prefix)',
      order_amount:   'number  — required  (> 0)',
      customer_name:  'string  — optional',
      customer_email: 'string  — optional',
      order_currency: 'string  — optional  (default: INR)'
    },
    example: {
      customer_id:    'user_123',
      customer_name:  'P Manjunatha',
      customer_email: 'user@example.com',
      customer_phone: '9876543210',
      order_amount:   133.90
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-order
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-order', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = Date.now();

  // ── STEP 1: Log the complete incoming request ──────────────────────────────
  // Every field name, value, and type is logged.
  // Visible in Vercel logs — shows exactly what Android sent.
  console.info('[create-order] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:     new Date().toISOString(),
    contentType:   req.headers['content-type'],
    contentLength: req.headers['content-length'],
    userAgent:     req.headers['user-agent'],
    bodyKeys:      req.body ? Object.keys(req.body) : [],
    bodyTypes:     req.body
      ? Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, typeof v]))
      : {},
    bodyRaw:       req.body
  }));

  // ── STEP 2: Guard — Content-Type must be application/json ──────────────────
  // If Android forgets to set Content-Type, Express won't parse the body.
  // req.body will be {} and every field will appear missing.
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    console.warn('[create-order] WRONG_CONTENT_TYPE ' + JSON.stringify({
      requestId,
      contentType,
      bodyKeys: req.body ? Object.keys(req.body) : []
    }));
    return res.status(400).json({
      success: false,
      error:   'Content-Type must be application/json.',
      field:   'Content-Type header',
      message: `Received Content-Type: "${contentType}". Set Content-Type: application/json in your request headers.`,
      requestId
    });
  }

  try {
    // ── STEP 3: Validate ───────────────────────────────────────────────────────
    const { isValid, errors, fields } = validateBody(req.body);

    if (!isValid) {
      // Log every failed field with its received value and type
      console.warn('[create-order] VALIDATION_FAILED ' + JSON.stringify({
        requestId,
        errorCount:   errors.length,
        errors,
        receivedBody: req.body,
        elapsed:      `${Date.now() - startTime}ms`
      }));

      // Return one error object per failed field so Android can parse each one
      return res.status(400).json({
        success:      false,
        error:        'Validation failed.',
        errors,                    // array: [{ field, message, received, receivedType }]
        receivedBody: req.body,    // echo back so Android dev sees what arrived
        requestId
      });
    }

    // ── STEP 4: Build Cashfree payload ─────────────────────────────────────────
    // Android sends camelCase OR snake_case.
    // Cashfree SDK always requires snake_case. Conversion happens only here.
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

    // ── STEP 5: Call Cashfree SDK ──────────────────────────────────────────────
    const cashfree = getCashfreeClient();
    const response  = await cashfree.PGCreateOrder(cashfreePayload);
    const data      = response?.data;

    console.info('[create-order] CASHFREE_RESPONSE ' + JSON.stringify({
      requestId,
      httpStatus:   response?.status,
      responseData: data,
      elapsed:      `${Date.now() - startTime}ms`
    }));

    // ── STEP 6: Guard empty Cashfree response ──────────────────────────────────
    if (!data || !data.payment_session_id) {
      console.error('[create-order] NO_SESSION ' + JSON.stringify({ requestId, data }));
      return res.status(502).json({
        success:          false,
        error:            'Payment gateway did not return a session. Please retry.',
        cashfreeResponse: data || null,
        requestId
      });
    }

    // ── STEP 7: Success ────────────────────────────────────────────────────────
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

    // Cashfree returned a structured error
    if (cfError) {
      return res.status(502).json({
        success:       false,
        error:         'Payment gateway rejected the request.',
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
        error:   'Server configuration error. Contact support.',
        message: err.message,
        requestId
      });
    }

    next(err);
  }
});

module.exports = router;
