const CASHFREE_API_URL = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
};

const API_VERSION = "2023-08-01";
const FETCH_TIMEOUT_MS = 5000; // Hard timeout on requests
const TERMINAL = new Set([
  "PAID", "SUCCESS", "COMPLETED",
  "FAILED", "TERMINATED", "EXPIRED", "CANCELLED",
]);
const FAILED_STATES = new Set(["FAILED", "TERMINATED", "EXPIRED", "CANCELLED"]);

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const orderId = String(body.orderId || body.order_id || "").trim();
  const userId = String(body.uid || body.customer_id || "").trim();
  if (!orderId) {
    return res.status(400).json({ error: "Missing orderId" });
  }

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

  console.log(`[verify-payment] START | orderId=${orderId}`);

  try {
    // ── First fetch with timeout (fail-fast on errors) ──
    const cfRes = await fetchWithTimeout(`${baseUrl}/orders/${orderId}`, {
      method: "GET",
      headers,
    }, FETCH_TIMEOUT_MS);

    const data = await cfRes.json();
    const status = String(data.order_status || "").toUpperCase();

    console.log(`[verify-payment] HTTP ${cfRes.status} | status=${status} | orderId=${orderId}`);

    if (!cfRes.ok) {
      console.error(`[verify-payment] Cashfree error: ${JSON.stringify(data)}`);
      return res.status(cfRes.status).json({
        status: "FAILED",
        orderId,
        error: data.message || `Cashfree HTTP ${cfRes.status}`,
      });
    }

    // ── FAIL states: Return immediately (no retries) ──
    if (FAILED_STATES.has(status)) {
      console.log(`[verify-payment] FAILED_STATE → ${status} | orderId=${orderId}`);
      return res.status(200).json({
        status,
        orderId,
        cfOrderId: data.cf_order_id || orderId,
        orderAmount: data.order_amount,
      });
    }

    // ── PAID: Verify payment record exists ──
    if (status === "PAID") {
      const paymentOk = await verifyPaymentRecordFast(baseUrl, headers, orderId);
      if (paymentOk) {
        return res.status(200).json({
          status: "PAID",
          orderId,
          cfOrderId: data.cf_order_id || orderId,
          orderAmount: data.order_amount,
        });
      }
    }

    // ── SUCCESS, COMPLETED, or unconfirmed PAID ──
    if (TERMINAL.has(status)) {
      return res.status(200).json({
        status,
        orderId,
        cfOrderId: data.cf_order_id || orderId,
        orderAmount: data.order_amount,
      });
    }

    // ── PENDING: Return immediately ──
    return res.status(200).json({
      status: "PENDING",
      orderId,
      message: "Payment is being confirmed. Checking again in a moment...",
      cfOrderId: data.cf_order_id || orderId,
    });

  } catch (err) {
    console.error(`[verify-payment] EXCEPTION: ${err.message}`);
    return res.status(200).json({
      status: "PENDING",
      orderId,
      error: "Verification timeout - payment still processing",
    });
  }
};

async function verifyPaymentRecordFast(baseUrl, headers, orderId) {
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/orders/${orderId}/payments`,
      { method: "GET", headers },
      3000 // Shorter timeout for payment record check
    );
    if (!res.ok) return false;
    const payments = await res.json();
    return Array.isArray(payments) && 
           payments.some((p) => String(p.payment_status || "").toUpperCase() === "SUCCESS");
  } catch (err) {
    console.error(`[verify-payment] Payment record check failed: ${err.message}`);
    return false;
  }
}

function fetchWithTimeout(url, options, timeoutMs) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
    ),
  ]);
}