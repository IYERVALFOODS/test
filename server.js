// ================= IMPORTS =================
const express = require("express");
const cors    = require("cors");
const path    = require("path");
require("dotenv").config({ path: "./.env" });

const Razorpay = require("razorpay");
const crypto   = require("crypto");

// ================= ENV VALIDATION =================
const REQUIRED_ENV = ["RAZORPAY_KEY_ID", "RAZORPAY_SECRET", "ADMIN_PASSCODE"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing required environment variables:", missing.join(", "));
  console.error("Please set them in Render Dashboard > Environment Variables");
  process.exit(1);
}

// ================= ENV VARIABLES =================
const ADMIN_PASSCODE       = process.env.ADMIN_PASSCODE;
const RAZORPAY_KEY_ID      = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_SECRET      = process.env.RAZORPAY_SECRET;
const REGULAR_SHIPPING_FEE = parseInt(process.env.REGULAR_SHIPPING_FEE) || 70;
const CONTACT_EMAIL        = process.env.CONTACT_EMAIL     || "iyervalfoods@gmail.com";
const FEEDBACK_ENDPOINT    = process.env.FEEDBACK_ENDPOINT || "https://formsubmit.co/ajax/iyervalfoods@gmail.com";

// Google Apps Script web app URL
const SHEETS_ENDPOINT = process.env.GOOGLE_SHEET_URL || "https://script.google.com/macros/s/AKfycbwP1vGnwT-tmMcmUpvu8syqD8yt8im4LG3ziBv9NGL_WSeb-jssPlS9un_M3ALzNJjh/exec";

// ================= APP SETUP =================
const app = express();

// CORS configuration
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods:     ["GET", "POST"],
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
//   RAZORPAY ORDER CREATION
// ============================================================
app.post("/create-order", async (req, res) => {
  try {
    const rupees = parseFloat(req.body.amount);

    // Validate amount
    if (isNaN(rupees) || !isFinite(rupees) || rupees < 1) {
      return res.status(400).json({ 
        error: "Invalid amount. Amount must be at least ₹1." 
      });
    }

    const amountInPaise = Math.round(rupees * 100);
    
    console.log(`Creating Razorpay order: ₹${rupees} (${amountInPaise} paise)`);

    const order = await razorpay.orders.create({
      amount:   amountInPaise,
      currency: "INR",
      receipt:  "rcpt_" + Date.now()
    });

    console.log(`✅ Order created: ${order.id}`);
    res.json(order);

  } catch (err) {
    console.error("❌ Razorpay create-order error:", err);
    // Send detailed error for debugging (but not exposing secrets)
    res.status(500).json({ 
      error: err.error?.description || err.message || "Payment initiation failed. Please try again."
    });
  }
});

// ============================================================
//   VERIFY PAYMENT SIGNATURE
// ============================================================
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
      console.log(`✅ Payment verified: ${razorpay_payment_id}`);
      res.json({ success: true });
    } else {
      console.warn(`⚠️ Signature mismatch for order: ${razorpay_order_id}`);
      res.status(400).json({ success: false, message: "Invalid payment signature." });
    }

  } catch (err) {
    console.error("❌ verify-payment error:", err);
    res.status(500).json({ success: false, error: "Verification failed." });
  }
});

// ============================================================
//   SAVE ORDER
// ============================================================
app.post("/save-order", async (req, res) => {
  try {
    const orderData = {
      ...req.body,
      orderId:   "IYER" + Date.now().toString().slice(-8),
      timestamp: new Date().toISOString(),
      status:    "pending"
    };

    orders.unshift(orderData);

    // Fire-and-forget to Google Sheets
    fetch(SHEETS_ENDPOINT, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(orderData)
    }).catch(err => console.error("Google Sheets sync failed:", err.message));

    const message     = `New Order!\n----------\n${orderData.orderId}\n${orderData.name}\n${orderData.phone}\n${orderData.address}\nTotal: Rs.${orderData.total}\n\nItems: ${orderData.items.map(i => `${i.name} x${i.quantity}`).join(", ")}`;
    const whatsappURL = `https://wa.me/918848636679?text=${encodeURIComponent(message)}`;

    res.json({ success: true, orderId: orderData.orderId, whatsappURL });

  } catch (err) {
    console.error("❌ save-order error:", err);
    res.status(500).json({ error: "Failed to save order." });
  }
});

// Admin routes
app.post("/admin/orders", (req, res) => {
  const { passcode } = req.body;
  if (passcode === ADMIN_PASSCODE) {
    res.json({ success: true, orders });
  } else {
    res.status(401).json({ success: false, message: "Invalid passcode" });
  }
});

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
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Contact: ${CONTACT_EMAIL}`);
  console.log(`🚚 Shipping fee: Rs.${REGULAR_SHIPPING_FEE}`);
  console.log(`🔑 Razorpay key: ${RAZORPAY_KEY_ID}`);
});
