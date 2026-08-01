'use strict';

const express = require('express');
const crypto  = require('crypto');

const router = express.Router();

// ── CORS headers for mobile access ───────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── OPTIONS preflight ─────────────────────────────────────────────────────────
router.options('/razorpay/verify-payment', (req, res) => {
  setCors(res);
  res.sendStatus(204);
});

// ── GET /api/razorpay/verify-payment — usage info ─────────────────────────────
router.get('/razorpay/verify-payment', (_req, res) => {
  setCors(res);
  res.status(200).json({
    success:        true,
    method:         'POST /api/razorpay/verify-payment',
    requiredFields: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
    note:           'Signature verified server-side via HMAC-SHA256. KEY_SECRET never leaves the server.'
  });
});

// ── POST /api/razorpay/verify-payment ─────────────────────────────────────────
router.post('/razorpay/verify-payment', (req, res) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = req.startTime || Date.now();

  setCors(res);

  console.info('[razorpay-verify-payment] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:   new Date().toISOString(),
    contentType: req.headers['content-type'],
    userAgent:   req.headers['user-agent'],
    bodyRaw:     req.body
  }));

  try {
    const body      = req.body || {};
    const orderId   = typeof body.razorpay_order_id   === 'string' ? body.razorpay_order_id.trim()   : '';
    const paymentId = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id.trim() : '';
    const signature = typeof body.razorpay_signature  === 'string' ? body.razorpay_signature.trim()  : '';

    // ── Validate required fields — 400 if any missing ─────────────────────
    const missing = [];
    if (!orderId)   missing.push('razorpay_order_id');
    if (!paymentId) missing.push('razorpay_payment_id');
    if (!signature) missing.push('razorpay_signature');

    if (missing.length > 0) {
      console.warn('[razorpay-verify-payment] MISSING_FIELDS ' + JSON.stringify({ requestId, missing }));
      return res.status(400).json({
        success: false,
        status:  'FAILED',
        error:   'Missing required fields.',
        missing,
        requestId
      });
    }

    // ── Read secret from env — never from request ─────────────────────────
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret || !keySecret.trim()) {
      console.error('[razorpay-verify-payment] MISSING_SECRET ' + JSON.stringify({ requestId }));
      return res.status(500).json({
        success: false,
        status:  'FAILED',
        error:   'Server configuration error. Contact support.',
        requestId
      });
    }

    // ── HMAC-SHA256: HMAC(order_id + "|" + payment_id, KEY_SECRET) ────────
    const message           = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret.trim())
      .update(message)
      .digest('hex');

    // timingSafeEqual prevents timing attacks; buffers must be same length
    const sigBuffer      = Buffer.from(signature,          'hex');
    const expectedBuffer = Buffer.from(expectedSignature,  'hex');

    if (sigBuffer.length !== expectedBuffer.length) {
      console.warn('[razorpay-verify-payment] SIGNATURE_LENGTH_MISMATCH ' + JSON.stringify({
        requestId, orderId, paymentId
      }));
      return res.status(400).json({
        success: false,
        status:  'FAILED',
        error:   'Payment signature verification failed. Do not mark as paid.',
        requestId
      });
    }

    const isValid = crypto.timingSafeEqual(expectedBuffer, sigBuffer);
    const elapsed = `${Date.now() - startTime}ms`;

    if (!isValid) {
      console.warn('[razorpay-verify-payment] SIGNATURE_MISMATCH ' + JSON.stringify({
        requestId, orderId, paymentId, elapsed
      }));
      return res.status(400).json({
        success: false,
        status:  'FAILED',
        error:   'Payment signature verification failed. Do not mark as paid.',
        requestId
      });
    }

    console.info('[razorpay-verify-payment] SIGNATURE_VALID ' + JSON.stringify({
      requestId, orderId, paymentId, elapsed
    }));

    return res.status(200).json({
      success:   true,
      status:    'SUCCESS',
      orderId,
      paymentId,
      elapsed,
      requestId
    });

  } catch (err) {
    const elapsed = `${Date.now() - startTime}ms`;

    console.error('[razorpay-verify-payment] EXCEPTION ' + JSON.stringify({
      requestId,
      errorMessage: err.message,
      errorStack:   err.stack,
      elapsed
    }));

    return res.status(500).json({
      success: false,
      status:  'FAILED',
      error:   'Internal server error.',
      requestId
    });
  }
});

module.exports = router;
