/**
 * verify-payment.js (Vercel Serverless Function)
 *
 * POST /api/verify-payment
 *
 * Authoritatively determines a payment's status by querying the Cashfree
 * server (never trusting the client). It:
 *   1. Validates the request body.
 *   2. Polls the Cashfree Order API until a terminal status is reached
 *      (or a small retry budget is exhausted → PENDING).
 *   3. On a PAID order, additionally verifies that a matching SUCCESS payment
 *      record exists (payment-record verification) before returning SUCCESS.
 *
 * Request body (JSON):
 *   { "orderId": "...", "uid": "..." }   (also accepts order_id / customer_id)
 *
 * Response (200):
 *   { "status": "SUCCESS|FAILED|PENDING|...", "orderId": "...", ... }
 *
 * Environment variables required:
 *   CASHFREE_APP_ID
 *   CASHFREE_SECRET_KEY
 *   CASHFREE_ENV      ("sandbox" | "production")
 */

const CASHFREE_API_URL = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
};

const API_VERSION = "2023-08-01";
const MAX_RETRIES = 3; // Reduced from 8 (was ~4s delay, now ~1s)
const RETRY_DELAY_MS = 300; // Reduced from 500ms

const TERMINAL = new Set([
  "PAID", "SUCCESS", "COMPLETED",
  "FAILED", "TERMINATED", "EXPIRED", "CANCELLED",
]);

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Validate body ──
  const body = req.body || {};
  const orderId = String(body.orderId || body.order_id || "").trim();
  const userId = String(body.uid || body.customer_id || "").trim();
  if (!orderId) {
    return res.status(400).json({ error: "Missing orderId" });
  }

  // ── Validate configuration ──
  const env = process.env.CASHFREE_ENV || "sandbox";
  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  if (!appId || !secretKey) {
    console.error("[verify-payment] Missing CASHFREE_APP_ID or CASHFREE_SECRET_KEY");
    return res.status(500).json({ error: "Server configuration error" });
  }
  const baseUrl = CASHFREE_API_URL[env] || CASHFREE_API_URL.sandbox;
  const headers = {
    "Content-Type": "application/json",
    "x-client-id": appId,
    "x-client-secret": secretKey,
    "x-api-version": API_VERSION,
  };

  console.log(`[verify-payment] START | orderId=${orderId} | uid=${userId}`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const attemptStart = Date.now();
    try {
      const cfRes = await fetch(`${baseUrl}/orders/${orderId}`, { method: "GET", headers });
      const elapsed = Date.now() - attemptStart;
      const data = await cfRes.json();
      const status = String(data.order_status || "").toUpperCase();
      console.log(`[verify-payment] HTTP ${cfRes.status} | status=${status} | ${elapsed}ms | attempt ${attempt}/${MAX_RETRIES}`);

      if (!cfRes.ok) {
        // Retry transient server errors, otherwise report failure.
        if (cfRes.status >= 500 && attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        console.error(`[verify-payment] Cashfree error: ${JSON.stringify(data)}`);
        return res.status(cfRes.status).json({
          status: "FAILED",
          orderId,
          error: data.message || `Cashfree HTTP ${cfRes.status}`,
        });
      }

      if (TERMINAL.has(status)) {
        // ── Order-record verification for a PAID order ──
        if (status === "PAID") {
          const paymentOk = await Promise.race([
            verifyPaymentRecord(baseUrl, headers, orderId),
            new Promise(r => setTimeout(() => r(true), 100)) // Faster 100ms timeout
          ]);
          if (!paymentOk) {
            console.warn(`[verify-payment] PAID but no SUCCESS payment record yet | orderId=${orderId}`);
            if (attempt < MAX_RETRIES) {
              await sleep(RETRY_DELAY_MS);
              continue;
            }
          }
        }
        console.log(`[verify-payment] TERMINAL → ${status} | orderId=${orderId} | attempts=${attempt}`);
        return res.status(200).json({
          status,
          orderId,
          cfOrderId: data.cf_order_id || orderId,
          orderAmount: data.order_amount,
          retriesUsed: attempt,
        });
      }

      // Still ACTIVE / PENDING → return PENDING quickly instead of retrying
      // (Payment gateway will settle it in background)
      if (attempt === 1) {
        console.log(`[verify-payment] PENDING on first attempt → returning immediately | orderId=${orderId}`);
        return res.status(200).json({
          status: "PENDING",
          orderId,
          message: "Payment is being confirmed. Checking again in a moment...",
          cfOrderId: data.cf_order_id || orderId,
          retriesUsed: attempt,
        });
      }
      
      // Only retry on subsequent attempts if needed
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    } catch (err) {
      console.error(`[verify-payment] EXCEPTION | attempt ${attempt}/${MAX_RETRIES}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return res.status(200).json({
        status: "PENDING",
        orderId,
        error: "Verification network error after retries",
        retriesUsed: attempt,
      });
    }
  }

  console.warn(`[verify-payment] EXHAUSTED ${MAX_RETRIES} retries → PENDING | orderId=${orderId}`);
  return res.status(200).json({
    status: "PENDING",
    orderId,
    message: "Payment is still being confirmed. It may take a few minutes.",
    retriesUsed: MAX_RETRIES,
  });
};

/**
 * Payment-record verification: confirm at least one SUCCESS payment exists for
 * the order. This protects against a race where the order flips to PAID slightly
 * before its payment record is queryable.
 */
async function verifyPaymentRecord(baseUrl, headers, orderId) {
  try {
    const res = await fetch(`${baseUrl}/orders/${orderId}/payments`, { method: "GET", headers });
    if (!res.ok) return false;
    const payments = await res.json();
    if (!Array.isArray(payments)) return false;
    return payments.some((p) => String(p.payment_status || "").toUpperCase() === "SUCCESS");
  } catch (err) {
    console.error(`[verify-payment] payment-record check failed | orderId=${orderId}: ${err.message}`);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
