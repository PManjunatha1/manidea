'use strict';

const express               = require('express');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/verify-payment
// Informs the caller this endpoint requires POST.
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
// Fetches order status directly from Cashfree servers.
// Never trusts any status sent by the client.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify-payment', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = Date.now();

  try {
    // 1. Validate input
    const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
    if (!orderId) {
      return res.status(400).json({
        success:   false,
        error:     'orderId is required and must be a non-empty string.',
        requestId
      });
    }

    // 2. Fetch order from Cashfree (server-side — client cannot tamper)
    const cashfree = getCashfreeClient();
    const response  = await cashfree.PGFetchOrder(orderId);
    const order     = response?.data;

    // 3. Guard against empty response
    if (!order) {
      console.error(`[verify-payment] Empty response ${requestId} orderId=${orderId}`);
      return res.status(502).json({
        success:   false,
        error:     'Payment gateway returned an empty response. Please try again.',
        requestId
      });
    }

    const orderStatus   = String(order.order_status   || 'UNKNOWN').toUpperCase();
    const paymentStatus = String(order.payment_status || 'UNKNOWN').toUpperCase();

    console.info(`[verify-payment] OK ${requestId} orderId=${orderId} paymentStatus=${paymentStatus} (${Date.now() - startTime}ms)`);

    // 4. Return permanent response shape — never changes
    return res.status(200).json({
      success:        paymentStatus === 'SUCCESS',
      orderId:        order.order_id,
      orderStatus,
      paymentStatus,
      orderAmount:    order.order_amount,
      orderCurrency:  order.order_currency,
      requestId
    });

  } catch (err) {
    const cfError  = err?.response?.data;
    const cfStatus = err?.response?.status;
    console.error(`[verify-payment] ERROR ${requestId}`, err.message, cfError || '');

    // Order does not exist in Cashfree
    if (cfError?.code === 'ORDER_NOT_FOUND' || cfStatus === 404) {
      return res.status(404).json({
        success:   false,
        error:     'Order not found.',
        requestId
      });
    }

    // Cashfree returned a structured error
    if (cfError) {
      return res.status(502).json({
        success:   false,
        error:     'Payment gateway error.',
        code:      cfError.code || 'GATEWAY_ERROR',
        requestId
      });
    }

    // Anything else — pass to global error handler
    next(err);
  }
});

module.exports = router;
