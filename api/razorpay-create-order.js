'use strict';

const express               = require('express');
const { getRazorpayClient } = require('./razorpay-client');

const router = express.Router();

// ── CORS headers for mobile access ───────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toInt(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? NaN : n;
}

// ── OPTIONS preflight ─────────────────────────────────────────────────────────
router.options('/razorpay/create-order', (req, res) => {
  setCors(res);
  res.sendStatus(204);
});

// ── GET /api/razorpay/create-order — usage info ───────────────────────────────
router.get('/razorpay/create-order', (_req, res) => {
  setCors(res);
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

  setCors(res);

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
      success: false,
      error:   'Content-Type must be application/json.',
      requestId
    });
  }

  try {
    const body     = req.body || {};
    const amount   = toInt(body.amount);
    const currency = typeof body.currency === 'string' && body.currency.trim()
      ? body.currency.trim().toUpperCase()
      : 'INR';
    const rawReceipt = typeof body.receipt === 'string' && body.receipt.trim()
      ? body.receipt.trim()
      : `receipt_${Date.now()}`;
    const receipt = rawReceipt.substring(0, 40); // Razorpay max 40 chars

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

    const elapsed = `${Date.now() - startTime}ms`;
    console.info('[razorpay-create-order] ORDER_CREATED ' + JSON.stringify({
      requestId,
      orderId:     order.id,
      orderStatus: order.status,
      amount:      order.amount,
      currency:    order.currency,
      elapsed
    }));

    // key_id returned so Android can initialise the Razorpay SDK without
    // hardcoding credentials on the client side.
    return res.status(200).json({
      success:  true,
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      receipt:  order.receipt,
      key_id:   process.env.RAZORPAY_KEY_ID,
      requestId
    });

  } catch (err) {
    const rzpError      = err?.error;
    const rzpHttpStatus = err?.statusCode;

    console.error('[razorpay-create-order] EXCEPTION ' + JSON.stringify({
      requestId,
      errorMessage:   err.message,
      razorpayStatus: rzpHttpStatus,
      razorpayError:  rzpError,
      elapsed:        `${Date.now() - startTime}ms`
    }));

    if (rzpHttpStatus === 401) {
      return res.status(401).json({
        success: false,
        error:   'Razorpay authentication failed. Check API credentials.',
        requestId
      });
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
