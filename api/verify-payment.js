const express = require('express');
const dotenv = require('dotenv');
const { Cashfree, CFEnvironment } = require('cashfree-pg');

dotenv.config();

const router = express.Router();
router.use(express.json());

const cashfree = new Cashfree(
  CFEnvironment.SANDBOX,
  process.env.CASHFREE_APP_ID,
  process.env.CASHFREE_SECRET_KEY
);

router.post('/verify-payment', async (req, res) => {
  try {
    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'orderId is required'
      });
    }

    const response = await cashfree.PGFetchOrder(orderId);
    const order = response?.data || {};
    const paymentStatus = String(order.payment_status || '').toUpperCase();
    const orderStatus = order.order_status || '';

    if (paymentStatus === 'SUCCESS') {
      return res.status(200).json({
        success: true,
        paymentStatus,
        orderStatus,
        paymentDetails: order.payment_details || {}
      });
    }

    if (paymentStatus === 'PENDING') {
      return res.status(200).json({
        success: false,
        paymentStatus
      });
    }

    return res.status(200).json({
      success: false,
      paymentStatus
    });
  } catch (error) {
    console.error('Cashfree verify-payment error:', error?.response?.data || error?.message || error);

    return res.status(500).json({
      success: false,
      message: 'Failed to verify payment'
    });
  }
});

module.exports = router;
