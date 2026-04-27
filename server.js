// ================= IMPORTS =================
const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: "./.env" });

const Razorpay = require("razorpay");
const crypto = require("crypto");

// ================= APP SETUP =================
const app = express();

// CORS – allow your Render domain and local dev
app.use(cors({
  origin: [
    'https://iyerval-backend.onrender.com',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= ENV VARIABLES =================
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || '1976';
const FEEDBACK_ENDPOINT = process.env.FEEDBACK_ENDPOINT || 'https://formsubmit.co/ajax/iyervalfoods@gmail.com';
const REGULAR_SHIPPING_FEE = parseInt(process.env.REGULAR_SHIPPING_FEE) || 70;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'iyervalfoods@gmail.com';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_SYWrfVzSNTbDes';
const RAZORPAY_SECRET = process.env.RAZORPAY_SECRET || 'dummy_secret_123';

// ================= RAZORPAY SETUP =================
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_SECRET
});

// ================= IN‑MEMORY STORAGE =================
const orders = [];
const feedbacks = [];

// ================= ROUTES =================

// Health check (confirm server is alive)
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    orders: orders.length,
    feedbacks: feedbacks.length
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Config – delivers safe data to frontend
app.get("/config", (req, res) => {
  res.json({
    shippingFee: REGULAR_SHIPPING_FEE,
    contactEmail: CONTACT_EMAIL,
    razorpayKey: RAZORPAY_KEY_ID
  });
});

// Create Razorpay Order
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const options = {
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      receipt: "order_" + Date.now()
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (err) {
    console.error("Razorpay order error:", err);
    res.status(500).json({ error: "Payment initiation failed" });
  }
});

// Verify Payment
app.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", RAZORPAY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expected === razorpay_signature) {
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

// Save Order
app.post("/save-order", async (req, res) => {
  try {
    const orderData = {
      ...req.body,
      orderId: "IYER" + Date.now().toString().slice(-8),
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    orders.unshift(orderData);

    // WhatsApp notification
    const message = `🍽️ New Order!\n━━━━━━━━━━\n📌 ${orderData.orderId}\n👤 ${orderData.name}\n📞 ${orderData.phone}\n📍 ${orderData.address}\n💰 Total: ₹${orderData.total}\n\nItems: ${orderData.items.map(i => `${i.name} x${i.quantity}`).join(', ')}`;
    const whatsappURL = `https://wa.me/918848636679?text=${encodeURIComponent(message)}`;

    res.json({
      success: true,
      orderId: orderData.orderId,
      whatsappURL
    });
  } catch (err) {
    console.error("Save order error:", err);
    res.status(500).json({ error: "Failed to save order" });
  }
});

// Admin – get orders (passcode protected)
app.post("/admin/orders", (req, res) => {
  const { passcode } = req.body;
  console.log("Admin attempt with passcode:", passcode, "Expected:", ADMIN_PASSCODE);
  if (passcode === ADMIN_PASSCODE) {
    res.json({ success: true, orders });
  } else {
    res.status(401).json({ success: false, message: "Invalid passcode" });
  }
});

// Admin – update order status
app.post("/admin/update-order", (req, res) => {
  const { passcode, orderId, status } = req.body;
  if (passcode !== ADMIN_PASSCODE) {
    return res.status(401).json({ success: false });
  }
  const order = orders.find(o => o.orderId === orderId);
  if (order) {
    order.status = status;
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, message: "Order not found" });
  }
});

// Admin – delete order
app.post("/admin/delete-order", (req, res) => {
  const { passcode, orderId } = req.body;
  if (passcode !== ADMIN_PASSCODE) {
    return res.status(401).json({ success: false });
  }
  const index = orders.findIndex(o => o.orderId === orderId);
  if (index > -1) {
    orders.splice(index, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false });
  }
});

// Feedback
app.post("/feedback", async (req, res) => {
  try {
    const { email, message } = req.body;
    if (!email || !message) {
      return res.status(400).json({ error: "Email and message required" });
    }

    feedbacks.push({ email, message, timestamp: new Date().toISOString() });

    // Forward to FormSubmit (optional)
    try {
      await fetch(FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, message })
      });
    } catch (fetchErr) {
      console.log("FormSubmit forwarding skipped:", fetchErr.message);
    }

    res.json({ success: true, message: "Feedback received" });
  } catch (err) {
    console.error("Feedback error:", err);
    res.status(500).json({ error: "Failed to send feedback" });
  }
});

// Catch‑all – serve frontend (for client‑side routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= ERROR HANDLING =================
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📧 Contact: ${CONTACT_EMAIL}`);
  console.log(`🚚 Shipping fee: ₹${REGULAR_SHIPPING_FEE}`);
  console.log(`🔑 Admin passcode: ${ADMIN_PASSCODE}`);
});