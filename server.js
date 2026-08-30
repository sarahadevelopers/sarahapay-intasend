// =============================================
// INTASEND PAYMENT ROUTER – Multi-Site Support
// =============================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dns = require('dns'); // for DNS test
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── CORS ──────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// ─── MongoDB Connection with Timeouts ────────────────────────
const mongoOptions = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
};

mongoose.connect(process.env.MONGO_URI, mongoOptions)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// ─── IntaSend SDK Setup ──────────────────────────────────────
// ─── IntaSend SDK Setup ──────────────────────────────────────
const Intasend = require('intasend-node');
const intasend = new Intasend(
  process.env.INTASEND_API_KEY,         // ← Use INTASEND_API_KEY
  process.env.INTASEND_PUBLIC_KEY,      // ← Use INTASEND_PUBLIC_KEY
  process.env.INTASEND_ENVIRONMENT || 'production'
);

// ─── Transaction Schema ──────────────────────────────────────
const transactionSchema = new mongoose.Schema({
  userId: String,
  plan: { type: String, enum: ['basic', 'pro', 'developer'] },
  phone: String,
  amount: Number,
  status: { type: String, default: 'pending' },
  checkoutId: String,
  mpesaReceipt: String,
  transactionRef: String,
  website: { type: String, default: 'rentspace' },
  callbackUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', transactionSchema);

// ─── Subscription Plans ──────────────────────────────────────
const PLANS = {
  basic: { name: 'Basic', price: 2, listings: 20 },
  pro: { name: 'Pro', price: 5, listings: Infinity },
  developer: { name: 'Developer', price: 10, listings: Infinity }
};

// ═════════════════════════════════════════════════════════════
//  DIAGNOSTIC ENDPOINTS
// ═════════════════════════════════════════════════════════════

// 1. Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'intasend-server' });
});

// 2. DNS resolution test (checks if Render can resolve MongoDB hostnames)
app.get('/api/dns-test', (req, res) => {
  const hostname = 'ac-gzcc1u0-shard-00-00.mqrczsc.mongodb.net';
  dns.resolve(hostname, (err, addresses) => {
    if (err) {
      return res.status(500).json({ status: 'error', message: err.message });
    }
    res.json({ status: 'ok', addresses });
  });
});

// 3. Mongoose connection state check
app.get('/api/db-test', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        status: 'error',
        message: 'MongoDB not connected yet. Current state: ' + mongoose.connection.readyState
      });
    }
    await mongoose.connection.db.admin().ping();
    res.json({ status: 'ok', message: 'MongoDB connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Subscription Plans ──────────────────────────────────────
app.get('/api/subscriptions/plans', (req, res) => {
  res.json(PLANS);
});

// ─── Initiate STK Push ──────────────────────────────────────
app.post('/api/pay', async (req, res) => {
  try {
    const { phone, plan, userId, website, callbackUrl } = req.body;

    if (!phone || !plan || !PLANS[plan]) {
      return res.status(400).json({ error: 'Phone number and valid plan required' });
    }
    if (!callbackUrl) {
      return res.status(400).json({ error: 'callbackUrl is required' });
    }

    const amount = PLANS[plan].price;
    const transactionRef = `RENT-${uuidv4().slice(0, 8)}`;

    // ── Create transaction record ─────────────────────────────
    const tx = new Transaction({
      userId: userId || 'unknown',
      plan,
      phone,
      amount,
      transactionRef,
      website: website || 'rentspace',
      callbackUrl,
      status: 'pending'
    });
    await tx.save();

    // ── Initiate STK push via IntaSend ────────────────────────
    const response = await intasend.collections.mpesaStkPush({
      first_name: 'RentSpace',
      phone_number: phone,
      email: 'customer@rentspace.co.ke',
      amount: amount,
      currency: 'KES',
      reference: transactionRef,
      description: `RentSpace ${plan} subscription`
    });

    const checkoutId = response.id || response.checkout_id;
    if (checkoutId) {
      tx.checkoutId = checkoutId;
      await tx.save();
    }

    console.log('📤 IntaSend STK response:', response);

    res.json({
      success: true,
      message: 'STK push sent. Check your phone.',
      transactionRef,
      checkoutId,
      transactionId: tx._id
    });

  } catch (error) {
    console.error('❌ STK Push error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to initiate payment',
      details: error.response?.data || error.message
    });
  }
});

// ─── IntaSend Webhook Handler ──────────────────────────────
app.post('/api/subscriptions/intasend-webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('📥 Webhook received:', JSON.stringify(payload, null, 2));

    const { id, state, reference, mpesa_receipt_number, status } = payload;

    const tx = await Transaction.findOne({
      $or: [
        { checkoutId: id },
        { transactionRef: reference }
      ]
    });

    if (!tx) {
      console.warn(`⚠️ No transaction found for id: ${id} or ref: ${reference}`);
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const isSuccess = state === 'completed' || status === 'success';

    if (isSuccess) {
      tx.status = 'completed';
      tx.mpesaReceipt = mpesa_receipt_number;
      tx.updatedAt = new Date();
      await tx.save();

      console.log(`✅ Payment confirmed for transaction ${tx.transactionRef}`);

      // ⭐⭐⭐ CALL THE WEBSITE'S CALLBACK URL ⭐⭐⭐
      try {
        await axios.post(tx.callbackUrl, {
          transactionRef: tx.transactionRef,
          userId: tx.userId,
          plan: tx.plan,
          status: 'completed',
          mpesaReceipt: tx.mpesaReceipt,
          amount: tx.amount,
          phone: tx.phone
        }, { timeout: 10000 });
        console.log(`✅ Notified ${tx.website} (${tx.callbackUrl})`);
      } catch (callbackErr) {
        console.error(`❌ Failed to notify ${tx.website}:`, callbackErr.message);
        // Don't re-throw; respond 200 to IntaSend anyway
      }

    } else {
      tx.status = 'failed';
      tx.updatedAt = new Date();
      await tx.save();
      console.log(`❌ Payment failed for transaction ${tx.transactionRef}`);
    }

    res.status(200).send('OK');

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─── Get Transaction Status ──────────────────────────────────
app.get('/api/transaction/:ref', async (req, res) => {
  try {
    const tx = await Transaction.findOne({ transactionRef: req.params.ref });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json(tx);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 IntaSend server running on port ${PORT}`);
});