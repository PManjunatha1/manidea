'use strict';

const express = require('express');
const crypto  = require('crypto');
const { getRazorpayClient } = require('./razorpay-client');

const router = express.Router();

// ── CORS headers for mobile access ───────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

router.options('/razorpay/verify-payment', (req, res) => {
  setCors(res);
  res.sendStatus(204);
});

router.get('/razorpay/verify-payment', (_req, res) => {
  setCors(res);
  res.status(200).json({
    success:        true,
    method:         'POST /api/razorpay/verify-payment',
    requiredFields: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
    note:           'Two-layer verification: HMAC-SHA256 signature + server-side payment status fetch from Razorpay.'
  });
});

// ── POST /api/razorpay/verify-payment ─────────────────────────────────────────
//
// LAYER 1 — HMAC-SHA256 signature verification
//   Proves the payment callback was genuinely issued by Razorpay and was not
//   tampered with in transit. A forged or replayed callback fails here.
//
// LAYER 2 — Server-side payment fetch from Razorpay API
//   Even if HMAC passes, we independently fetch the payment from Razorpay
//   servers and confirm status === 'captured'. This prevents a scenario where
//   an attacker constructs a valid HMAC for a payment that was never captured
//   (e.g. authorised but not settled, or a test-mode payment replayed in live).
//
// Only when BOTH layers pass do we return success: true.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/razorpay/verify-payment', async (req, res) => {
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

    // ── Validate required fields ──────────────────────────────────────────
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

    // ── LAYER 1: HMAC-SHA256 signature verification ───────────────────────
    const message           = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret.trim())
      .update(message)
      .digest('hex');

    // Convert both to Buffer for timingSafeEqual (prevents timing attacks)
    let sigBuffer, expectedBuffer;
    try {
      sigBuffer      = Buffer.from(signature,         'hex');
      expectedBuffer = Buffer.from(expectedSignature, 'hex');
    } catch (_) {
      // Non-hex signature — definitely invalid
      console.warn('[razorpay-verify-payment] SIGNATURE_INVALID_HEX ' + JSON.stringify({ requestId, orderId, paymentId }));
      return res.status(400).json({
        success: false,
        status:  'FAILED',
        error:   'Payment verification failed. Signature is not valid hex.',
        requestId
      });
    }

    if (sigBuffer.length !== expectedBuffer.length || sigBuffer.length === 0) {
      console.warn('[razorpay-verify-payment] SIGNATURE_LENGTH_MISMATCH ' + JSON.stringify({ requestId, orderId, paymentId }));
      return res.status(400).json({
        success: false,
        status:  'FAILED',
        error:   'Payment verification failed. Do not mark as paid.',
        requestId
      });
    }

    const hmacValid = crypto.timingSafeEqual(expectedBuffer, sigBuffer);

    if (!hmacValid) {
      console.warn('[razorpay-verify-payment] SIGNATURE_MISMATCH ' + JSON.stringify({
        requestId, orderId, paymentId, elapsed: `${Date.now() - startTime}ms`
      }));
      return res.status(400).json({
        success: false,
        status:  'FAILED',
        error:   'Payment verification failed. Signature mismatch. Do not mark as paid.',
        requestId
      });
    }

    console.info('[razorpay-verify-payment] LAYER1_HMAC_PASSED ' + JSON.stringify({ requestId, orderId, paymentId }));

    // ── LAYER 2: Fetch payment from Razorpay servers ──────────────────────
    // We independently confirm the payment status is 'captured'.
    // 'authorised' means money is held but NOT yet settled — treat as failed.
    // 'created', 'failed', 'refunded' are all non-success states.
    const razorpay = getRazorpayClient();
    let payment;

    try {
      payment = await razorpay.payments.fetch(paymentId);
    } catch (fetchErr) {
      const rzpError      = fetchErr?.error;
      const rzpHttpStatus = fetchErr?.statusCode;

      console.error('[razorpay-verify-payment] PAYMENT_FETCH_ERROR ' + JSON.stringify({
        requestId,
        paymentId,
        rzpHttpStatus,
        rzpError,
        errorMessage: fetchErr.message,
        elapsed:      `${Date.now() - startTime}ms`
      }));

      // Payment ID not found in Razorpay — definitely not paid
      if (rzpHttpStatus === 404) {
        return res.status(400).json({
          success: false,
          status:  'FAILED',
          error:   'Payment not found in Razorpay. Do not mark as paid.',
          requestId
        });
      }

      return res.status(502).json({
        success: false,
        status:  'FAILED',
        error:   'Could not verify payment with Razorpay. Please retry.',
        requestId
      });
    }

    const paymentStatus = String(payment?.status || '').toLowerCase();
    const fetchedOrderId = String(payment?.order_id || '').trim();

    console.info('[razorpay-verify-payment] LAYER2_PAYMENT_FETCHED ' + JSON.stringify({
      requestId,
      paymentId,
      paymentStatus,
      fetchedOrderId,
      expectedOrderId: orderId,
      elapsed: `${Date.now() - startTime}ms`
    }));

    // ── Guard: payment must belong to the claimed order ───────────────────
    // Prevents an attacker from reusing a captured payment_id from a
    // different order to unlock a different order.
    if (fetchedOrderId !== orderId) {
      console.warn('[razorpay-verify-payment] ORDER_ID_MISMATCH ' + JSON.stringify({
        requestId, paymentId, fetchedOrderId, claimedOrderId: orderId
      }));
      return res.status(400).json({
        success: false,
        status:  'FAILED',
        error:   'Payment does not belong to the claimed order. Do not mark as paid.',
        requestId
      });
    }

    // ── Guard: payment status must be 'captured' ──────────────────────────
    if (paymentStatus !== 'captured') {
      console.warn('[razorpay-verify-payment] PAYMENT_NOT_CAPTURED ' + JSON.stringify({
        requestId, orderId, paymentId, paymentStatus, elapsed: `${Date.now() - startTime}ms`
      }));
      return res.status(400).json({
        success:       false,
        status:        'FAILED',
        paymentStatus,
        error:         `Payment is not captured. Current status: "${paymentStatus}". Do not mark as paid.`,
        requestId
      });
    }

    // ── Both layers passed — payment is genuine and captured ──────────────
    const elapsed = `${Date.now() - startTime}ms`;
    console.info('[razorpay-verify-payment] PAYMENT_VERIFIED_SUCCESS ' + JSON.stringify({
      requestId, orderId, paymentId, paymentStatus, elapsed
    }));

    return res.status(200).json({
      success:       true,
      status:        'SUCCESS',
      orderId,
      paymentId,
      paymentStatus,
      amount:        payment.amount,
      currency:      payment.currency,
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
