const express = require('express');
const dotenv = require('dotenv');
const { randomUUID } = require('crypto');
const { Cashfree, CFEnvironment } = require('cashfree-pg');

dotenv.config();

const router = express.Router();
router.use(express.json());

router.get('/create-order', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Use POST /api/create-order to create a payment order.'
  });
});

const cashfree = new Cashfree(
  CFEnvironment.SANDBOX,
  process.env.CASHFREE_APP_ID,
  process.env.CASHFREE_SECRET_KEY
);

router.post('/create-order', async (req, res) => {
  try {
    const {
      customerId,
      customerName,
      customerEmail,
      customerPhone,
      orderAmount
    } = req.body || {};

    if (!customerId || !customerName || !customerEmail || !customerPhone || orderAmount === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    const amount = Number(orderAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'orderAmount must be a positive number'
      });
    }

    const orderId = `ORD_${randomUUID()}`;

    const request = {
      order_amount: amount,
      order_currency: 'INR',
      order_id: orderId,
      customer_details: {
        customer_id: customerId,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone
      },
      order_meta: {
        return_url: 'https://www.cashfree.com/devstudio/preview/pg/web/checkout?order_id={order_id}'
      }
    };

    const response = await cashfree.PGCreateOrder(request);

    return res.status(200).json({
  success: true,
  order_id: response.data.order_id,
  payment_session_id: response.data.payment_session_id,
  order_status: response.data.order_status
});
  } catch (error) {
    console.error('Cashfree create-order error:', error?.response?.data || error?.message || error);

    return res.status(500).json({
      success: false,
      message: 'Failed to create order'
    });
  }
});

module.exports = router;
