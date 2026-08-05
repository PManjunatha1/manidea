'use strict';

const express = require('express');
const crypto  = require('crypto');
const { getRazorpayClient } = require('./razorpay-client');

const router = express.Router();

const VERIFY_TIMEOUT_MS = 30_000;

// Razorpay payment.status → our canonical status
function mapRazorpayStatus(rzpStatus, errorDescription) {
  switch (rzpStatus) {
    case 'captured':  return 'SUCCESS';
    case 'failed': {
      // Razorpay marks user-cancelled UPI flows as failed with a specific description
      const desc = String(errorDescription || '').toLowerCase();
      if (desc.includes('cancel') || desc.includes('declined by user')) return 'CANCELLED';
      return 'FAILED';
    }
    case 'created':   return 'PENDING';   // order exists, payment not started
    case 'attempted': return 'PENDING';   // payment attempted but not settled
    case 'expired':   return 'EXPIRED';
    default:          return 'FAILED';
  }
}

// Wraps a promise with a hard timeout; resolves { timedOut: true } on expiry
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); resolve({ fetchError: e }); });
  });
}

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
    note:           'Two-layer verification: HMAC-SHA256 signature + server-side payment status fetch from Razorpay.',
    statuses:       ['SUCCESS', 'FAILED', 'CANCELLED', 'PENDING', 'EXPIRED', 'TIMEOUT', 'ERROR']
  });
});

// ── POST /api/razorpay/verify-payment ─────────────────────────────────────────
//
// LAYER 1 — HMAC-SHA256 signature verification (only for SUCCESS path)
// LAYER 2 — Server-side payment fetch from Razorpay API
//   Returns canonical status: SUCCESS | FAILED | CANCELLED | PENDING | EXPIRED | TIMEOUT | ERROR
//   Timeout: 30 s hard cap — returns TIMEOUT so Android can retry.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/razorpay/verify-payment', async (req, res) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = req.startTime || Date.now();

  setCors(res);

  console.info('[razorpay-verify-payment] VERIFICATION_STARTED ' + JSON.stringify({
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
        success:   false,
        status:    'ERROR',
        message:   'Missing required fields.',
        orderId:   orderId   || null,
        paymentId: paymentId || null,
        verified:  false,
        missing,
        requestId
      });
    }

    // ── Read secret from env — never from request ─────────────────────────
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret || !keySecret.trim()) {
      console.error('[razorpay-verify-payment] MISSING_SECRET ' + JSON.stringify({ requestId }));
      return res.status(500).json({
        success:   false,
        status:    'ERROR',
        message:   'Server configuration error. Contact support.',
        orderId,
        paymentId,
        verified:  false,
        requestId
      });
    }

    // ── LAYER 2: Fetch payment from Razorpay with hard timeout ───────────
    const razorpay = getRazorpayClient();

    const fetchResult = await withTimeout(
      razorpay.payments.fetch(paymentId),
      VERIFY_TIMEOUT_MS
    );

    // ── Timeout branch ────────────────────────────────────────────────────
    if (fetchResult.timedOut) {
      console.warn('[razorpay-verify-payment] TIMEOUT ' + JSON.stringify({
        requestId, orderId, paymentId, elapsed: `${Date.now() - startTime}ms`
      }));
      return res.status(504).json({
        success:   false,
        status:    'TIMEOUT',
        message:   'Verification timed out after 30 seconds. Please retry.',
        orderId,
        paymentId,
        verified:  false,
        requestId
      });
    }

    // ── Fetch error branch ────────────────────────────────────────────────
    if (fetchResult.fetchError) {
      const fetchErr      = fetchResult.fetchError;
      const rzpError      = fetchErr?.error;
      const rzpHttpStatus = fetchErr?.statusCode;

      console.error('[razorpay-verify-payment] PAYMENT_FETCH_ERROR ' + JSON.stringify({
        requestId, paymentId, rzpHttpStatus, rzpError,
        errorMessage: fetchErr.message, elapsed: `${Date.now() - startTime}ms`
      }));

      if (rzpHttpStatus === 404) {
        console.warn('[razorpay-verify-payment] FAILED ' + JSON.stringify({ requestId, orderId, paymentId, reason: 'not_found' }));
        return res.status(400).json({
          success:   false,
          status:    'FAILED',
          message:   'Payment not found in Razorpay.',
          orderId,
          paymentId,
          verified:  false,
          requestId
        });
      }

      return res.status(502).json({
        success:   false,
        status:    'ERROR',
        message:   'Could not reach Razorpay. Please retry.',
        orderId,
        paymentId,
        verified:  false,
        requestId
      });
    }

    const payment        = fetchResult;
    const rzpStatus      = String(payment?.status || '').toLowerCase();
    const fetchedOrderId = String(payment?.order_id || '').trim();
    const errorDesc      = payment?.error_description || payment?.error?.description || '';
    const canonicalStatus = mapRazorpayStatus(rzpStatus, errorDesc);

    console.info('[razorpay-verify-payment] VERIFICATION_RESPONSE ' + JSON.stringify({
      requestId, paymentId, rzpStatus, canonicalStatus,
      fetchedOrderId, expectedOrderId: orderId,
      elapsed: `${Date.now() - startTime}ms`
    }));

    // ── Guard: payment must belong to the claimed order ───────────────────
    if (fetchedOrderId !== orderId) {
      console.warn('[razorpay-verify-payment] ORDER_ID_MISMATCH ' + JSON.stringify({
        requestId, paymentId, fetchedOrderId, claimedOrderId: orderId
      }));
      return res.status(400).json({
        success:   false,
        status:    'FAILED',
        message:   'Payment does not belong to the claimed order.',
        orderId,
        paymentId,
        verified:  false,
        requestId
      });
    }

    // ── Non-success fast-return (FAILED / CANCELLED / PENDING / EXPIRED) ──
    // Return immediately — do NOT run HMAC check for non-captured payments.
    // Android must stop polling and show the correct terminal screen.
    if (canonicalStatus !== 'SUCCESS') {
      const logLabel = canonicalStatus === 'CANCELLED' ? 'CANCELLED'
                     : canonicalStatus === 'PENDING'   ? 'PENDING'
                     : canonicalStatus === 'EXPIRED'   ? 'EXPIRED'
                     : 'FAILED';

      console.warn(`[razorpay-verify-payment] ${logLabel} ` + JSON.stringify({
        requestId, orderId, paymentId, rzpStatus, canonicalStatus,
        elapsed: `${Date.now() - startTime}ms`
      }));

      return res.status(200).json({
        success:   false,
        status:    canonicalStatus,
        message:   `Payment ${canonicalStatus.toLowerCase()}.`,
        orderId,
        paymentId,
        verified:  false,
        requestId
      });
    }

    // ── LAYER 1: HMAC-SHA256 — only reached for captured payments ─────────
    const message           = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret.trim())
      .update(message)
      .digest('hex');

    let sigBuffer, expectedBuffer;
    try {
      sigBuffer      = Buffer.from(signature,         'hex');
      expectedBuffer = Buffer.from(expectedSignature, 'hex');
    } catch (_) {
      console.warn('[razorpay-verify-payment] SIGNATURE_INVALID_HEX ' + JSON.stringify({ requestId, orderId, paymentId }));
      return res.status(400).json({
        success:   false,
        status:    'FAILED',
        message:   'Signature is not valid hex.',
        orderId,
        paymentId,
        verified:  false,
        requestId
      });
    }

    if (sigBuffer.length !== expectedBuffer.length || sigBuffer.length === 0) {
      console.warn('[razorpay-verify-payment] SIGNATURE_LENGTH_MISMATCH ' + JSON.stringify({ requestId, orderId, paymentId }));
      return res.status(400).json({
        success:   false,
        status:    'FAILED',
        message:   'Signature length mismatch.',
        orderId,
        paymentId,
        verified:  false,
        requestId
      });
    }

    const hmacValid = crypto.timingSafeEqual(expectedBuffer, sigBuffer);
    if (!hmacValid) {
      console.warn('[razorpay-verify-payment] SIGNATURE_MISMATCH ' + JSON.stringify({
        requestId, orderId, paymentId, elapsed: `${Date.now() - startTime}ms`
      }));
      return res.status(400).json({
        success:   false,
        status:    'FAILED',
        message:   'Signature mismatch. Do not activate subscription.',
        orderId,
        paymentId,
        verified:  false,
        requestId
      });
    }

    // ── Both layers passed — payment is genuine and captured ──────────────
    const elapsed = `${Date.now() - startTime}ms`;
    console.info('[razorpay-verify-payment] SUCCESS ' + JSON.stringify({
      requestId, orderId, paymentId, rzpStatus, elapsed
    }));

    return res.status(200).json({
      success:       true,
      status:        'SUCCESS',
      message:       'Payment verified successfully.',
      orderId,
      paymentId,
      verified:      true,
      amount:        payment.amount,
      currency:      payment.currency,
      method:        payment.method,
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
      success:   false,
      status:    'ERROR',
      message:   'Internal server error.',
      orderId:   req.body?.razorpay_order_id   || null,
      paymentId: req.body?.razorpay_payment_id || null,
      verified:  false,
      requestId
    });
  }
});

module.exports = router;
