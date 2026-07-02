'use strict';

const { Cashfree, CFEnvironment } = require('cashfree-pg');

let _client = null;

/**
 * Returns the Cashfree client.
 * Initialised once on first call (lazy) so Vercel cold starts never crash
 * before environment variables are injected.
 * Throws a clear error if credentials are missing.
 */
function getCashfreeClient() {
  if (_client) return _client;

  const appId  = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;

  if (!appId || !secret) {
    throw new Error(
      'CASHFREE_APP_ID and CASHFREE_SECRET_KEY must be set in environment variables.'
    );
  }

  const env = process.env.CASHFREE_ENV === 'PRODUCTION'
    ? CFEnvironment.PRODUCTION
    : CFEnvironment.SANDBOX;

  _client = new Cashfree(env, appId, secret);
  return _client;
}

module.exports = { getCashfreeClient };
