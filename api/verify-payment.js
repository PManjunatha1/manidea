/**
 * ULTRA-FAST CASHFREE PAYMENT VERIFICATION
 * Optimized for Vercel Serverless Functions
 */

const CASHFREE_API_URL = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
};

const API_VERSION = "2023-08-01";
const FETCH_TIMEOUT_MS = 4000; // Polling efficiency: 4s timeout

module.exports = async (req, res) => {
  // 1. Handle CORS (Required for Android access)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 2. Extract Input
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "Missing orderId" });

  // 3. Setup Configuration
  const env = process.env.CASHFREE_ENV || "sandbox";
  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;

  if (!appId || !secretKey) {
    return res.status(500).json({ error: "Server Configuration Error" });
  }

  const baseUrl = CASHFREE_API_URL[env];
  const headers = {
    "Content-Type": "application/json",
    "x-client-id": appId,
    "x-client-secret": secretKey,
    "x-api-version": API_VERSION,
  };

  try {
    // 4. Fast Check: Fetch Order Status directly
    // AbortSignal.timeout is the fastest way to handle network hangs in Node 18+
    const cfRes = await fetch(`${baseUrl}/orders/${orderId}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    const data = await cfRes.json();
    if (!cfRes.ok) throw new Error(data.message || "Gateway Error");

    const status = (data.order_status || "").toUpperCase();

    // 5. Mapping Success States (Immediate)
    // If order is PAID, it's successful. No need for extra payment record checks.
    if (["PAID", "SUCCESS", "COMPLETED"].includes(status)) {
      return res.status(200).json({
        status: "SUCCESS",
        orderId,
        orderAmount: data.order_amount,
        cfOrderId: data.cf_order_id
      });
    }

    // 6. Mapping Failure States (Immediate)
    if (["FAILED", "TERMINATED", "EXPIRED", "CANCELLED"].includes(status)) {
      return res.status(200).json({ status: "FAILED", orderId });
    }

    // 7. Otherwise: PENDING
    return res.status(200).json({ status: "PENDING", orderId });

  } catch (err) {
    console.error(`[Verify] ${orderId} Error: ${err.message}`);
    // Return PENDING on timeout/error so the app retries instead of failing
    return res.status(200).json({ status: "PENDING", orderId });
  }
};