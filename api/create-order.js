'use strict';

const express = require('express');
const { randomBytes } = require('crypto');
const { Cashfree, CFEnvironment } = require('cashfree-pg');

const router = express.Router();

// ── Cashfree client (initialised once at module load) ─────────────────────────
const CF_ENV = process.env.CASHFREE_ENV === 'PRODUCTION'
  ? CFEnvironment.PRODUCTION
  : CFEnvironment.SANDBOX;

const cashfree = new Cashfree(
  CF_ENV,
  process.env.CASHFREE_APP_ID,
  process.env.CASHFREE_SECRET_KEY
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateOrderId() {
  return `ORD_${Date.now()}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[6-9]\d{9}$/;

function validateBody(body) {
  const { customerId, customerName, customerEmail, customerPhone, orderAmount } = body || {};
  const errors = [];

  if (!customerId || typeof customerId !== 'string' || !customerId.trim())
    errors.push('customerId is required');
  if (!customerName || typeof customerName !== 'string' || !customerName.trim())
    errors.push('customerName is required');
  if (!customerEmail || !EMAIL_RE.test(customerEmail))
    errors.push('customerEmail must be a valid email address');
  if (!customerPhone || !PHONE_RE.test(String(customerPhone)))
    errors.push('customerPhone must be a valid 10-digit Indian mobile number');

  const amount = Number(orderAmount);
  if (orderAmount === undefined || orderAmount === null || orderAmount === '')
    errors.push('orderAmount is required');
  else if (!Number.isFinite(amount) || amount <= 0)
    errors.push('orderAmount must be a positive number');

  return { errors, amount };
}

// ── GET /api/create-order ─────────────────────────────────────────────────────
router.get('/create-order', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Use POST /api/create-order to create a payment order.',
    requiredFields: ['customerId', 'customerName', 'customerEmail', 'customerPhone', 'orderAmount']
  });
});

// ── POST /api/create-order ────────────────────────────────────────────────────
router.post('/create-order', async (req, res, next) => {
  const requestId = req._requestId || `req_${Date.now()}`;
  const startTime = Date.now();

  try {
    const { errors, amount } = validateBody(req.body);

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation Failed',
        details: errors,
        requestId
      });
    }

    const { customerId, customerName, customerEmail, customerPhone } = req.body;
    const orderId = generateOrderId();

    const orderRequest = {
      order_id: orderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: String(customerId).trim(),
        customer_name: String(customerName).trim(),
        customer_email: String(customerEmail).trim().toLowerCase(),
        customer_phone: String(customerPhone).trim()
      },
      order_meta: {
        return_url: `https://manidea.in/payment-status?order_id={order_id}`
      }
    };

    const response = await cashfree.PGCreateOrder(orderRequest);
    const data = response?.data;

    if (!data || !data.payment_session_id) {
      console.error('[create-order] Cashfree returned no session', { requestId, data });
      return res.status(502).json({
        success: false,
        error: 'Payment gateway did not return a session. Please retry.',
        requestId
      });
    }

    console.info('[create-order] SUCCESS', {
      requestId,
      orderId: data.order_id,
      elapsed: `${Date.now() - startTime}ms`
    });

    return res.status(200).json({
      success: true,
      orderId: data.order_id,
      paymentSessionId: data.payment_session_id,
      orderStatus: data.order_status,
      requestId
    });

  } catch (err) {
    const cfError = err?.response?.data;
    console.error('[create-order] ERROR', {
      requestId,
      message: err.message,
      cashfreeError: cfError,
      elapsed: `${Date.now() - startTime}ms`
    });

    if (cfError) {
      return res.status(502).json({
        success: false,
        error: 'Payment gateway error',
        code: cfError.code || 'GATEWAY_ERROR',
        requestId
      });
    }

    next(err);
  }
});

module.exports = router;
