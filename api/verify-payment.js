'use strict';

const express               = require('express');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/verify-payment
// ─────────────────────────────────────────────────────────────────────────────
router.get('/verify-payment', (_req, res) => {
  res.status(200).json({
    success:        true,
    message:        'Send a POST request to /api/verify-payment to verify a payment.',
    requiredFields: ['orderId']
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/verify-payment
//
// Fetches order status DIRECTLY from Cashfree servers.
// Never trusts any payment status sent by the client.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify-payment', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = Date.now();

  // ── STEP 1: Log incoming request ──────────────────────────────────────────
  console.info('[verify-payment] INCOMING_REQUEST ' + JSON.stringify({
    requestId,
    timestamp:   new Date().toISOString(),
    contentType: req.headers['content-type'],
    bodyRaw:     req.body,
    bodyTypes:   req.body ? { orderId: typeof req.body.orderId } : null
  }));

  try {
    // ── STEP 2: Validate ─────────────────────────────────────────────────────
    const rawOrderId = req.body?.orderId;
    const orderId    = typeof rawOrderId === 'string'
      ? rawOrderId.trim()
      : String(rawOrderId == null ? '' : rawOrderId).trim();

    if (!orderId) {
      console.warn('[verify-payment] VALIDATION_FAILED ' + JSON.stringify({
        requestId,
        received:     rawOrderId,
        receivedType: typeof rawOrderId
      }));
      return res.status(400).json({
        success:       false,
        reason:        'Validation failed.',
        missingFields: [{
          field:        'orderId',
          received:     rawOrderId,
          receivedType: typeof rawOrderId,
          reason:       'orderId is required and must be a non-empty string.'
        }],
        invalidFields: [],
        receivedBody:  req.body,
        requestId
      });
    }

    // ── STEP 3: Fetch from Cashfree ───────────────────────────────────────────
    console.info('[verify-payment] CASHFREE_REQUEST ' + JSON.stringify({
      requestId,
      orderId,
      elapsed: `${Date.now() - startTime}ms`
    }));

    const cashfree = getCashfreeClient();
    const response  = await cashfree.PGFetchOrder(orderId);
    const order     = response?.data;

    console.info('[verify-payment] CASHFREE_RESPONSE ' + JSON.stringify({
      requestId,
      httpStatus:   response?.status,
      responseData: order,
      elapsed:      `${Date.now() - startTime}ms`
    }));

    // ── STEP 4: Guard empty response ──────────────────────────────────────────
    if (!order) {
      console.error('[verify-payment] EMPTY_RESPONSE ' + JSON.stringify({ requestId, orderId }));
      return res.status(502).json({
        success:   false,
        reason:    'Payment gateway returned an empty response. Please retry.',
        requestId
      });
    }

    const orderStatus   = String(order.order_status   || 'UNKNOWN').toUpperCase();
    const paymentStatus = String(order.payment_status || 'UNKNOWN').toUpperCase();

    console.info('[verify-payment] SUCCESS ' + JSON.stringify({
      requestId,
      orderId,
      orderStatus,
      paymentStatus,
      elapsed: `${Date.now() - startTime}ms`
    }));

    // ── STEP 5: Return result ─────────────────────────────────────────────────
    return res.status(200).json({
      success:       paymentStatus === 'SUCCESS',
      orderId:       order.order_id,
      orderStatus,
      paymentStatus,
      orderAmount:   order.order_amount,
      orderCurrency: order.order_currency,
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
        reason:    'Order not found in payment gateway.',
        requestId
      });
    }

    // Cashfree returned a structured error
    if (cfError) {
      return res.status(502).json({
        success:       false,
        reason:        'Payment gateway error.',
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
        reason:  'Server configuration error. Contact support.',
        message: err.message,
        requestId
      });
    }

    next(err);
  }
});

module.exports = router;
