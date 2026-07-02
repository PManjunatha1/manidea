'use strict';

const express              = require('express');
const { randomBytes }      = require('crypto');
const { getCashfreeClient } = require('./cashfree-client');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[6-9]\d{9}$/;           // Indian 10-digit mobile numbers
const RETURN_URL  = 'https://manidea.in/payment-status?order_id={order_id}';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a guaranteed-unique order ID.
 * Format: ORD_<timestamp>_<8 random hex chars>
 * Example: ORD_1719825600000_3FA2C1B8
 */
function generateOrderId() {
  return `ORD_${Date.now()}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Validates all required fields from the request body.
 * Returns { errors: string[], fields: object } where fields are sanitised values.
 */
function validateCreateOrderBody(body) {
  const errors = [];
  const raw = body || {};

  const customerId    = typeof raw.customerId    === 'string' ? raw.customerId.trim()    : '';
  const customerName  = typeof raw.customerName  === 'string' ? raw.customerName.trim()  : '';
  const customerEmail = typeof raw.customerEmail === 'string' ? raw.customerEmail.trim().toLowerCase() : '';
  const customerPhone = typeof raw.customerPhone === 'string' ? raw.customerPhone.trim() : String(raw.customerPhone || '').trim();
  const orderAmount   = raw.orderAmount;

  if (!customerId)                          errors.push('customerId is required.');
  if (!customerName)                        errors.push('customerName is required.');
  if (!EMAIL_REGEX.test(customerEmail))     errors.push('customerEmail must be a valid email address.');
  if (!PHONE_REGEX.test(customerPhone))     errors.push('customerPhone must be a valid 10-digit Indian mobile number.');

  const amount = Number(orderAmount);
  if (orderAmount === undefined || orderAmount === null || orderAmount === '') {
    errors.push('orderAmount is required.');
  } else if (!Number.isFinite(amount) || amount <= 0) {
    errors.push('orderAmount must be a positive number.');
  }

  return {
    errors,
    fields: { customerId, customerName, customerEmail, customerPhone, amount }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/create-order
// Informs the caller this endpoint requires POST.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/create-order', (_req, res) => {
  res.status(200).json({
    success:        true,
    message:        'Send a POST request to /api/create-order to create a payment order.',
    requiredFields: ['customerId', 'customerName', 'customerEmail', 'customerPhone', 'orderAmount']
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-order
// Creates a Cashfree payment order and returns the payment_session_id.
// The client uses payment_session_id to open the Cashfree checkout.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-order', async (req, res, next) => {
  const requestId = req.requestId || `rid_${Date.now()}`;
  const startTime = Date.now();

  try {
    // 1. Validate input
    const { errors, fields } = validateCreateOrderBody(req.body);
    if (errors.length > 0) {
      return res.status(400).json({
        success:   false,
        error:     'Validation failed.',
        details:   errors,
        requestId
      });
    }

    // 2. Build order payload
    const orderId = generateOrderId();
    const orderPayload = {
      order_id:       orderId,
      order_amount:   fields.amount,
      order_currency: 'INR',
      customer_details: {
        customer_id:    fields.customerId,
        customer_name:  fields.customerName,
        customer_email: fields.customerEmail,
        customer_phone: fields.customerPhone
      },
      order_meta: {
        return_url: RETURN_URL
      }
    };

    // 3. Call Cashfree (lazy client — safe on cold starts)
    const cashfree = getCashfreeClient();
    const response  = await cashfree.PGCreateOrder(orderPayload);
    const data      = response?.data;

    // 4. Guard against unexpected empty response
    if (!data || !data.payment_session_id) {
      console.error(`[create-order] No session returned ${requestId}`, data);
      return res.status(502).json({
        success:   false,
        error:     'Payment gateway did not return a session. Please try again.',
        requestId
      });
    }

    console.info(`[create-order] OK ${requestId} orderId=${data.order_id} (${Date.now() - startTime}ms)`);

    // 5. Return permanent response shape — never changes
    return res.status(200).json({
      success:          true,
      orderId:          data.order_id,
      paymentSessionId: data.payment_session_id,
      orderStatus:      data.order_status,
      requestId
    });

  } catch (err) {
    const cfError = err?.response?.data;
    console.error(`[create-order] ERROR ${requestId}`, err.message, cfError || '');

    // Cashfree returned a structured error — surface the code, not the stack
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
