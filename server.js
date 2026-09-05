require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;

// =============================================
// 1. MongoDB Connection
// =============================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// =============================================
// 2. Transaction Schema
// =============================================
const transactionSchema = new mongoose.Schema({
    name: String,
    phone: String,
    amount: String,
    status: { type: String, default: "PENDING" },
    checkout_id: String,          // IntaSend checkout ID (from initiation)
    mpesa_receipt: String,
    retryCount: { type: Number, default: 0 },
    lastRetryAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model("Transaction", transactionSchema);

// =============================================
// 3. Middleware – CORS + Body Parser
// =============================================
const allowedOrigins = [
    'https://rentspace.co.ke',
    'https://www.rentspace.co.ke',
    'https://sarahadevelopers.github.io',
    'http://localhost:3000',
    'https://sarahapay-intasend.onrender.com'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// =============================================
// 4. Security Middleware
// =============================================
const VALID_SECRETS = [
    process.env.API_SECRET,
].filter(Boolean);

const checkSecret = (req, res, next) => {
    const secret = req.headers['x-api-secret'];

    if (!secret) {
        console.warn('❌ Missing API secret header');
        return res.status(403).json({ error: "Missing API secret" });
    }

    if (!VALID_SECRETS.includes(secret)) {
        console.warn(`❌ Invalid API secret: ${secret.substring(0, 10)}...`);
        return res.status(403).json({ error: "Unauthorized" });
    }

    next();
};

// Global rate limit
let globalRequestCount = 0;
let globalWindowStart = Date.now();
const GLOBAL_MAX = 50;
const GLOBAL_WINDOW = 60 * 1000;

const globalRateLimit = (req, res, next) => {
    const now = Date.now();
    if (now - globalWindowStart > GLOBAL_WINDOW) {
        globalRequestCount = 0;
        globalWindowStart = now;
    }
    globalRequestCount++;
    if (globalRequestCount > GLOBAL_MAX) {
        return res.status(429).json({ error: "Global request limit reached. Please try again later." });
    }
    next();
};

// Apply middleware
app.use('/api/pay', checkSecret);
app.use('/api/retry-payment', checkSecret);
app.use('/api/pay', globalRateLimit);
app.use('/api/retry-payment', globalRateLimit);

// IP blocking
const violationStore = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of violationStore.entries()) {
        if (data.blockUntil && data.blockUntil < now) {
            violationStore.delete(ip);
        } else if (!data.blockUntil && (now - data.firstViolationTime) > 3600000) {
            violationStore.delete(ip);
        }
    }
}, 60000);

const checkBlocked = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const data = violationStore.get(ip);
    if (data && data.blockUntil && data.blockUntil > now) {
        return res.status(403).json({
            error: `Your IP is temporarily blocked due to excessive failed attempts. Try again after ${Math.ceil((data.blockUntil - now) / 60000)} minutes.`
        });
    }
    next();
};

const paymentLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    message: { error: "Too many payment requests from this IP. Please wait 5 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        const data = violationStore.get(ip) || { count: 0, firstViolationTime: now, blockUntil: null };
        data.count += 1;
        if (data.count >= 3) {
            data.blockUntil = now + 3600000;
            violationStore.set(ip, data);
            res.status(429).json({
                error: "Too many failed payment attempts. Your IP has been blocked for 1 hour."
            });
        } else {
            violationStore.set(ip, data);
            res.status(429).json({
                error: "Too many payment requests from this IP. Please wait 5 minutes."
            });
        }
    }
});

app.use('/api/pay', checkBlocked, paymentLimiter);
app.use('/api/retry-payment', checkBlocked, paymentLimiter);

// =============================================
// 5. Root Route (API info)
// =============================================
app.get("/", (req, res) => {
    res.send("sarahapay API Running – IntaSend Express");
});

// =============================================
// 6. Health Check Endpoint
// =============================================
app.get("/api/health", (req, res) => {
    res.json({ status: 'ok', service: 'intasend-server' });
});

// =============================================
// 7. IntaSend Configuration
// =============================================
const INTASEND_API_KEY = process.env.INTASEND_API_KEY;
const INTASEND_API_URL = process.env.INTASEND_API_URL || 'https://api.intasend.com/api/v1/payment/mpesa-stk-push/';

console.log(`📍 IntaSend API URL: ${INTASEND_API_URL}`);

// =============================================
// 8. Helper: Initiate STK Push (IntaSend)
// =============================================
async function initiateStkPush(name, phone, amount, retryCount = 0) {
    // Normalize phone number to 254XXXXXXXXX
    let formattedPhone = phone
        .replace(/\s+/g, '')
        .replace(/^\+/, '')
        .replace(/^0/, '254');

    if (!formattedPhone.startsWith('254')) {
        formattedPhone = '254' + formattedPhone;
    }

    const apiRef = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const payload = {
        phone_number: formattedPhone,
        amount: parseFloat(amount).toFixed(2),
        api_ref: apiRef,
        purpose: `Payment from ${name || 'Sarahapay'}`,
        email: process.env.INTASEND_EMAIL || 'customer@sarahapay.com',
        first_name: name || 'Sarahapay'
    };

    console.log("📤 IntaSend STK Request:", {
        phone: payload.phone_number,
        amount: payload.amount,
        api_ref: payload.api_ref
    });

    try {
        const response = await axios.post(INTASEND_API_URL, payload, {
            headers: {
                'Authorization': `Bearer ${INTASEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log("📥 IntaSend Response:", response.data);

        const data = response.data;

        if (data.status && data.status !== 'success') {
            throw new Error(data.message || 'IntaSend STK push failed');
        }

        // The initiation response may have 'id' or 'invoice_id' or 'checkout_id'
        const checkoutId = data.id || data.invoice_id || data.checkout_id || data.checkoutId || null;

        if (!checkoutId) {
            throw new Error('No checkout ID returned from IntaSend');
        }

        const tx = new Transaction({
            name: name || 'IntaSend Payment',
            phone: formattedPhone,
            amount: parseFloat(amount).toFixed(2),
            checkout_id: checkoutId,
            retryCount: retryCount,
            lastRetryAt: new Date()
        });
        await tx.save();

        return tx;

    } catch (error) {
        if (error.response) {
            console.error("❌ IntaSend API error:", error.response.status, error.response.data);
            throw new Error(error.response.data?.message || error.response.data?.detail || 'IntaSend API error');
        }
        throw error;
    }
}

// =============================================
// 9. Initiate Payment Endpoint
// =============================================
app.post("/api/pay", async (req, res) => {
    try {
        const { name, phone, amount } = req.body;
        if (!name || !phone || !amount) {
            return res.status(400).json({ error: "Name, phone and amount required" });
        }

        let formattedPhone = phone
            .replace(/\s+/g, '')
            .replace(/^\+/, '')
            .replace(/^0/, '254');

        const lastTx = await Transaction.findOne({ phone: formattedPhone })
            .sort({ createdAt: -1 });

        if (lastTx && lastTx.status === "PENDING") {
            const secondsSince = (Date.now() - new Date(lastTx.createdAt).getTime()) / 1000;
            if (secondsSince > 30) {
                await Transaction.updateOne(
                    { _id: lastTx._id },
                    { status: "FAILED" }
                );
                console.log(`Auto‑cleaned stale pending transaction ${lastTx._id} after 30s`);
            } else {
                return res.status(409).json({
                    error: "You already have a pending payment. Please wait or check your phone."
                });
            }
        }

        if (lastTx && (lastTx.status === "FAILED" || lastTx.status === "CANCELLED")) {
            const retryCount = lastTx.retryCount || 0;
            const secondsSinceLast = (Date.now() - new Date(lastTx.lastRetryAt || lastTx.createdAt).getTime()) / 1000;

            if (retryCount >= 5) {
                if (secondsSinceLast < 30) {
                    return res.status(429).json({
                        error: `Too many failed attempts (${retryCount}). Please wait ${Math.ceil(30 - secondsSinceLast)} seconds before trying again.`
                    });
                } else {
                    await Transaction.updateOne({ _id: lastTx._id }, { retryCount: 0 });
                }
            }
        }

        const tx = await initiateStkPush(name, formattedPhone, amount, lastTx?.retryCount || 0);
        res.status(201).json({
            message: "STK Push Sent",
            transactionId: tx._id
        });

    } catch (error) {
        console.error("STK Push Error:", error.message);
        res.status(500).json({
            error: "Failed to initiate payment",
            details: error.message
        });
    }
});

// =============================================
// 10. Retry Payment Endpoint
// =============================================
app.post("/api/retry-payment", async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ error: "Phone number required" });
        }

        let formattedPhone = phone
            .replace(/\s+/g, '')
            .replace(/^\+/, '')
            .replace(/^0/, '254');

        const lastTx = await Transaction.findOne({
            phone: formattedPhone,
            status: { $in: ["PENDING", "FAILED", "CANCELLED"] }
        }).sort({ createdAt: -1 });

        if (!lastTx) {
            return res.status(404).json({ error: "No failed or pending transaction found to retry" });
        }

        const retryCount = lastTx.retryCount || 0;
        const secondsSinceLast = (Date.now() - new Date(lastTx.lastRetryAt || lastTx.createdAt).getTime()) / 1000;

        if (retryCount >= 5) {
            if (secondsSinceLast < 30) {
                return res.status(429).json({
                    error: `Retry limit reached (${retryCount}). Please wait ${Math.ceil(30 - secondsSinceLast)} seconds before trying again.`
                });
            } else {
                await Transaction.updateOne({ _id: lastTx._id }, { retryCount: 0 });
            }
        }

        await Transaction.updateOne(
            { _id: lastTx._id },
            { status: "FAILED", lastRetryAt: new Date() }
        );

        const newTx = await initiateStkPush(
            lastTx.name,
            formattedPhone,
            lastTx.amount,
            retryCount + 1
        );

        res.status(201).json({
            message: "Retry initiated. Check your phone for the M-PESA prompt.",
            transactionId: newTx._id,
            retryCount: retryCount + 1
        });

    } catch (error) {
        console.error("Retry payment error:", error);
        res.status(500).json({
            error: "Failed to retry payment",
            details: error.message
        });
    }
});

// =============================================
// 11. Fetch Transactions
// =============================================
app.get("/api/transactions", async (req, res) => {
    try {
        const transactions = await Transaction.find().sort({ createdAt: -1 });
        res.json(transactions);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch transactions" });
    }
});

// =============================================
// 12. Get Single Transaction by ID
// =============================================
app.get("/api/transaction/:id", async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);
        if (!transaction) {
            return res.status(404).json({ error: "Transaction not found" });
        }
        res.json(transaction);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch transaction" });
    }
});

// =============================================
// 13. IntaSend Webhook (Callback) – FIXED
// =============================================
app.post("/callback", async (req, res) => {
    console.log("========================================");
    console.log("🔔 INTASEND CALLBACK RECEIVED");
    console.log("📌 Headers:", req.headers);
    console.log("📌 Body:", req.body);
    console.log("========================================");

    // Always respond with 200 to acknowledge receipt
    res.sendStatus(200);

    // Process asynchronously
    (async () => {
        try {
            const payload = req.body;

            // --- Extract fields from IntaSend's actual payload ---
            const invoiceId = payload.invoice_id;
            const state = payload.state || payload.status;
            const mpesaReceipt = payload.mpesa_reference || payload.mpesa_receipt_number || payload.receipt || payload.transaction_receipt;
            const transactionRef = payload.api_ref || payload.reference || payload.transactionRef;
            const phone = payload.account || payload.phone;
            const amount = payload.value || payload.amount;

            console.log(`📊 Status: ${state}, Invoice ID: ${invoiceId}, Receipt: ${mpesaReceipt}`);

            // --- Find the transaction ---
            let transaction = null;

            // 1. Try by invoice_id (most reliable from callback)
            if (invoiceId) {
                transaction = await Transaction.findOne({ checkout_id: invoiceId });
                if (transaction) console.log(`✅ Found by invoice_id: ${invoiceId}`);
            }

            // 2. Try by api_ref (our custom reference)
            if (!transaction && transactionRef) {
                transaction = await Transaction.findOne({ checkout_id: transactionRef });
                if (transaction) console.log(`✅ Found by api_ref: ${transactionRef}`);
            }

            // 3. Fallback: phone + amount
            if (!transaction && phone && amount) {
                transaction = await Transaction.findOne({
                    phone: phone,
                    amount: String(amount)
                }).sort({ createdAt: -1 });
                if (transaction) console.log(`✅ Found by phone + amount: ${phone} / ${amount}`);
            }

            // 4. Broad search using any ID-like field
            if (!transaction) {
                const ids = [invoiceId, transactionRef, payload.id, payload.checkout_id].filter(Boolean);
                if (ids.length > 0) {
                    transaction = await Transaction.findOne({
                        $or: ids.map(id => ({ checkout_id: id }))
                    });
                    if (transaction) console.log(`✅ Found by broad search`);
                }
            }

            if (!transaction) {
                console.error(`❌ No transaction found for invoice_id: ${invoiceId} or api_ref: ${transactionRef}`);
                return;
            }

            // --- Determine status ---
            let status = 'FAILED';
            if (state === 'COMPLETE' || state === 'completed' || state === 'success' || state === 'SUCCESS' || state === 'COMPLETED') {
                status = 'SUCCESS';
            } else if (state === 'pending' || state === 'PENDING') {
                status = 'PENDING';
            }

            // --- Update transaction ---
            transaction.status = status;
            if (mpesaReceipt) {
                transaction.mpesa_receipt = mpesaReceipt;
            }
            // Update checkout_id if it was stored as something else (e.g., api_ref)
            if (invoiceId && transaction.checkout_id !== invoiceId) {
                transaction.checkout_id = invoiceId;
            }
            await transaction.save();
            console.log(`✅ Transaction ${transaction._id} updated to ${status}`);

            // --- Forward on success ---
            if (status === 'SUCCESS') {
                const callbackPayload = {
                    checkout_id: transaction.checkout_id,
                    status: 'paid',
                    mpesa_receipt: mpesaReceipt || transaction.mpesa_receipt,
                    amount: transaction.amount,
                    phone: transaction.phone,
                    name: transaction.name,
                    reference: transactionRef || transaction._id.toString()
                };

                const RENTSPACE_WEBHOOK_URL = process.env.RENTSPACE_WEBHOOK_URL || 'https://rentspace-markeplace.onrender.com/api/subscriptions/saraha-webhook';
                try {
                    await axios.post(RENTSPACE_WEBHOOK_URL, callbackPayload, { timeout: 5000 });
                    console.log(`✅ Forwarded callback to RentSpace: ${RENTSPACE_WEBHOOK_URL}`);
                } catch (err) {
                    console.error('❌ Failed to forward callback to RentSpace:', err.message);
                }
            }
        } catch (err) {
            console.error("❌ Error processing callback:", err);
        }
    })();
});

// =============================================
// 14. Alias for IntaSend webhook (backward compatibility)
// =============================================
app.post('/api/subscriptions/intasend-webhook', async (req, res) => {
    // Forward to the /callback handler
    req.url = '/callback';
    app._router.handle(req, res);
});

// =============================================
// 15. Static files (served LAST)
// =============================================
app.use(express.static("docs"));

// =============================================
// 16. Start Server
// =============================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});