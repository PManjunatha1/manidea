'use strict';

const { Cashfree, CFEnvironment } = require('cashfree-pg');

/**
 * Creates and returns a Cashfree client.
 *
 * WHY no singleton: Vercel serverless functions are stateless. A module-level
 * variable cached as null on a cold start stays null. Creating the client fresh
 * on each call costs ~0ms and is the correct pattern for serverless.
 *
 * Throws a descriptive Error if credentials are missing so the caller can
 * return a 500 with a clear message instead of a cryptic SDK crash.
 */
function getCashfreeClient() {
  const appId  = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;

  if (!appId || !appId.trim()) {
    throw new Error('Environment variable CASHFREE_APP_ID is missing or empty.');
  }
  if (!secret || !secret.trim()) {
    throw new Error('Environment variable CASHFREE_SECRET_KEY is missing or empty.');
  }

  const env = process.env.CASHFREE_ENV === 'PRODUCTION'
    ? CFEnvironment.PRODUCTION
    : CFEnvironment.SANDBOX;

  return new Cashfree(env, appId.trim(), secret.trim());
}

module.exports = { getCashfreeClient };
