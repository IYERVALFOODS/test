// ================= IMPORTS =================
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

// ================= VALIDATE ENV VARIABLES =================
const required = ["ADMIN_PASSCODE", "SBIEPAY_MERCHANT_ID", "SBIEPAY_ACCESS_CODE", "SBIEPAY_SECRET_KEY"];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  process.exit(1);
}

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;
const REGULAR_SHIPPING_FEE = parseInt(process.env.REGULAR_SHIPPING_FEE) || 70;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "iyervalfoods@gmail.com";
const FEEDBACK_ENDPOINT = process.env.FEEDBACK_ENDPOINT || "https://formsubmit.co/ajax/iyervalfoods@gmail.com";
const SHEETS_ENDPOINT = process.env.GOOGLE_SHEET_URL || "";

// SBI ePay config
const MERCHANT_ID = process.env.SBIEPAY_MERCHANT_ID;
const ACCESS_CODE = process.env.SBIEPAY_ACCESS_CODE;
const SECRET_KEY = process.env.SBIEPAY_SECRET_KEY;
const RETURN_URL = process.env.SBIEPAY_RETURN_URL || "https://yourdomain.com/payment-response";
const SBIEPAY_GATEWAY_URL = "https://secure.sbiepay.com/secure/transaction.do"; // production
// For testing, use their sandbox if available – adjust accordingly.

// ================= INIT EXPRESS =================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory storage for orders + temporary payment sessions
const orders = [];
const paymentSessions = new Map(); // key = merchantOrderId, value = orderData

// ================= HELPER: Generate SHA‑512 Checksum (as per SBI ePay) =================
function generateChecksum(data) {
  // Data should be a string of sorted key-value pairs separated with '|'
  // Example: "merchant_id|order_id|amount|currency|redirect_url|access_code"
  const hashString = data + "|" + SECRET_KEY;
  return crypto.createHash("sha512").update(hashString).digest("hex");
}

function verifyChecksum(postData, receivedChecksum) {
  // Remove 'checksum' from data before computing
  const { checksum, ...rest } = postData;
  const sortedKeys = Object.keys(rest).sort();
  const dataString = sortedKeys.map(key => rest[key]).join("|");
  const expected = generateChecksum(dataString);
  return expected === receivedChecksum;
}

// ================= ROUTES =================
app.get("/health", (req, res) => {
  res.json({ status: "ok", orders: orders.length });
});

app.get("/config", (req, res) => {
  res.json({
    shippingFee: REGULAR_SHIPPING_FEE,
    contactEmail: CONTACT_EMAIL,
  });
});

// Step 1: Create payment session and return SBI ePay form parameters
app.post("/initiate-payment", (req, res) => {
  try {
    const orderData = req.body;
    // Required fields from frontend
    if (!orderData.amount || !orderData.name || !orderData.phone || !orderData.email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const merchantOrderId = "IYER" + Date.now().toString().slice(-8);
    const amountInPaise = Math.round(parseFloat(orderData.amount) * 100);
    const amountInRupees = (amountInPaise / 100).toFixed(2);

    // Store the full order temporarily
    paymentSessions.set(merchantOrderId, {
      ...orderData,
      merchantOrderId,
      status: "pending",
      createdAt: Date.now()
    });

    // SBI ePay required fields (as per their documentation)
    const postData = {
      merchant_id: MERCHANT_ID,
      order_id: merchantOrderId,
      amount: amountInRupees,
      currency: "INR",
      redirect_url: RETURN_URL,
      cancel_url: RETURN_URL,
      language: "EN",
      name: orderData.name,
      email: orderData.email,
      phone: orderData.phone,
      address: orderData.address || "",
      city: "",
      state: "",
      country: "India",
      zipcode: orderData.pincode || "",
      udf1: orderData.items ? JSON.stringify(orderData.items) : "",
      udf2: orderData.subtotal || "",
      udf3: orderData.shipping || "",
      udf4: "",
      udf5: "",
      access_code: ACCESS_CODE
    };

    // Compute SHA‑512 checksum (as per SBI ePay)
    const sortedKeys = Object.keys(postData).sort();
    const dataString = sortedKeys.map(key => postData[key]).join("|");
    const checksum = generateChecksum(dataString);
    postData.checksum = checksum;

    res.json({
      success: true,
      gatewayUrl: SBIEPAY_GATEWAY_URL,
      formFields: postData
    });
  } catch (err) {
    console.error("Initiate payment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Handle SBI ePay callback (POST from payment gateway)
app.post("/payment-response", async (req, res) => {
  try {
    const responseData = req.body;
    const receivedChecksum = responseData.checksum;
    const merchantOrderId = responseData.order_id;

    // Verify checksum
    if (!verifyChecksum(responseData, receivedChecksum)) {
      console.error("Checksum mismatch for order", merchantOrderId);
      return res.redirect("/?payment_status=failed&order_id=" + merchantOrderId);
    }

    const paymentStatus = responseData.payment_status; // 'success' / 'failure'
    const sessionOrder = paymentSessions.get(merchantOrderId);

    if (!sessionOrder) {
      console.error("No session found for order", merchantOrderId);
      return res.redirect("/?payment_status=unknown");
    }

    if (paymentStatus === "success") {
      // Build final order object
      const finalOrder = {
        ...sessionOrder,
        orderId: merchantOrderId,
        timestamp: new Date().toISOString(),
        status: "pending",
        paymentMethod: "SBI ePay",
        paymentId: responseData.transaction_id || "TXN_" + Date.now(),
        razorpayOrderId: null
      };
      orders.unshift(finalOrder);

      // Send to Google Sheets (fire-and-forget)
      if (SHEETS_ENDPOINT) {
        fetch(SHEETS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(finalOrder),
        }).catch(e => console.error("Sheet error:", e.message));
      }

      paymentSessions.delete(merchantOrderId);
      // Redirect to frontend with success
      return res.redirect(`/?payment_status=success&order_id=${merchantOrderId}`);
    } else {
      paymentSessions.delete(merchantOrderId);
      return res.redirect(`/?payment_status=failed&order_id=${merchantOrderId}`);
    }
  } catch (err) {
    console.error("Payment response error:", err);
    res.redirect("/?payment_status=error");
  }
});

// Get order details by ID (for confirmation page)
app.get("/order/:orderId", (req, res) => {
  const order = orders.find(o => o.orderId === req.params.orderId);
  if (order) res.json(order);
  else res.status(404).json({ error: "Order not found" });
});

// Save order (used if payment is already verified – not directly called from frontend now)
app.post("/save-order", async (req, res) => {
  try {
    const orderData = {
      ...req.body,
      orderId: req.body.orderId || ("IYER" + Date.now().toString().slice(-8)),
      timestamp: new Date().toISOString(),
      status: "pending",
    };
    orders.unshift(orderData);
    if (SHEETS_ENDPOINT) {
      fetch(SHEETS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderData),
      }).catch(e => console.error("Sheet error:", e.message));
    }
    res.json({ success: true, orderId: orderData.orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save order" });
  }
});

// ========== Admin endpoints (unchanged) ==========
app.post("/admin/orders", (req, res) => {
  if (req.body.passcode !== ADMIN_PASSCODE) return res.status(401).json({ success: false });
  res.json({ success: true, orders });
});
app.post("/admin/update-order", (req, res) => {
  if (req.body.passcode !== ADMIN_PASSCODE) return res.status(401).json({ success: false });
  const order = orders.find(o => o.orderId === req.body.orderId);
  if (order) {
    order.status = req.body.status;
    res.json({ success: true });
  } else res.status(404).json({ success: false });
});
app.post("/admin/delete-order", (req, res) => {
  if (req.body.passcode !== ADMIN_PASSCODE) return res.status(401).json({ success: false });
  const idx = orders.findIndex(o => o.orderId === req.body.orderId);
  if (idx !== -1) {
    orders.splice(idx, 1);
    res.json({ success: true });
  } else res.status(404).json({ success: false });
});

// ========== Feedback endpoint ==========
app.post("/feedback", async (req, res) => {
  try {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).json({ error: "Missing fields" });
    await fetch(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, message }),
    }).catch(e => console.log("Feedback forward failed:", e.message));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// Serve frontend for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handler
app.use((err, req, res, next) => {
  console.error("🔥 Unhandled error:", err.stack);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔐 SBI ePay merchant: ${MERCHANT_ID}`);
});