'use strict';

const express               = require('express');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ── Retry configuration ───────────────────────────────────────────────────────
// Attempt 1 : PGFetchOrder + PGOrderFetchPayments fired IN PARALLEL (fastest path).
// Attempts 2-4: PGFetchOrder only, with increasing delays (500ms / 1000ms / 2000ms).
// Returns as soon as any terminal status is confirmed.
const RETRY_DELAYS_MS        = [500, 1000, 2000];
const MAX_ORDER_RETRIES      = RETRY_DELAYS_MS.length + 1; // 4 total
const TERMINAL_STATUSES      = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'VOID', 'FLAGGED']);
const PENDING_STATUSES       = new Set(['PENDING', 'UNKNOWN', 'ACTIVE']);
const PAYMENT_RECORD_TIMEOUT = 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timeoutNull(ms) {
  return new Promise(resolve => setTimeout(() => resolve(null), ms));
}

function since(t) {
  const ms = Date.now() - t;
  return { ms, label: `${ms}ms` };
}

// ── checkPaymentRecords ───────────────────────────────────────────────────────
async function checkPaymentRecords(cashfree, orderId, requestId, t0) {
  const callStart = Date.now();
  try {
    const response = await cashfree.PGOrderFetchPayments(orderId);
    const payments = response?.data;

    console.info('[verify-payment] STEP_PAYMENT_RECORDS ' + JSON.stringify({
      requestId, orderId,
      paymentCount:   Array.isArray(payments) ? payments.length : 0,
      stepMs:         since(callStart).ms,
      totalElapsedMs: since(t0).ms
    }));

    if (!Array.isArray(payments) || payments.length === 0) return null;

    const latest = payments.reduce((a, b) =>
      new Date(b.payment_time || 0) > new Date(a.payment_time || 0) ? b : a
    );

    const paymentStatus = (latest.payment_status || '').toUpperCase();

    console.info('[verify-payment] PAYMENT_RECORD_DETAIL ' + JSON.stringify({
      requestId, paymentStatus,
      paymentAmount:  latest.payment_amount,
      paymentTime:    latest.payment_time,
      paymentMessage: latest.payment_message
    }));

    return { paymentStatus, paymentRecord: latest };

  } catch (err) {
    console.warn('[verify-payment] PAYMENT_RECORDS_FAILED ' + JSON.stringify({
      requestId, error: err.message,
      stepMs: since(callStart).ms, totalElapsedMs: since(t0).ms
    }));
    return null;
  }
}

// ── fetchOrderStatus ──────────────────────────────────────────────────────────
async function fetchOrderStatus(cashfree, orderId, requestId, t0) {
  let lastOrder = null;
  let attempts  = 0;

  for (let i = 0; i < MAX_ORDER_RETRIES; i++) {
    if (i > 0) {
      const delayMs = RETRY_DELAYS_MS[i - 1];
      console.info('[verify-payment] RETRY_DELAY ' + JSON.stringify({
        requestId, retryNumber: i, delayMs, totalElapsedMs: since(t0).ms
      }));
      await sleep(delayMs);
    }

    attempts++;
    const fetchStart = Date.now();

    let order, paymentCheckResult;

    if (i === 0) {
      // Attempt 1: fire both calls in parallel
      const [orderResponse, paymentCheck] = await Promise.all([
        cashfree.PGFetchOrder(orderId),
        Promise.race([
          checkPaymentRecords(cashfree, orderId, requestId, t0),
          timeoutNull(PAYMENT_RECORD_TIMEOUT)
        ])
      ]);
      order              = orderResponse?.data;
      paymentCheckResult = paymentCheck;
    } else {
      const orderResponse = await cashfree.PGFetchOrder(orderId);
      order               = orderResponse?.data;
      paymentCheckResult  = null;
    }

    const fetchElapsed = since(fetchStart);

    if (!order) {
      console.warn('[verify-payment] FETCH_EMPTY ' + JSON.stringify({
        requestId, orderId, attempt: attempts,
        stepMs: fetchElapsed.ms, totalElapsedMs: since(t0).ms
      }));
      continue;
    }

    lastOrder = order;

    const paymentStatus = (order.payment_status || '').toUpperCase();
    const orderStatus   = (order.order_status   || '').toUpperCase();

    console.info('[verify-payment] STEP_FETCH_ORDER ' + JSON.stringify({
      requestId, orderId, attempt: attempts, maxAttempts: MAX_ORDER_RETRIES,
      orderStatus, paymentStatus,
      stepMs: fetchElapsed.ms, totalElapsedMs: since(t0).ms
    }));

    // Terminal on order — return immediately
    if (TERMINAL_STATUSES.has(paymentStatus) || TERMINAL_STATUSES.has(orderStatus)) {
      console.info('[verify-payment] TERMINAL_FOUND_VIA_ORDER ' + JSON.stringify({
        requestId, attempt: attempts, paymentStatus, orderStatus,
        totalElapsedMs: since(t0).ms
      }));
      return { order, attempts, resolvedViaPaymentRecord: false };
    }

    // PENDING — check payment records
    if (PENDING_STATUSES.has(paymentStatus) || PENDING_STATUSES.has(orderStatus)) {
      console.info('[verify-payment] ORDER_PENDING_CHECKING_RECORDS ' + JSON.stringify({
        requestId, orderId, attempt: attempts, orderStatus, paymentStatus,
        totalElapsedMs: since(t0).ms
      }));

      if (i > 0) {
        paymentCheckResult = await Promise.race([
          checkPaymentRecords(cashfree, orderId, requestId, t0),
          timeoutNull(PAYMENT_RECORD_TIMEOUT)
        ]);
      }

      if (paymentCheckResult === null) {
        console.warn('[verify-payment] PAYMENT_RECORD_TIMEOUT ' + JSON.stringify({
          requestId, orderId, attempt: attempts, totalElapsedMs: since(t0).ms
        }));
      }

      if (paymentCheckResult?.paymentStatus === 'SUCCESS') {
        console.info('[verify-payment] TERMINAL_FOUND_VIA_PAYMENT_RECORD ' + JSON.stringify({
          requestId, orderId, attempt: attempts, totalElapsedMs: since(t0).ms
        }));
        order.payment_status = 'SUCCESS';
        order.order_status   = 'PAID';
        return { order, attempts, resolvedViaPaymentRecord: true };
      }

      if (paymentCheckResult && TERMINAL_STATUSES.has(paymentCheckResult.paymentStatus)) {
        console.info('[verify-payment] TERMINAL_FOUND_VIA_PAYMENT_RECORD ' + JSON.stringify({
          requestId, orderId, attempt: attempts,
          paymentStatus: paymentCheckResult.paymentStatus,
          totalElapsedMs: since(t0).ms
        }));
        order.payment_status = paymentCheckResult.paymentStatus;
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

  console.error(`[${context}] EXCEPTION ` + JSON.stringify({
    requestId:      req.requestId,
    errorMessage:   err.message,
    cashfreeStatus: cfHttpStatus,
    cashfreeError:  cfError,
    totalElapsedMs: since(req.startTime || Date.now()).ms
  }));

  if (cfError?.code === 'ORDER_NOT_FOUND' || cfHttpStatus === 404) {
    return res.status(404).json({ success: false, status: 'FAILED', error: 'Order not found in payment gateway.', requestId: req.requestId });
  }
  if (cfError) {
    return res.status(502).json({
      success: false, status: 'FAILED', error: 'Payment gateway error.',
      cashfreeError: { code: cfError.code || 'UNKNOWN', type: cfError.type || 'UNKNOWN', message: cfError.message || err.message },
      requestId: req.requestId
    });
  }
  if (err.message && err.message.includes('CASHFREE_')) {
    return res.status(500).json({ success: false, status: 'FAILED', error: 'Server configuration error. Contact support.', message: err.message, requestId: req.requestId });
  }
  return null;
}

// ── GET /api/verify-payment — usage info ─────────────────────────────────────
router.get('/verify-payment', (_req, res) => {
  res.status(200).json({
    success:        true,
    method:         'POST /api/verify-payment',
    requiredFields: ['orderId'],
    note:           'Both "orderId" and "order_id" are accepted.',
    retryPolicy:    `Up to ${MAX_ORDER_RETRIES} attempts. Attempt 1 fires PGFetchOrder + PGOrderFetchPayments in parallel. Delays: ${RETRY_DELAYS_MS.join('ms, ')}ms.`
  });
});

// ── POST /api/verify-payment ──────────────────────────────────────────────────
router.post('/verify-payment', async (req, res, next) => {
  const { requestId } = req;
  const t0            = req.startTime || Date.now();

  console.info('[verify-payment] T0_REQUEST_RECEIVED ' + JSON.stringify({
    requestId,
    timestamp:   new Date().toISOString(),
    contentType: req.headers['content-type'],
    userAgent:   req.headers['user-agent'],
    bodyRaw:     req.body
  }));

  try {
    const body       = req.body || {};
    const rawOrderId = body.orderId !== undefined ? body.orderId : body.order_id;
    const orderId    = (typeof rawOrderId === 'string'
      ? rawOrderId
      : String(rawOrderId == null ? '' : rawOrderId)
    ).trim();

    if (!orderId) {
      console.warn('[verify-payment] VALIDATION_FAILED ' + JSON.stringify({
        requestId, received: rawOrderId, receivedType: typeof rawOrderId, bodyKeys: Object.keys(body)
      }));
      return res.status(400).json({
        success: false, error: 'orderId is required.', field: 'orderId',
        message: 'Send { "orderId": "ORD_..." } or { "order_id": "ORD_..." }.', requestId
      });
    }

    const t1 = Date.now();
    console.info('[verify-payment] T1_CASHFREE_VERIFY_START ' + JSON.stringify({
      requestId, orderId,
      sinceRequestMs: since(t0).ms,
      maxAttempts:    MAX_ORDER_RETRIES,
      retryDelays:    RETRY_DELAYS_MS.map(d => `${d}ms`),
      strategy:       'attempt-1-parallel-then-sequential'
    }));

    const cashfree = getCashfreeClient();
    const { order, attempts, resolvedViaPaymentRecord } =
      await fetchOrderStatus(cashfree, orderId, requestId, t0);

    const t2 = Date.now();
    console.info('[verify-payment] T2_CASHFREE_VERIFY_DONE ' + JSON.stringify({
      requestId, cashfreeVerifyMs: t2 - t1, totalElapsedMs: t2 - t0
    }));

    if (!order) {
      console.error('[verify-payment] ALL_RETRIES_EMPTY ' + JSON.stringify({
        requestId, orderId, attempts, totalElapsedMs: since(t0).ms
      }));
      return res.status(502).json({
        success: false, status: 'FAILED',
        error: 'Payment gateway returned no data after all retries.', requestId
      });
    }

    const paymentStatus  = (order.payment_status || 'UNKNOWN').toUpperCase();
    const orderStatus    = (order.order_status   || 'UNKNOWN').toUpperCase();
    const totalElapsedMs = Date.now() - t0;

    console.info('[verify-payment] T3_RESPONSE_SENT ' + JSON.stringify({
      requestId, orderId, paymentStatus, orderStatus,
      attempts, resolvedViaPaymentRecord,
      timing: {
        sinceRequestMs:   totalElapsedMs,
        cashfreeVerifyMs: t2 - t1,
        overheadMs:       totalElapsedMs - (t2 - t1)
      }
    }));

    return res.status(200).json({
      success:       paymentStatus === 'SUCCESS',
      status:        paymentStatus,
      paymentStatus,
      orderStatus,
      orderId:       order.order_id,
      elapsed:       `${totalElapsedMs}ms`,
      requestId
    });

  } catch (err) {
    const handled = handleCashfreeError(err, req, res, 'verify-payment');
    if (!handled) next(err);
  }
});

module.exports = router;
