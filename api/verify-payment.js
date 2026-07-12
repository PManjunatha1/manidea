'use strict';

const express               = require('express');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ── Retry configuration ───────────────────────────────────────────────────────
// Strategy: 3 retries with fixed delays — 500ms, 1000ms, 2000ms (max ~3.5s total)
// On first SUCCESS, return immediately without waiting.
const RETRY_DELAYS_MS   = [500, 1000, 2000];
const MAX_ORDER_RETRIES = RETRY_DELAYS_MS.length + 1; // 4 total attempts (1 initial + 3 retries)
const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'VOID', 'FLAGGED']);
const PENDING_STATUSES  = new Set(['PENDING', 'UNKNOWN', 'ACTIVE']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── checkPaymentRecords ───────────────────────────────────────────────────────
// Called immediately when PGFetchOrder returns PENDING.
// Payment-level records update faster than order-level status.
async function checkPaymentRecords(cashfree, orderId, requestId) {
  try {
    const response = await cashfree.PGOrderFetchPayments(orderId);
    const payments = response?.data;

    console.info('[verify-payment] PAYMENT_RECORDS ' + JSON.stringify({
      requestId,
      orderId,
      paymentCount: Array.isArray(payments) ? payments.length : 0,
      payments
    }));

    if (!Array.isArray(payments) || payments.length === 0) return null;

    // Most recent payment first
    const latest = payments.reduce((a, b) =>
      new Date(b.payment_time || 0) > new Date(a.payment_time || 0) ? b : a
    );

    const paymentStatus = (latest.payment_status || '').toUpperCase();

    console.info('[verify-payment] LATEST_PAYMENT_RECORD ' + JSON.stringify({
      requestId,
      paymentStatus,
      paymentAmount:  latest.payment_amount,
      paymentTime:    latest.payment_time,
      paymentMessage: latest.payment_message
    }));

    return { paymentStatus, paymentRecord: latest };

  } catch (err) {
    console.warn('[verify-payment] PAYMENT_RECORDS_FETCH_FAILED ' + JSON.stringify({
      requestId,
      error: err.message
    }));
    return null;
  }
}

// ── fetchOrderStatus ──────────────────────────────────────────────────────────
// Attempt 1: call PGFetchOrder.
//   - Terminal status → return immediately.
//   - PENDING         → cross-check PGOrderFetchPayments immediately.
//     - Payment record SUCCESS → return SUCCESS immediately.
//     - Still PENDING          → retry up to 3 more times (500ms / 1000ms / 2000ms).
async function fetchOrderStatus(cashfree, orderId, requestId) {
  let lastOrder   = null;
  let attempts    = 0;

  for (let i = 0; i < MAX_ORDER_RETRIES; i++) {
    // Delay before every attempt except the first
    if (i > 0) {
      const delayMs = RETRY_DELAYS_MS[i - 1];
      console.info('[verify-payment] RETRY_DELAY ' + JSON.stringify({
        requestId,
        retryNumber: i,
        delayMs
      }));
      await sleep(delayMs);
    }

    attempts++;

    let response, order;
    try {
      response = await cashfree.PGFetchOrder(orderId);
      order    = response?.data;
    } catch (err) {
      // Re-throw so the route handler can return the exact Cashfree error
      throw err;
    }

    if (!order) {
      console.warn('[verify-payment] FETCH_EMPTY ' + JSON.stringify({
        requestId,
        orderId,
        attempt: attempts,
        maxAttempts: MAX_ORDER_RETRIES
      }));
      continue;
    }

    lastOrder = order;

    const paymentStatus = (order.payment_status || '').toUpperCase();
    const orderStatus   = (order.order_status   || '').toUpperCase();

    console.info('[verify-payment] FETCH_ATTEMPT ' + JSON.stringify({
      requestId,
      orderId,
      attempt: attempts,
      maxAttempts: MAX_ORDER_RETRIES,
      orderStatus,
      paymentStatus
    }));

    // Terminal status found — return immediately, no more waiting
    if (TERMINAL_STATUSES.has(paymentStatus) || TERMINAL_STATUSES.has(orderStatus)) {
      console.info('[verify-payment] TERMINAL_STATUS_FOUND ' + JSON.stringify({
        requestId,
        attempt: attempts,
        paymentStatus,
        orderStatus
      }));
      return { order, attempts, resolvedViaPaymentRecord: false };
    }

    // PENDING — cross-check payment records immediately before next retry
    if (PENDING_STATUSES.has(paymentStatus) || PENDING_STATUSES.has(orderStatus)) {
      console.info('[verify-payment] PENDING_CHECKING_PAYMENT_RECORDS ' + JSON.stringify({
        requestId,
        orderId,
        attempt: attempts,
        orderStatus,
        paymentStatus
      }));

      const paymentCheck = await checkPaymentRecords(cashfree, orderId, requestId);

      if (paymentCheck?.paymentStatus === 'SUCCESS') {
        console.info('[verify-payment] PAYMENT_RECORD_CONFIRMS_SUCCESS ' + JSON.stringify({
          requestId,
          orderId,
          attempt: attempts
        }));
        // Patch the order object so the caller gets consistent data
        order.payment_status = 'SUCCESS';
        order.order_status   = 'PAID';
        return { order, attempts, resolvedViaPaymentRecord: true };
      }

      if (paymentCheck && TERMINAL_STATUSES.has(paymentCheck.paymentStatus)) {
        console.info('[verify-payment] PAYMENT_RECORD_TERMINAL ' + JSON.stringify({
          requestId,
          orderId,
          attempt: attempts,
          paymentStatus: paymentCheck.paymentStatus
        }));
        order.payment_status = paymentCheck.paymentStatus;
        return { order, attempts, resolvedViaPaymentRecord: true };
      }
    }
  }

  return { order: lastOrder, attempts, resolvedViaPaymentRecord: false };
}

// ── Shared Cashfree error handler ─────────────────────────────────────────────
function handleCashfreeError(err, req, res, context) {
  const cfError      = err?.response?.data;
  const cfHttpStatus = err?.response?.status;
  const elapsed      = `${Date.now() - (req.startTime || Date.now())}ms`;

  console.error(`[${context}] EXCEPTION ` + JSON.stringify({
    requestId:      req.requestId,
    errorMessage:   err.message,
    errorStack:     err.stack,
    cashfreeStatus: cfHttpStatus,
    cashfreeError:  cfError,
    elapsed
  }));

  if (cfError?.code === 'ORDER_NOT_FOUND' || cfHttpStatus === 404) {
    return res.status(404).json({
      success:   false,
      status:    'FAILED',
      error:     'Order not found in payment gateway.',
      requestId: req.requestId
    });
  }

  if (cfError) {
    return res.status(502).json({
      success:       false,
      status:        'FAILED',
      error:         'Payment gateway error.',
      cashfreeError: {
        code:    cfError.code    || 'UNKNOWN',
        type:    cfError.type    || 'UNKNOWN',
        message: cfError.message || err.message
      },
      requestId: req.requestId
    });
  }

  if (err.message && err.message.includes('CASHFREE_')) {
    return res.status(500).json({
      success:   false,
      status:    'FAILED',
      error:     'Server configuration error. Contact support.',
      message:   err.message,
      requestId: req.requestId
    });
  }

  return null; // caller should call next(err)
}

// ── GET /api/verify-payment — usage info ─────────────────────────────────────
router.get('/verify-payment', (_req, res) => {
  res.status(200).json({
    success:        true,
    method:         'POST /api/verify-payment',
    requiredFields: ['orderId'],
    note:           'Both "orderId" and "order_id" are accepted.',
    retryPolicy:    `Up to ${MAX_ORDER_RETRIES} attempts. Delays: ${RETRY_DELAYS_MS.join('ms, ')}ms. Payment records checked immediately on PENDING.`
  });
});

// ── POST /api/verify-payment ──────────────────────────────────────────────────
router.post('/verify-payment', async (req, res, next) => {
  const { requestId } = req;
  const startTime     = req.startTime || Date.now();

  console.info('[verify-payment] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:   new Date().toISOString(),
    contentType: req.headers['content-type'],
    userAgent:   req.headers['user-agent'],
    bodyRaw:     req.body
  }));

  try {
    // ── Validate ──────────────────────────────────────────────────────────────
    const body       = req.body || {};
    const rawOrderId = body.orderId !== undefined ? body.orderId : body.order_id;
    const orderId    = (typeof rawOrderId === 'string'
      ? rawOrderId
      : String(rawOrderId == null ? '' : rawOrderId)
    ).trim();

    if (!orderId) {
      console.warn('[verify-payment] VALIDATION_FAILED ' + JSON.stringify({
        requestId,
        received:     rawOrderId,
        receivedType: typeof rawOrderId,
        bodyKeys:     Object.keys(body)
      }));
      return res.status(400).json({
        success:  false,
        error:    'orderId is required.',
        field:    'orderId',
        message:  'Send { "orderId": "ORD_..." } or { "order_id": "ORD_..." }.',
        requestId
      });
    }

    console.info('[verify-payment] STARTING_VERIFICATION ' + JSON.stringify({
      requestId,
      orderId,
      maxAttempts:  MAX_ORDER_RETRIES,
      retryDelays:  RETRY_DELAYS_MS.map(d => `${d}ms`)
    }));

    // ── Fetch with fast retry ─────────────────────────────────────────────────
    const cashfree = getCashfreeClient();
    const { order, attempts, resolvedViaPaymentRecord } =
      await fetchOrderStatus(cashfree, orderId, requestId);

    if (!order) {
      console.error('[verify-payment] ALL_RETRIES_EMPTY ' + JSON.stringify({
        requestId,
        orderId,
        attempts
      }));
      return res.status(502).json({
        success:   false,
        status:    'FAILED',
        error:     'Payment gateway returned no data after all retries.',
        requestId
      });
    }

    const paymentStatus = (order.payment_status || 'UNKNOWN').toUpperCase();
    const orderStatus   = (order.order_status   || 'UNKNOWN').toUpperCase();
    const elapsed       = `${Date.now() - startTime}ms`;

    console.info('[verify-payment] FINAL_RESULT ' + JSON.stringify({
      requestId,
      orderId,
      orderStatus,
      paymentStatus,
      attempts,
      resolvedViaPaymentRecord,
      elapsed
    }));

    // ── Return result ─────────────────────────────────────────────────────────
    return res.status(200).json({
      success:       paymentStatus === 'SUCCESS',
      status:        paymentStatus,
      paymentStatus,
      orderStatus,
      orderId:       order.order_id,
      elapsed,
      requestId
    });

  } catch (err) {
    const handled = handleCashfreeError(err, req, res, 'verify-payment');
    if (!handled) next(err);
  }
});

module.exports = router;
