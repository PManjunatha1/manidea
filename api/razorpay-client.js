'use strict';

const Razorpay = require('razorpay');

// Cached per serverless instance — safe because env vars are immutable after cold start.
let _client = null;

function getRazorpayClient() {
  if (_client) return _client;

  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId     || !keyId.trim())     throw new Error('Environment variable RAZORPAY_KEY_ID is missing or empty.');
  if (!keySecret || !keySecret.trim()) throw new Error('Environment variable RAZORPAY_KEY_SECRET is missing or empty.');

  _client = new Razorpay({ key_id: keyId.trim(), key_secret: keySecret.trim() });
  return _client;
}

module.exports = { getRazorpayClient };
