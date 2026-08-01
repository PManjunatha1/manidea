'use strict';

const express    = require('express');
const crypto     = require('crypto');

const router = express.Router();

// ── GET /api/razorpay/verify-payment — usage info ─────────────────────────────
router.get('/razorpay/verify-payment', (_req, res) => {
  res.status(200).json({
    success:        true,
    method:         'POST /api/razorpay/verify-payment',
    requiredFields: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
    note:           'Signature is verified server-side using HMAC-SHA256. KEY_SECRET never leaves the server.'
  });
});

// ── POST /api/razorpay/verify-payment ─────────────────────────────────────────
router.post('/razorpay/verify-payment', (req, res) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = req.startTime || Date.now();

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

    // ── Validate required fields ──────────────────────────────────────────
    const missing = [];
    if (!orderId)   missing.push('razorpay_order_id');
    if (!paymentId) missing.push('razorpay_payment_id');
    if (!signature) missing.push('razorpay_signature');

    if (missing.length > 0) {
      console.warn('[razorpay-verify-payment] MISSING_FIELDS ' + JSON.stringify({ requestId, missing }));
      return res.status(400).json({
        success: false,
        error:   'Missing required fields.',
        missing,
        requestId
      });
    }

    // ── Read secret from env — never from request ─────────────────────────
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret || !keySecret.trim()) {
      console.error('[razorpay-verify-payment] MISSING_SECRET ' + JSON.stringify({ requestId }));
      return res.status(500).json({ success: false, error: 'Server configuration error. Contact support.', requestId });
    }

    // ── HMAC-SHA256 signature verification ────────────────────────────────
    // Razorpay spec: HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET)
    const body_str         = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret.trim())
      .update(body_str)
      .digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(signature,         'hex')
    );

    const elapsed = `${Date.now() - startTime}ms`;

    if (!isValid) {
      console.warn('[razorpay-verify-payment] SIGNATURE_MISMATCH ' + JSON.stringify({
        requestId, orderId, paymentId, elapsed
      }));
      return res.status(400).json({
        success:   false,
        status:    'FAILED',
        error:     'Payment signature verification failed. Do not mark as paid.',
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

    // timingSafeEqual throws if buffers are different lengths (tampered signature)
    if (err.message && err.message.includes('must be the same')) {
      return res.status(400).json({
        success: false,
        status:  'FAILED',
        error:   'Payment signature verification failed. Do not mark as paid.',
        requestId
      });
    }

    return res.status(500).json({ success: false, error: 'Internal server error.', requestId });
  }
});

module.exports = router;
