'use strict';

const express               = require('express');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ── Retry configuration ───────────────────────────────────────────────────────
// Cashfree updates order/payment status asynchronously after the SDK returns.
// Strategy: exponential backoff — 1s, 2s, 4s, 8s, 8s (capped at MAX_BACKOFF_MS)
const MAX_ORDER_RETRIES = 5;
const BASE_DELAY_MS     = 1000;
const MAX_BACKOFF_MS    = 8000;
const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'VOID', 'FLAGGED']);
const PENDING_STATUSES  = new Set(['PENDING', 'UNKNOWN', 'ACTIVE']);

function backoffDelay(attempt) {
  // attempt is 1-based; delay = BASE * 2^(attempt-1), capped at MAX_BACKOFF_MS
  return new Promise(resolve =>
    setTimeout(resolve, Math.min(BASE_DELAY_MS * (1 << (attempt - 1)), MAX_BACKOFF_MS))
  );
}

// ── fetchOrderWithRetry ───────────────────────────────────────────────────────
// Retries PGFetchOrder with exponential backoff until a terminal status is found
// or MAX_ORDER_RETRIES is exhausted.
async function fetchOrderWithRetry(cashfree, orderId, requestId) {
  let lastOrder = null;

  for (let attempt = 1; attempt <= MAX_ORDER_RETRIES; attempt++) {
    const response = await cashfree.PGFetchOrder(orderId);
    const order    = response?.data;

    if (!order) {
      console.warn(`[verify-payment] FETCH_EMPTY attempt=${attempt}/${MAX_ORDER_RETRIES} ` + JSON.stringify({ requestId, orderId }));
      if (attempt < MAX_ORDER_RETRIES) await backoffDelay(attempt);
      continue;
    }

    lastOrder = order;

    const paymentStatus = (order.payment_status || '').toUpperCase();
    const orderStatus   = (order.order_status   || '').toUpperCase();

    console.info(`[verify-payment] FETCH_ATTEMPT attempt=${attempt}/${MAX_ORDER_RETRIES} ` + JSON.stringify({ requestId, orderId, orderStatus, paymentStatus }));

    if (TERMINAL_STATUSES.has(paymentStatus) || TERMINAL_STATUSES.has(orderStatus)) {
      console.info(`[verify-payment] TERMINAL_STATUS_FOUND attempt=${attempt} ` + JSON.stringify({ requestId, paymentStatus, orderStatus }));
      return { order, attempts: attempt };
    }

    if (attempt < MAX_ORDER_RETRIES) {
      const delayMs = Math.min(BASE_DELAY_MS * (1 << (attempt - 1)), MAX_BACKOFF_MS);
      console.info(`[verify-payment] STATUS_PENDING_RETRYING delay=${delayMs}ms attempt=${attempt} ` + JSON.stringify({ requestId }));
      await backoffDelay(attempt);
    }
  }

  return { order: lastOrder, attempts: MAX_ORDER_RETRIES };
}

// ── checkPaymentRecords ───────────────────────────────────────────────────────
// Cross-checks individual payment records when order status is still PENDING.
// Payment records update faster than order-level status.
async function checkPaymentRecords(cashfree, orderId, requestId) {
  try {
    const response = await cashfree.PGOrderFetchPayments(orderId);
    const payments = response?.data;

    console.info('[verify-payment] PAYMENT_RECORDS ' + JSON.stringify({
      requestId, orderId,
      paymentCount: Array.isArray(payments) ? payments.length : 0,
      payments
    }));

    if (!Array.isArray(payments) || payments.length === 0) return null;

    // Most recent payment record first
    const latest = payments.reduce((a, b) =>
      new Date(b.payment_time || 0) > new Date(a.payment_time || 0) ? b : a
    );

    const paymentStatus = (latest.payment_status || '').toUpperCase();

    console.info('[verify-payment] LATEST_PAYMENT_RECORD ' + JSON.stringify({
      requestId, paymentStatus,
      paymentAmount:  latest.payment_amount,
      paymentTime:    latest.payment_time,
      paymentMessage: latest.payment_message
    }));

    return { paymentStatus, paymentRecord: latest };

  } catch (err) {
    console.warn('[verify-payment] PAYMENT_RECORDS_FETCH_FAILED ' + JSON.stringify({ requestId, error: err.message }));
    return null;
  }
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
    return res.status(404).json({ success: false, status: 'FAILED', error: 'Order not found in payment gateway.', requestId: req.requestId });
  }

  if (cfError) {
    return res.status(502).json({
      success:       false,
      status:        'FAILED',
      error:         'Payment gateway error.',
      cashfreeError: { code: cfError.code || 'UNKNOWN', type: cfError.type || 'UNKNOWN', message: cfError.message || err.message },
      requestId:     req.requestId
    });
  }

  if (err.message && err.message.includes('CASHFREE_')) {
    return res.status(500).json({ success: false, status: 'FAILED', error: 'Server configuration error. Contact support.', message: err.message, requestId: req.requestId });
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
    retryPolicy:    `Up to ${MAX_ORDER_RETRIES} attempts with exponential backoff (${BASE_DELAY_MS}ms base, ${MAX_BACKOFF_MS}ms cap).`
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
    const orderId    = (typeof rawOrderId === 'string' ? rawOrderId : String(rawOrderId == null ? '' : rawOrderId)).trim();

    if (!orderId) {
      console.warn('[verify-payment] VALIDATION_FAILED ' + JSON.stringify({ requestId, received: rawOrderId, receivedType: typeof rawOrderId, bodyKeys: Object.keys(body) }));
      return res.status(400).json({
        success:  false,
        error:    'orderId is required.',
        field:    'orderId',
        message:  'Send { "orderId": "ORD_..." } or { "order_id": "ORD_..." }.',
        requestId
      });
    }

    // ── Fetch with exponential backoff retry ──────────────────────────────────
    console.info('[verify-payment] STARTING_VERIFICATION ' + JSON.stringify({
      requestId, orderId,
      maxRetries:  MAX_ORDER_RETRIES,
      backoffBase: `${BASE_DELAY_MS}ms`,
      backoffCap:  `${MAX_BACKOFF_MS}ms`
    }));

    const cashfree          = getCashfreeClient();
    const { order, attempts } = await fetchOrderWithRetry(cashfree, orderId, requestId);

    if (!order) {
      console.error('[verify-payment] ALL_RETRIES_EMPTY ' + JSON.stringify({ requestId, orderId, attempts }));
      return res.status(502).json({ success: false, status: 'FAILED', error: 'Payment gateway returned no data after all retries.', requestId });
    }

    let orderStatus   = (order.order_status   || 'UNKNOWN').toUpperCase();
    let paymentStatus = (order.payment_status || 'UNKNOWN').toUpperCase();

    // ── Cross-check payment records if still PENDING ──────────────────────────
    if (PENDING_STATUSES.has(paymentStatus) || PENDING_STATUSES.has(orderStatus)) {
      console.info('[verify-payment] CHECKING_PAYMENT_RECORDS ' + JSON.stringify({ requestId, orderId, orderStatus, paymentStatus, attempts }));

      const paymentCheck = await checkPaymentRecords(cashfree, orderId, requestId);

      if (paymentCheck?.paymentStatus === 'SUCCESS') {
        paymentStatus = 'SUCCESS';
        orderStatus   = 'PAID';
        console.info('[verify-payment] PAYMENT_RECORD_CONFIRMS_SUCCESS ' + JSON.stringify({ requestId, orderId }));
      } else if (paymentCheck && TERMINAL_STATUSES.has(paymentCheck.paymentStatus)) {
        paymentStatus = paymentCheck.paymentStatus;
        console.info('[verify-payment] PAYMENT_RECORD_TERMINAL ' + JSON.stringify({ requestId, orderId, paymentStatus }));
      }
    }

    const elapsed = `${Date.now() - startTime}ms`;

    console.info('[verify-payment] FINAL_RESULT ' + JSON.stringify({ requestId, orderId, orderStatus, paymentStatus, attempts, elapsed }));

    // ── Return final confirmed result ─────────────────────────────────────────
    // Both "status" and "paymentStatus" carry the same value.
    // Android: result.optString("status", result.optString("paymentStatus", "FAILED"))
    return res.status(200).json({
      success:       paymentStatus === 'SUCCESS',
      status:        paymentStatus,
      paymentStatus,
      orderStatus,
      orderId:       order.order_id,
      orderAmount:   order.order_amount,
      orderCurrency: order.order_currency,
      attempts,
      elapsed,
      requestId
    });

  } catch (err) {
    const handled = handleCashfreeError(err, req, res, 'verify-payment');
    if (!handled) next(err);
  }
});

module.exports = router;
