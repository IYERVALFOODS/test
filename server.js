// ================= IMPORTS =================
const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();
const Razorpay = require("razorpay");
const crypto = require("crypto");

// ================= VALIDATE ENV VARIABLES =================
const required = ["RAZORPAY_KEY_ID", "RAZORPAY_SECRET", "ADMIN_PASSCODE"];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  console.error("Add them in Render Dashboard → Environment");
  process.exit(1);
}

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_SECRET = process.env.RAZORPAY_SECRET;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;
const REGULAR_SHIPPING_FEE = parseInt(process.env.REGULAR_SHIPPING_FEE) || 70;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "iyervalfoods@gmail.com";
const FEEDBACK_ENDPOINT = process.env.FEEDBACK_ENDPOINT || "https://formsubmit.co/ajax/iyervalfoods@gmail.com";
const SHEETS_ENDPOINT = process.env.GOOGLE_SHEET_URL || "https://script.google.com/macros/s/AKfycbwP1vGnwT-tmMcmUpvu8syqD8yt8im4LG3ziBv9NGL_WSeb-jssPlS9un_M3ALzNJjh/exec";

// ================= INIT EXPRESS =================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ================= INIT RAZORPAY =================
let razorpay;
try {
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_SECRET });
  console.log("✅ Razorpay client ready");
} catch (err) {
  console.error("❌ Razorpay init failed:", err.message);
  process.exit(1);
}

// In-memory storage
const orders = [];

// ================= ROUTES =================
app.get("/health", (req, res) => {
  res.json({ status: "ok", orders: orders.length });
});

app.get("/config", (req, res) => {
  res.json({
    shippingFee: REGULAR_SHIPPING_FEE,
    contactEmail: CONTACT_EMAIL,
    razorpayKey: RAZORPAY_KEY_ID,
  });
});

app.post("/create-order", async (req, res) => {
  try {
    const rupees = parseFloat(req.body.amount);
    if (isNaN(rupees) || rupees < 1) {
      return res.status(400).json({ error: "Invalid amount (min ₹1)" });
    }
    const amountPaise = Math.round(rupees * 100);
    console.log(`💰 Creating order: ₹${rupees} (${amountPaise} paise)`);
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: "rcpt_" + Date.now(),
    });
    console.log(`✅ Order created: ${order.id}`);
    res.json(order);
  } catch (err) {
    console.error("❌ Razorpay error:", err);
    const message = err.error?.description || err.message || "Payment initiation failed";
    res.status(500).json({ error: message });
  }
});

app.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto
      .createHmac("sha256", RAZORPAY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    if (expected === razorpay_signature) {
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/save-order", async (req, res) => {
  try {
    const orderData = {
      ...req.body,
      orderId: "IYER" + Date.now().toString().slice(-8),
      timestamp: new Date().toISOString(),
      status: "pending",
    };
    orders.unshift(orderData);
    // Fire-and-forget to Google Sheets
    fetch(SHEETS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderData),
    }).catch(e => console.error("Sheet error:", e.message));
    res.json({ success: true, orderId: orderData.orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save order" });
  }
});

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
  } else {
    res.status(404).json({ success: false });
  }
});

app.post("/admin/delete-order", (req, res) => {
  if (req.body.passcode !== ADMIN_PASSCODE) return res.status(401).json({ success: false });
  const idx = orders.findIndex(o => o.orderId === req.body.orderId);
  if (idx !== -1) {
    orders.splice(idx, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false });
  }
});

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
  console.log(`🔑 Razorpay key: ${RAZORPAY_KEY_ID}`);
});
