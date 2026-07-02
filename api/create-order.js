'use strict';

const express               = require('express');
const { randomBytes }       = require('crypto');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Accepts:
//   9876543210        (10-digit, starts 6-9)
//   +919876543210     (E.164 with +91)
//   919876543210      (with 91 prefix, no +)
const PHONE_REGEX_10   = /^[6-9]\d{9}$/;
const PHONE_PREFIX_E164 = /^\+91([6-9]\d{9})$/;
const PHONE_PREFIX_91   = /^91([6-9]\d{9})$/;

const RETURN_URL = 'https://manidea.in/payment-status?order_id={order_id}';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function generateOrderId() {
  return `ORD_${Date.now()}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Normalises a phone value to a bare 10-digit Indian number.
 * Accepts: "9876543210", "+919876543210", "919876543210", 9876543210 (number type).
 * Returns the 10-digit string, or empty string if unrecognised.
 */
function normalisePhone(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
  if (PHONE_REGEX_10.test(s))    return s;
  const m1 = s.match(PHONE_PREFIX_E164);
  if (m1) return m1[1];
  const m2 = s.match(PHONE_PREFIX_91);
  if (m2) return m2[1];
  return s; // return as-is so the error message shows what was received
}

/**
 * Normalises orderAmount to a finite positive number.
 * Accepts number type or string type ("500", "500.00").
 * Returns NaN if the value cannot be parsed.
 */
function normaliseAmount(raw) {
  if (raw === undefined || raw === null || raw === '') return NaN;
  const n = Number(String(raw).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Validates and sanitises the full request body.
 * Returns { errors: string[], fields: object }.
 * errors is empty when the body is valid.
 */
function validateBody(body) {
  const errors = [];
  const raw    = body || {};

  // ── customerId ──────────────────────────────────────────────────────────────
  const customerId = typeof raw.customerId === 'string'
    ? raw.customerId.trim()
    : String(raw.customerId == null ? '' : raw.customerId).trim();
  if (!customerId) errors.push('customerId is required and must not be empty.');

  // ── customerName ────────────────────────────────────────────────────────────
  const customerName = typeof raw.customerName === 'string'
    ? raw.customerName.trim()
    : String(raw.customerName == null ? '' : raw.customerName).trim();
  if (!customerName) errors.push('customerName is required and must not be empty.');

  // ── customerEmail ───────────────────────────────────────────────────────────
  const customerEmail = typeof raw.customerEmail === 'string'
    ? raw.customerEmail.trim().toLowerCase()
    : String(raw.customerEmail == null ? '' : raw.customerEmail).trim().toLowerCase();
  if (!EMAIL_REGEX.test(customerEmail))
    errors.push(`customerEmail is invalid. Received: "${customerEmail}"`);

  // ── customerPhone ───────────────────────────────────────────────────────────
  // Normalise first (+91 / 91 prefix stripped), then validate 10-digit format.
  const customerPhone = normalisePhone(raw.customerPhone);
  if (!PHONE_REGEX_10.test(customerPhone))
    errors.push(
      `customerPhone must be a 10-digit Indian mobile number (6-9 start). ` +
      `Received: "${raw.customerPhone}" → normalised: "${customerPhone}"`
    );

  // ── orderAmount ─────────────────────────────────────────────────────────────
  const amount = normaliseAmount(raw.orderAmount);
  if (isNaN(amount))
    errors.push(`orderAmount must be a positive number. Received: "${raw.orderAmount}"`);
  else if (amount <= 0)
    errors.push(`orderAmount must be greater than 0. Received: ${amount}`);

  return {
    errors,
    fields: { customerId, customerName, customerEmail, customerPhone, amount }
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
    phoneFormats:   ['9876543210', '+919876543210', '919876543210']
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-order
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-order', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = Date.now();

  // ── STEP 1: Log the complete incoming request ──────────────────────────────
  // This prints in Vercel logs so you can see EXACTLY what Android sent.
  console.info('[create-order] INCOMING REQUEST', JSON.stringify({
    requestId,
    timestamp:   new Date().toISOString(),
    method:      req.method,
    path:        req.path,
    headers: {
      'content-type':  req.headers['content-type'],
      'content-length': req.headers['content-length'],
      'user-agent':    req.headers['user-agent'],
      'accept':        req.headers['accept']
    },
    body: req.body   // full raw body as parsed by Express JSON middleware
  }));

  try {
    // ── STEP 2: Validate ───────────────────────────────────────────────────────
    const { errors, fields } = validateBody(req.body);

    if (errors.length > 0) {
      console.warn('[create-order] VALIDATION FAILED', JSON.stringify({
        requestId,
        errors,
        receivedBody: req.body,
        elapsed: `${Date.now() - startTime}ms`
      }));
      return res.status(400).json({
        success:      false,
        error:        'Validation failed.',
        details:      errors,
        receivedBody: req.body,   // echo back so Android dev can see what arrived
        requestId
      });
    }

    // ── STEP 3: Build Cashfree payload ─────────────────────────────────────────
    const orderId      = generateOrderId();
    const orderPayload = {
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

    console.info('[create-order] CASHFREE REQUEST', JSON.stringify({
      requestId,
      orderId,
      orderPayload
    }));

    // ── STEP 4: Call Cashfree ──────────────────────────────────────────────────
    const cashfree = getCashfreeClient();
    const response  = await cashfree.PGCreateOrder(orderPayload);
    const data      = response?.data;

    console.info('[create-order] CASHFREE RESPONSE', JSON.stringify({
      requestId,
      httpStatus:   response?.status,
      responseData: data,
      elapsed:      `${Date.now() - startTime}ms`
    }));

    // ── STEP 5: Guard empty response ───────────────────────────────────────────
    if (!data || !data.payment_session_id) {
      console.error('[create-order] NO SESSION IN RESPONSE', JSON.stringify({
        requestId,
        data
      }));
      return res.status(502).json({
        success:          false,
        error:            'Payment gateway did not return a session.',
        cashfreeResponse: data,
        requestId
      });
    }

    // ── STEP 6: Success ────────────────────────────────────────────────────────
    console.info('[create-order] SUCCESS', JSON.stringify({
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

    // ── Log the complete error — nothing hidden ────────────────────────────────
    console.error('[create-order] EXCEPTION', JSON.stringify({
      requestId,
      message:          err.message,
      stack:            err.stack,
      cashfreeStatus:   cfHttpStatus,
      cashfreeError:    cfError,
      receivedBody:     req.body,
      elapsed:          `${Date.now() - startTime}ms`
    }));

    // Cashfree returned a structured error response
    if (cfError) {
      return res.status(502).json({
        success:          false,
        error:            'Payment gateway rejected the request.',
        code:             cfError.code    || 'GATEWAY_ERROR',
        message:          cfError.message || err.message,
        cashfreeResponse: cfError,
        requestId
      });
    }

    // Env var missing or SDK init failure
    if (err.message && err.message.includes('CASHFREE_')) {
      return res.status(500).json({
        success:   false,
        error:     'Server configuration error.',
        message:   err.message,
        requestId
      });
    }

    // Unknown — pass to global error handler in index.js
    next(err);
  }
});

module.exports = router;
