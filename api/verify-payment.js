'use strict';

const express = require('express');
const { Cashfree, CFEnvironment } = require('cashfree-pg');

const router = express.Router();

// ── Cashfree client (initialised once at module load) ─────────────────────────
const CF_ENV = process.env.CASHFREE_ENV === 'PRODUCTION'
  ? CFEnvironment.PRODUCTION
  : CFEnvironment.SANDBOX;

const cashfree = new Cashfree(
  CF_ENV,
  process.env.CASHFREE_APP_ID,
  process.env.CASHFREE_SECRET_KEY
);

// ── GET /api/verify-payment ───────────────────────────────────────────────────
router.get('/verify-payment', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Use POST /api/verify-payment to verify a payment.',
    requiredFields: ['orderId']
  });
});

// ── POST /api/verify-payment ──────────────────────────────────────────────────
router.post('/verify-payment', async (req, res, next) => {
  const requestId = req._requestId || `req_${Date.now()}`;
  const startTime = Date.now();

  try {
    const { orderId } = req.body || {};

    if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
      return res.status(400).json({
        success: false,
        error: 'orderId is required and must be a non-empty string',
        requestId
      });
    }

    const response = await cashfree.PGFetchOrder(orderId.trim());
    const order = response?.data;

    if (!order) {
      console.error('[verify-payment] Empty response from Cashfree', { requestId, orderId });
      return res.status(502).json({
        success: false,
        error: 'Payment gateway returned an empty response. Please retry.',
        requestId
      });
    }

    const orderStatus = String(order.order_status || '').toUpperCase();
    const paymentStatus = String(order.payment_status || 'UNKNOWN').toUpperCase();

    console.info('[verify-payment] FETCHED', {
      requestId,
      orderId,
      orderStatus,
      paymentStatus,
      elapsed: `${Date.now() - startTime}ms`
    });

    return res.status(200).json({
      success: paymentStatus === 'SUCCESS',
      orderId: order.order_id,
      orderStatus,
      paymentStatus,
      orderAmount: order.order_amount,
      orderCurrency: order.order_currency,
      requestId
    });

  } catch (err) {
    const cfError = err?.response?.data;
    console.error('[verify-payment] ERROR', {
      requestId,
      message: err.message,
      cashfreeError: cfError,
      elapsed: `${Date.now() - startTime}ms`
    });

    if (cfError?.code === 'ORDER_NOT_FOUND' || err?.response?.status === 404) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
        requestId
      });
    }

    if (cfError) {
      return res.status(502).json({
        success: false,
        error: 'Payment gateway error',
        code: cfError.code || 'GATEWAY_ERROR',
        requestId
      });
    }

    next(err);
  }
});

module.exports = router;
