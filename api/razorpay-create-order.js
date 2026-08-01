'use strict';

const express                = require('express');
const { getRazorpayClient }  = require('./razorpay-client');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────
function toInt(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? NaN : n;
}

// ── GET /api/razorpay/create-order — usage info ───────────────────────────────
router.get('/razorpay/create-order', (_req, res) => {
  res.status(200).json({
    success: true,
    method:  'POST /api/razorpay/create-order',
    fields: {
      amount:   'integer — required (in paise, minimum 100)',
      currency: 'string  — optional (default: INR)',
      receipt:  'string  — optional'
    },
    example: { amount: 49900, currency: 'INR', receipt: 'receipt_001' }
  });
});

// ── POST /api/razorpay/create-order ──────────────────────────────────────────
router.post('/razorpay/create-order', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = req.startTime || Date.now();

  console.info('[razorpay-create-order] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:   new Date().toISOString(),
    contentType: req.headers['content-type'],
    userAgent:   req.headers['user-agent'],
    bodyRaw:     req.body
  }));

  // ── Content-Type guard ────────────────────────────────────────────────────
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    return res.status(400).json({
      success:   false,
      error:     'Content-Type must be application/json.',
      requestId
    });
  }

  try {
    const body     = req.body || {};
    const amount   = toInt(body.amount);
    const currency = typeof body.currency === 'string' && body.currency.trim()
      ? body.currency.trim().toUpperCase()
      : 'INR';
    const receipt  = typeof body.receipt === 'string' && body.receipt.trim()
      ? body.receipt.trim()
      : `receipt_${Date.now()}`;

    // ── Validate ──────────────────────────────────────────────────────────
    const errors = [];

    if (body.amount === undefined || body.amount === null || body.amount === '') {
      errors.push({ field: 'amount', message: 'amount is required (in paise).' });
    } else if (isNaN(amount)) {
      errors.push({ field: 'amount', message: `amount must be an integer. Received: "${body.amount}".` });
    } else if (amount < 100) {
      errors.push({ field: 'amount', message: `amount must be at least 100 paise. Received: ${amount}.` });
    }

    if (errors.length > 0) {
      console.warn('[razorpay-create-order] VALIDATION_FAILED ' + JSON.stringify({ requestId, errors, receivedBody: body }));
      return res.status(400).json({ success: false, error: 'Validation failed.', errors, requestId });
    }

    // ── Call Razorpay ─────────────────────────────────────────────────────
    const payload = { amount, currency, receipt };

    console.info('[razorpay-create-order] RAZORPAY_REQUEST ' + JSON.stringify({ requestId, payload }));

    const razorpay = getRazorpayClient();
    const order    = await razorpay.orders.create(payload);

    console.info('[razorpay-create-order] RAZORPAY_RESPONSE ' + JSON.stringify({
      requestId,
      orderId:     order.id,
      orderStatus: order.status,
      elapsed:     `${Date.now() - startTime}ms`
    }));

    return res.status(200).json({
      success:  true,
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      receipt:  order.receipt,
      requestId
    });

  } catch (err) {
    const rzpError      = err?.error;
    const rzpHttpStatus = err?.statusCode;

    console.error('[razorpay-create-order] EXCEPTION ' + JSON.stringify({
      requestId,
      errorMessage:    err.message,
      razorpayStatus:  rzpHttpStatus,
      razorpayError:   rzpError,
      elapsed:         `${Date.now() - startTime}ms`
    }));

    if (rzpHttpStatus === 401) {
      return res.status(401).json({ success: false, error: 'Razorpay authentication failed. Check API credentials.', requestId });
    }

    if (rzpError) {
      return res.status(500).json({
        success:       false,
        error:         'Razorpay API error.',
        razorpayError: { code: rzpError.code || 'UNKNOWN', description: rzpError.description || err.message },
        requestId
      });
    }

    if (err.message && err.message.includes('RAZORPAY_')) {
      return res.status(500).json({ success: false, error: 'Server configuration error. Contact support.', message: err.message, requestId });
    }

    next(err);
  }
});

module.exports = router;
