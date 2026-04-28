// ================= IMPORTS =================
const express = require("express");
const cors    = require("cors");
const path    = require("path");
require("dotenv").config({ path: "./.env" });

const Razorpay = require("razorpay");
const crypto   = require("crypto");

// ================= ENV VALIDATION =================
// These MUST be set in Render's environment variables dashboard.
// If any are missing the server crashes on startup with a clear message
// rather than silently using wrong values.
const REQUIRED_ENV = ["RAZORPAY_KEY_ID", "RAZORPAY_SECRET", "ADMIN_PASSCODE"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error("Missing required environment variables:", missing.join(", "));
  console.error("Set them in Render > Environment > Add Environment Variable");
  process.exit(1);
}

// ================= ENV VARIABLES =================
const ADMIN_PASSCODE       = process.env.ADMIN_PASSCODE;
const RAZORPAY_KEY_ID      = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_SECRET      = process.env.RAZORPAY_SECRET;
const REGULAR_SHIPPING_FEE = parseInt(process.env.REGULAR_SHIPPING_FEE) || 70;
const CONTACT_EMAIL        = process.env.CONTACT_EMAIL     || "iyervalfoods@gmail.com";
const FEEDBACK_ENDPOINT    = process.env.FEEDBACK_ENDPOINT || "https://formsubmit.co/ajax/iyervalfoods@gmail.com";

// ================= APP SETUP =================
const app = express();

app.use(cors({
  origin: [
    "https://iyerval-backend.onrender.com",
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ],
  methods: ["GET", "POST"],
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ================= RAZORPAY SETUP =================
const razorpay = new Razorpay({
  key_id:     RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_SECRET
});

// ================= IN-MEMORY STORAGE =================
const orders    = [];
const feedbacks = [];

// ================= ROUTES =================

// Health check
app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    timestamp: new Date().toISOString(),
    orders:    orders.length,
    feedbacks: feedbacks.length
  });
});

// Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Config - safe public data for frontend
app.get("/config", (req, res) => {
  res.json({
    shippingFee:  REGULAR_SHIPPING_FEE,
    contactEmail: CONTACT_EMAIL,
    razorpayKey:  RAZORPAY_KEY_ID
  });
});

// ============================================================
//   RAZORPAY BLOCK
// ============================================================
//
//   AMOUNT FLOW:
//   Frontend  sends amount in RUPEES        e.g. 270
//   Backend   converts to PAISE x100        e.g. 27000
//   Razorpay  returns order.amount in PAISE e.g. 27000
//   Frontend  passes data.amount directly to Razorpay checkout
//             DO NOT multiply by 100 again on the frontend
//
// ============================================================

// 1. Create Razorpay Order
app.post("/create-order", async (req, res) => {
  try {
    const rupees = parseFloat(req.body.amount);

    if (!isFinite(rupees) || rupees < 1) {
      return res.status(400).json({ error: "Invalid amount. Must be a number >= 1 (in rupees)." });
    }

    const order = await razorpay.orders.create({
      amount:   Math.round(rupees * 100),
      currency: "INR",
      receipt:  "rcpt_" + Date.now()
    });

    res.json(order);

  } catch (err) {
    console.error("Razorpay create-order error:", err);
    res.status(500).json({ error: "Payment initiation failed. Please try again." });
  }
});

// 2. Verify Payment Signature
app.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment fields." });
    }

    const expected = crypto
      .createHmac("sha256", RAZORPAY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expected === razorpay_signature) {
      res.json({ success: true });
    } else {
      console.warn("Razorpay signature mismatch");
      res.status(400).json({ success: false, message: "Invalid payment signature." });
    }

  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ success: false, error: "Verification failed." });
  }
});

// ============================================================

// Save Order
app.post("/save-order", async (req, res) => {
  try {
    const orderData = {
      ...req.body,
      orderId:   "IYER" + Date.now().toString().slice(-8),
      timestamp: new Date().toISOString(),
      status:    "pending"
    };

    orders.unshift(orderData);

    const message     = `New Order!\n----------\n${orderData.orderId}\n${orderData.name}\n${orderData.phone}\n${orderData.address}\nTotal: Rs.${orderData.total}\n\nItems: ${orderData.items.map(i => `${i.name} x${i.quantity}`).join(", ")}`;
    const whatsappURL = `https://wa.me/918848636679?text=${encodeURIComponent(message)}`;

    res.json({ success: true, orderId: orderData.orderId, whatsappURL });

  } catch (err) {
    console.error("save-order error:", err);
    res.status(500).json({ error: "Failed to save order." });
  }
});

// Admin - get orders
app.post("/admin/orders", (req, res) => {
  const { passcode } = req.body;
  if (passcode === ADMIN_PASSCODE) {
    res.json({ success: true, orders });
  } else {
    res.status(401).json({ success: false, message: "Invalid passcode" });
  }
});

// Admin - update order status
app.post("/admin/update-order", (req, res) => {
  const { passcode, orderId, status } = req.body;
  if (passcode !== ADMIN_PASSCODE) return res.status(401).json({ success: false });

  const order = orders.find(o => o.orderId === orderId);
  if (order) {
    order.status = status;
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, message: "Order not found" });
  }
});

// Admin - delete order
app.post("/admin/delete-order", (req, res) => {
  const { passcode, orderId } = req.body;
  if (passcode !== ADMIN_PASSCODE) return res.status(401).json({ success: false });

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

    try {
      await fetch(FEEDBACK_ENDPOINT, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email, message })
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

// Catch-all - serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================= ERROR HANDLING =================
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Contact: ${CONTACT_EMAIL}`);
  console.log(`Shipping fee: Rs.${REGULAR_SHIPPING_FEE}`);
  console.log(`Razorpay key: ${RAZORPAY_KEY_ID}`);
});
