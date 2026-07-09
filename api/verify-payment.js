'use strict';

const express               = require('express');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// RETRY CONFIGURATION
//
// Cashfree updates order/payment status asynchronously after the SDK returns.
// Android calls /verify-payment immediately — the first fetch often returns
// PENDING even when the payment actually succeeded.
//
// Strategy:
//   1. Fetch the order (PGFetchOrder).
//   2. If status is SUCCESS or FAILED/CANCELLED — return immediately.
//   3. If status is PENDING — wait RETRY_DELAY_MS, then fetch again.
//   4. After MAX_ORDER_RETRIES order fetches, cross-check with PGOrderFetchPayments.
//   5. If any payment record shows SUCCESS — return SUCCESS regardless of order status.
//   6. Only after all retries exhausted with no SUCCESS — return the final status.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_ORDER_RETRIES = 5;    // maximum PGFetchOrder attempts
const RETRY_DELAY_MS    = 2000; // wait 2 seconds between retries
const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'VOID', 'FLAGGED']);

// Promisified delay — does not block the event loop.
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchOrderWithRetry
//
// Calls PGFetchOrder up to MAX_ORDER_RETRIES times.
// Returns as soon as a terminal status is found.
// Returns the last fetched order data if all retries are exhausted.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOrderWithRetry(cashfree, orderId, requestId) {
  let lastOrder = null;

  for (let attempt = 1; attempt <= MAX_ORDER_RETRIES; attempt++) {
    const response = await cashfree.PGFetchOrder(orderId);
    const order    = response?.data;

    if (!order) {
      console.warn(`[verify-payment] FETCH_EMPTY attempt=${attempt}/${MAX_ORDER_RETRIES}`, { requestId, orderId });
      if (attempt < MAX_ORDER_RETRIES) await delay(RETRY_DELAY_MS);
      continue;
    }

    lastOrder = order;

    const paymentStatus = String(order.payment_status || '').toUpperCase();
    const orderStatus   = String(order.order_status   || '').toUpperCase();

    console.info(`[verify-payment] FETCH_ATTEMPT attempt=${attempt}/${MAX_ORDER_RETRIES} ` + JSON.stringify({
      requestId,
      orderId,
      orderStatus,
      paymentStatus
    }));

    // Terminal status reached — no need to retry
    if (TERMINAL_STATUSES.has(paymentStatus) || TERMINAL_STATUSES.has(orderStatus)) {
      console.info(`[verify-payment] TERMINAL_STATUS_FOUND attempt=${attempt}`, { requestId, paymentStatus, orderStatus });
      return { order: lastOrder, attempts: attempt, resolvedViaPayments: false };
    }

    // Still PENDING — wait before next attempt (skip wait on last attempt)
    if (attempt < MAX_ORDER_RETRIES) {
      console.info(`[verify-payment] STATUS_PENDING_RETRYING delay=${RETRY_DELAY_MS}ms attempt=${attempt}`, { requestId });
      await delay(RETRY_DELAY_MS);
    }
  }

  return { order: lastOrder, attempts: MAX_ORDER_RETRIES, resolvedViaPayments: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// checkPaymentRecords
//
// After all order retries are exhausted and status is still PENDING,
// fetch the individual payment records for the order.
// If any payment record has payment_status = SUCCESS, the payment succeeded
// even if the order-level status hasn't updated yet.
// ─────────────────────────────────────────────────────────────────────────────
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

    if (!Array.isArray(payments) || payments.length === 0) {
      return null;
    }

    // Find the most recent payment record
    const sorted = payments.slice().sort((a, b) => {
      return new Date(b.payment_time || 0) - new Date(a.payment_time || 0);
    });

    const latest        = sorted[0];
    const paymentStatus = String(latest.payment_status || '').toUpperCase();

    console.info('[verify-payment] LATEST_PAYMENT_RECORD ' + JSON.stringify({
      requestId,
      paymentStatus,
      paymentAmount:  latest.payment_amount,
      paymentTime:    latest.payment_time,
      paymentMessage: latest.payment_message
    }));

    return { paymentStatus, paymentRecord: latest };

  } catch (err) {
    // PGOrderFetchPayments failing should not block the response
    console.warn('[verify-payment] PAYMENT_RECORDS_FETCH_FAILED ' + JSON.stringify({
      requestId,
      error: err.message
    }));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/verify-payment  — usage info
// ─────────────────────────────────────────────────────────────────────────────
router.get('/verify-payment', (_req, res) => {
  res.status(200).json({
    success:        true,
    method:         'POST /api/verify-payment',
    requiredFields: ['orderId'],
    note:           'Both "orderId" and "order_id" are accepted.',
    retryPolicy:    `Up to ${MAX_ORDER_RETRIES} attempts with ${RETRY_DELAY_MS}ms delay between each.`
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/verify-payment
//
// Verifies payment status server-side. Never trusts client-sent status.
// Retries up to 5 times with 2s delay to handle Cashfree async updates.
// Cross-checks payment records if order status is still PENDING after retries.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify-payment', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = Date.now();

  // ── STEP 1: Log incoming request ──────────────────────────────────────────
  console.info('[verify-payment] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:   new Date().toISOString(),
    contentType: req.headers['content-type'],
    userAgent:   req.headers['user-agent'],
    bodyRaw:     req.body
  }));

  try {
    // ── STEP 2: Validate — accept both orderId and order_id ───────────────────
    const body       = req.body || {};
    const rawOrderId = body.orderId !== undefined ? body.orderId : body.order_id;
    const orderId    = typeof rawOrderId === 'string'
      ? rawOrderId.trim()
      : String(rawOrderId == null ? '' : rawOrderId).trim();

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

    // ── STEP 3: Fetch order with retry ────────────────────────────────────────
    console.info('[verify-payment] STARTING_VERIFICATION ' + JSON.stringify({
      requestId,
      orderId,
      maxRetries: MAX_ORDER_RETRIES,
      retryDelay: `${RETRY_DELAY_MS}ms`
    }));

    const cashfree = getCashfreeClient();
    const { order, attempts } = await fetchOrderWithRetry(cashfree, orderId, requestId);

    if (!order) {
      console.error('[verify-payment] ALL_RETRIES_EMPTY ' + JSON.stringify({ requestId, orderId, attempts }));
      return res.status(502).json({
        success:   false,
        status:    'FAILED',
        error:     'Payment gateway returned no data after all retries.',
        requestId
      });
    }

    let orderStatus   = String(order.order_status   || 'UNKNOWN').toUpperCase();
    let paymentStatus = String(order.payment_status || 'UNKNOWN').toUpperCase();

    // ── STEP 4: Cross-check payment records if still PENDING ──────────────────
    // PGFetchOrder order-level status can lag. Individual payment records
    // update faster. If any payment record shows SUCCESS, trust that.
    if (paymentStatus === 'PENDING' || paymentStatus === 'UNKNOWN' ||
        orderStatus   === 'ACTIVE'  || orderStatus   === 'PENDING') {

      console.info('[verify-payment] CHECKING_PAYMENT_RECORDS ' + JSON.stringify({
        requestId, orderId, orderStatus, paymentStatus, attempts
      }));

      const paymentCheck = await checkPaymentRecords(cashfree, orderId, requestId);

      if (paymentCheck && paymentCheck.paymentStatus === 'SUCCESS') {
        // Payment record confirms success — override the lagging order status
        paymentStatus = 'SUCCESS';
        orderStatus   = 'PAID';
        console.info('[verify-payment] PAYMENT_RECORD_CONFIRMS_SUCCESS ' + JSON.stringify({ requestId, orderId }));
      } else if (paymentCheck && TERMINAL_STATUSES.has(paymentCheck.paymentStatus)) {
        paymentStatus = paymentCheck.paymentStatus;
        console.info('[verify-payment] PAYMENT_RECORD_TERMINAL ' + JSON.stringify({
          requestId, orderId, paymentStatus
        }));
      }
    }

    const elapsed = `${Date.now() - startTime}ms`;

    console.info('[verify-payment] FINAL_RESULT ' + JSON.stringify({
      requestId,
      orderId,
      orderStatus,
      paymentStatus,
      attempts,
      elapsed
    }));

    // ── STEP 5: Return final confirmed result ─────────────────────────────────
    //
    // Response includes BOTH "status" and "paymentStatus" fields.
    // Android reads: result.optString("status", result.optString("paymentStatus", "FAILED"))
    // Both fields carry the same value so either key works on the Android side.
    //
    // Status meanings:
    //   SUCCESS      → payment confirmed, open PaymentSuccessActivity
    //   FAILED       → payment failed, open PaymentFailedActivity
    //   CANCELLED    → user cancelled, open PaymentFailedActivity
    //   USER_DROPPED → user closed checkout, open PaymentFailedActivity
    //   PENDING      → Cashfree still processing, show "Verifying..." and retry
    //   UNKNOWN      → could not determine, treat as PENDING on Android side
    return res.status(200).json({
      success:       paymentStatus === 'SUCCESS',
      status:        paymentStatus,   // Android: result.optString("status", "FAILED")
      paymentStatus,                  // Android: result.optString("paymentStatus", "FAILED")
      orderStatus,
      orderId:       order.order_id,
      orderAmount:   order.order_amount,
      orderCurrency: order.order_currency,
      attempts,
      elapsed,
      requestId
    });

  } catch (err) {
    const cfError      = err?.response?.data;
    const cfHttpStatus = err?.response?.status;

    console.error('[verify-payment] EXCEPTION ' + JSON.stringify({
      requestId,
      errorMessage:   err.message,
      errorStack:     err.stack,
      cashfreeStatus: cfHttpStatus,
      cashfreeError:  cfError,
      receivedBody:   req.body,
      elapsed:        `${Date.now() - startTime}ms`
    }));

    // Order does not exist in Cashfree
    if (cfError?.code === 'ORDER_NOT_FOUND' || cfHttpStatus === 404) {
      return res.status(404).json({
        success:   false,
        status:    'FAILED',
        error:     'Order not found in payment gateway.',
        requestId
      });
    }

    // Cashfree returned a structured error
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
        requestId
      });
    }

    // Missing environment variables
    if (err.message && err.message.includes('CASHFREE_')) {
      return res.status(500).json({
        success: false,
        status:  'FAILED',
        error:   'Server configuration error. Contact support.',
        message: err.message,
        requestId
      });
    }

    next(err);
  }
});

module.exports = router;
