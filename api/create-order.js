'use strict';

const express               = require('express');
const { randomBytes }       = require('crypto');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ── Module-level constants (compiled once on cold start) ──────────────────────
const EMAIL_REGEX    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_10_REGEX = /^[6-9]\d{9}$/;
const PHONE_PLUS91   = /^\+91([6-9]\d{9})$/;
const PHONE_91       = /^91([6-9]\d{9})$/;
const RETURN_URL     = 'https://manidea.in/payment-status?order_id={order_id}';

function generateOrderId() {
  return `ORD_${Date.now()}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

function toStr(val) {
  return (val === null || val === undefined) ? '' : String(val).trim();
}

function normalisePhone(raw) {
  const s = toStr(raw).replace(/[\s-]/g, '');
  if (PHONE_10_REGEX.test(s))  return s;
  const m91  = PHONE_PLUS91.exec(s);  if (m91)  return m91[1];
  const m9   = PHONE_91.exec(s);      if (m9)   return m9[1];
  return s;
}

function normaliseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return NaN;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// Accept both camelCase and snake_case from Android
function pick(body, camelKey, snakeKey) {
  return body[camelKey] !== undefined ? body[camelKey] : body[snakeKey];
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateBody(body) {
  const errors = [];
  const raw    = body || {};

  const rawCustomerId = pick(raw, 'customerId', 'customer_id');
  const customerId    = toStr(rawCustomerId);
  if (!customerId) errors.push({ field: 'customer_id', message: 'customer_id is required and must not be empty.', received: rawCustomerId, receivedType: typeof rawCustomerId });

  const rawPhone      = pick(raw, 'customerPhone', 'customer_phone');
  const customerPhone = normalisePhone(rawPhone);
  // Phone is optional from Android — email-login users have no phone in Firebase.
  // Only reject if a value WAS provided but has an invalid format.
  if (toStr(rawPhone) !== '' && !PHONE_10_REGEX.test(customerPhone)) {
    errors.push({ field: 'customer_phone', message: `customer_phone is invalid. Must be a 10-digit Indian mobile number starting with 6-9. Received: "${rawPhone}", normalised: "${customerPhone}".`, received: rawPhone, receivedType: typeof rawPhone });
  }

  const rawAmount = pick(raw, 'orderAmount', 'order_amount');
  const amount    = normaliseAmount(rawAmount);
  if (rawAmount === null || rawAmount === undefined || rawAmount === '') {
    errors.push({ field: 'order_amount', message: 'order_amount is required.', received: rawAmount, receivedType: typeof rawAmount });
  } else if (isNaN(amount)) {
    errors.push({ field: 'order_amount', message: `order_amount must be a number. Received: "${rawAmount}" (type: ${typeof rawAmount}).`, received: rawAmount, receivedType: typeof rawAmount });
  } else if (amount <= 0) {
    errors.push({ field: 'order_amount', message: `order_amount must be greater than 0. Received: ${amount}.`, received: rawAmount, receivedType: typeof rawAmount });
  }

  const rawCustomerName  = pick(raw, 'customerName',  'customer_name');
  const customerName     = toStr(rawCustomerName);

  const rawCustomerEmail = pick(raw, 'customerEmail', 'customer_email');
  const customerEmail    = toStr(rawCustomerEmail).toLowerCase();
  if (customerEmail && !EMAIL_REGEX.test(customerEmail)) {
    errors.push({ field: 'customer_email', message: `customer_email is invalid. Received: "${customerEmail}".`, received: rawCustomerEmail, receivedType: typeof rawCustomerEmail });
  }

  return { isValid: errors.length === 0, errors, fields: { customerId, customerName, customerEmail, customerPhone, amount } };
}

// ── GET /api/create-order — usage info ───────────────────────────────────────
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
    example: { customer_id: 'user_123', customer_name: 'P Manjunatha', customer_email: 'user@example.com', customer_phone: '9876543210', order_amount: 133.90 }
  });
});

// ── POST /api/create-order ────────────────────────────────────────────────────
router.post('/create-order', async (req, res, next) => {
  const { requestId } = req;
  const startTime     = req.startTime || Date.now();

  console.info('[create-order] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:   new Date().toISOString(),
    contentType: req.headers['content-type'],
    userAgent:   req.headers['user-agent'],
    bodyRaw:     req.body
  }));

  // Content-Type guard — if missing, Express won't parse the body
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    console.warn('[create-order] WRONG_CONTENT_TYPE ' + JSON.stringify({ requestId, contentType }));
    return res.status(400).json({
      success: false,
      error:   'Content-Type must be application/json.',
      field:   'Content-Type header',
      message: `Received Content-Type: "${contentType}". Set Content-Type: application/json in your request headers.`,
      requestId
    });
  }

  try {
    const { isValid, errors, fields } = validateBody(req.body);

    if (!isValid) {
      console.warn('[create-order] VALIDATION_FAILED ' + JSON.stringify({ requestId, errorCount: errors.length, errors, elapsed: `${Date.now() - startTime}ms` }));
      return res.status(400).json({ success: false, error: 'Validation failed.', errors, receivedBody: req.body, requestId });
    }

    const orderId = generateOrderId();
    const cashfreePayload = {
      order_id:       orderId,
      order_amount:   fields.amount,
      order_currency: 'INR',
      customer_details: {
        customer_id:    fields.customerId,
        customer_name:  fields.customerName  || '',
        customer_email: fields.customerEmail || '',
        // Cashfree mandates a non-empty phone. Use placeholder for email-only
        // users until the app collects and stores their real phone number.
        customer_phone: fields.customerPhone || '9999999999'
      },
      order_meta: { return_url: RETURN_URL }
    };

    console.info('[create-order] CASHFREE_REQUEST ' + JSON.stringify({ requestId, cashfreePayload, elapsed: `${Date.now() - startTime}ms` }));

    const cashfree = getCashfreeClient();
    const response = await cashfree.PGCreateOrder(cashfreePayload);
    const data     = response?.data;

    console.info('[create-order] CASHFREE_RESPONSE ' + JSON.stringify({ requestId, httpStatus: response?.status, responseData: data, elapsed: `${Date.now() - startTime}ms` }));

    if (!data || !data.payment_session_id) {
      console.error('[create-order] NO_SESSION ' + JSON.stringify({ requestId, data }));
      return res.status(502).json({ success: false, error: 'Payment gateway did not return a session. Please retry.', cashfreeResponse: data || null, requestId });
    }

    console.info('[create-order] SUCCESS ' + JSON.stringify({ requestId, orderId: data.order_id, orderStatus: data.order_status, elapsed: `${Date.now() - startTime}ms` }));

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
      elapsed:        `${Date.now() - startTime}ms`
    }));

    if (cfError) {
      return res.status(502).json({
        success:       false,
        error:         'Payment gateway rejected the request.',
        cashfreeError: { code: cfError.code || 'UNKNOWN', type: cfError.type || 'UNKNOWN', message: cfError.message || err.message },
        receivedBody:  req.body,
        requestId
      });
    }

    if (err.message && err.message.includes('CASHFREE_')) {
      return res.status(500).json({ success: false, error: 'Server configuration error. Contact support.', message: err.message, requestId });
    }

    next(err);
  }
});

module.exports = router;
