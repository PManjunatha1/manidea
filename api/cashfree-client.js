'use strict';

const { Cashfree, CFEnvironment } = require('cashfree-pg');

// Cached per serverless instance. Env vars are immutable after cold start,
// so creating the client once is safe and eliminates repeated string ops.
let _client = null;

function getCashfreeClient() {
  if (_client) return _client;

  const appId  = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;

  if (!appId  || !appId.trim())  throw new Error('Environment variable CASHFREE_APP_ID is missing or empty.');
  if (!secret || !secret.trim()) throw new Error('Environment variable CASHFREE_SECRET_KEY is missing or empty.');

  const env = process.env.CASHFREE_ENV === 'PRODUCTION'
    ? CFEnvironment.PRODUCTION
    : CFEnvironment.SANDBOX;

  _client = new Cashfree(env, appId.trim(), secret.trim());
  return _client;
}

module.exports = { getCashfreeClient };
