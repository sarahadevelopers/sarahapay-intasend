// =============================================
// INTASEND PAYMENT SERVER – Fixed for STK Push
// =============================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ──────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// ─── MongoDB Connection ──────────────────────
const mongoOptions = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
};

mongoose.connect(process.env.MONGO_URI, mongoOptions)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// ─── IntaSend SDK Setup ──────────────────────
// Using the official 'intasend-node' package
const Intasend = require('intasend-node');

// The constructor expects: (apiKey, publicKey, environment)
const intasend = new Intasend(
  process.env.INTASEND_API_KEY,
  process.env.INTASEND_PUBLIC_KEY,
  process.env.INTASEND_ENVIRONMENT || 'production'
);

// ─── Transaction Schema ──────────────────────
const transactionSchema = new mongoose.Schema({
  userId: { type: String, default: 'unknown' },
  plan: { type: String, enum: ['basic', 'pro', 'developer', 'custom'], default: 'basic' },
  phone: String,
  amount: Number,
  status: { type: String, default: 'pending' }, // pending | completed | failed
  checkoutId: String,
  mpesaReceipt: String,
  transactionRef: String,
  website: { type: String, default: 'sarahapay' },
  callbackUrl: { type: String, default: '' }, // now optional
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', transactionSchema);

// ─── Subscription Plans ──────────────────────
const PLANS = {
  basic: { name: 'Basic', price: 2 },
  pro: { name: 'Pro', price: 5 },
  developer: { name: 'Developer', price: 10 },
  // you can add a custom plan
};

// ═════════════════════════════════════════════
//  ENDPOINTS
// ═════════════════════════════════════════════

// ─── Health check ────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'intasend-server' });
});

// ─── List all plans ──────────────────────────
app.get('/api/subscriptions/plans', (req, res) => {
  res.json(PLANS);
});

// ─── GET all transactions (for admin panel) ──
app.get('/api/transactions', async (req, res) => {
  try {
    const txs = await Transaction.find().sort({ createdAt: -1 }).limit(100);
    res.json(txs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ─── GET a single transaction by ref ─────────
app.get('/api/transaction/:ref', async (req, res) => {
  try {
    const tx = await Transaction.findOne({ transactionRef: req.params.ref });
    if (!tx) return res.status(404).json({ error: 'Not found' });
    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch' });
  }
});

// ─── Initiate STK Push ──────────────────────
app.post('/api/pay', async (req, res) => {
  try {
    const { phone, plan, userId, website, callbackUrl, amount } = req.body;

    // Validate phone
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Determine amount: if 'amount' is provided, use it; else use plan's price
    let finalAmount = amount;
    let planName = plan || 'basic';
    if (!finalAmount) {
      if (!PLANS[planName]) {
        return res.status(400).json({ error: 'Invalid plan or amount missing' });
      }
      finalAmount = PLANS[planName].price;
    }

    // Generate unique transaction reference
    const transactionRef = `PAY-${uuidv4().slice(0, 8).toUpperCase()}`;

    // Create transaction record (callbackUrl optional)
    const tx = new Transaction({
      userId: userId || 'unknown',
      plan: planName,
      phone,
      amount: finalAmount,
      transactionRef,
      website: website || 'sarahapay',
      callbackUrl: callbackUrl || '',
      status: 'pending'
    });
    await tx.save();

    // ── Call IntaSend STK Push ──────────────
    // The SDK method: intasend.collections.mpesaStkPush(params)
    const response = await intasend.collections.mpesaStkPush({
      first_name: 'Sarahapay',
      phone_number: phone,          // must be 254XXXXXXXXX
      email: 'customer@sarahapay.com',
      amount: finalAmount,
      currency: 'KES',
      reference: transactionRef,
      description: `Payment for ${planName} plan`
    });

    // Extract checkout ID from response
    const checkoutId = response.id || response.checkout_id;
    if (checkoutId) {
      tx.checkoutId = checkoutId;
      await tx.save();
    }

    console.log('📤 IntaSend STK response:', JSON.stringify(response, null, 2));

    // If IntaSend returned an error (some responses include a 'status' field)
    if (response.status && response.status !== 'success') {
      // It might be a failure response
      tx.status = 'failed';
      await tx.save();
      return res.status(400).json({
        error: 'STK push failed',
        details: response.message || 'Unknown error'
      });
    }

    // Success
    res.json({
      success: true,
      message: 'STK push sent. Check your phone.',
      transactionRef,
      checkoutId,
      transactionId: tx._id
    });

  } catch (error) {
    console.error('❌ STK Push error:', error.response?.data || error.message);
    // Log full error for debugging
    if (error.response) {
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({
      error: 'Failed to initiate payment',
      details: error.response?.data || error.message
    });
  }
});

// ─── IntaSend Webhook Handler ───────────────
app.post('/api/subscriptions/intasend-webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('📥 Webhook received:', JSON.stringify(payload, null, 2));

    const { id, state, reference, mpesa_receipt_number, status } = payload;

    // Find transaction by checkoutId or transactionRef
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

      // ── Notify the callback URL (if provided) ──
      if (tx.callbackUrl) {
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
          console.log(`✅ Notified ${tx.callbackUrl}`);
        } catch (callbackErr) {
          console.error(`❌ Failed to notify callback:`, callbackErr.message);
        }
      } else {
        console.log('ℹ️ No callback URL set, skipping notification.');
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

// ─── (Optional) Test endpoint to verify credentials ──
app.get('/api/test-credentials', async (req, res) => {
  try {
    // Make a minimal STK push to a test number (maybe your own)
    // but we don't want to spam, so just return the SDK status.
    res.json({ message: 'Credentials seem loaded. Try a real payment.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 IntaSend server running on port ${PORT}`);
});