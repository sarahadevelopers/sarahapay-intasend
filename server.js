require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('qs');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;

/* -------------------------------
   1. MongoDB Connection
-------------------------------- */
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.error("MongoDB Error:", err));

/* -------------------------------
   2. Transaction Schema (with retry fields)
-------------------------------- */
const transactionSchema = new mongoose.Schema({
    name: String,
    phone: String,
    amount: String,
    status: { type: String, default: "PENDING" },
    checkout_id: String,
    mpesa_receipt: String,
    retryCount: { type: Number, default: 0 },
    lastRetryAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model("Transaction", transactionSchema);

/* -------------------------------
   3. Middleware (CORS, JSON, Static) – with allowed origins
-------------------------------- */

// ---------- Allowed domains (CORS) ----------
// ---------- Allowed domains (CORS) ----------
const allowedOrigins = [
    'https://bingwasoko.co.ke',
    'https://www.bingwasoko.co.ke',
    'https://datasokoni.com',
    'https://www.datasokoni.com',
    'https://fineescorts.co.ke',
    'https://www.fineescorts.co.ke',
    'https://sarahadevelopers.github.io', // GitHub Pages
    'http://localhost:3000'               // local testing
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));



app.use(express.json());
app.use(express.static("docs"));

// ---------- SHARED SECRET CHECK (for both payment endpoints) ----------
const checkSecret = (req, res, next) => {
    const secret = req.headers['x-api-secret'];
    if (secret !== process.env.API_SECRET) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
};

// ---------- reCAPTCHA VERIFICATION (for payment endpoints) ----------
const verifyRecaptcha = async (req, res, next) => {
    const token = req.headers['x-recaptcha-token'];
    if (!token) {
        return res.status(400).json({ error: "Missing reCAPTCHA token" });
    }

    try {
        const verification = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            null,
            {
                params: {
                    secret: process.env.RECAPTCHA_SECRET,
                    response: token
                },
                timeout: 5000
            }
        );

        const { success, score } = verification.data;
        if (!success || score < 0.5) {
            console.log(`reCAPTCHA failed: success=${success}, score=${score}`);
            return res.status(403).json({ error: "Bot detected. Please try again." });
        }

        next();
    } catch (error) {
        console.error("reCAPTCHA verification error:", error);
        return res.status(500).json({ error: "CAPTCHA verification failed" });
    }
};

// ---------- GLOBAL RATE LIMIT (all IPs combined) ----------
let globalRequestCount = 0;
let globalWindowStart = Date.now();
const GLOBAL_MAX = 50; // max requests per minute across all IPs
const GLOBAL_WINDOW = 60 * 1000; // 1 minute

const globalRateLimit = (req, res, next) => {
    const now = Date.now();
    if (now - globalWindowStart > GLOBAL_WINDOW) {
        // Reset window
        globalRequestCount = 0;
        globalWindowStart = now;
    }
    globalRequestCount++;
    if (globalRequestCount > GLOBAL_MAX) {
        return res.status(429).json({ error: "Global request limit reached. Please try again later." });
    }
    next();
};

// ---------- Apply middleware to payment endpoints in the correct order ----------
// 1. Secret check
app.use('/api/pay', checkSecret);
app.use('/api/retry-payment', checkSecret);

// 2. reCAPTCHA verification
app.use('/api/pay', verifyRecaptcha);
app.use('/api/retry-payment', verifyRecaptcha);

// 3. Global rate limit (all IPs combined)
app.use('/api/pay', globalRateLimit);
app.use('/api/retry-payment', globalRateLimit);

// ---------- RATE LIMITING & IP BLOCKING (per‑IP) ----------
// In-memory store for tracking violations and blocks
const violationStore = new Map(); // IP => { count, firstViolationTime, blockUntil }

// Cleanup expired entries every minute
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of violationStore.entries()) {
        if (data.blockUntil && data.blockUntil < now) {
            violationStore.delete(ip);
        } else if (!data.blockUntil && (now - data.firstViolationTime) > 3600000) {
            // If no block and violation is older than 1 hour, remove it
            violationStore.delete(ip);
        }
    }
}, 60000);

// Middleware to check if IP is currently blocked
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

// Primary rate limiter: 3 requests per 5 minutes (per‑IP)
const paymentLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3,
    message: { error: "Too many payment requests from this IP. Please wait 5 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        // On rate limit violation, track it
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        const data = violationStore.get(ip) || { count: 0, firstViolationTime: now, blockUntil: null };
        data.count += 1;
        if (data.count >= 3) { // after 3 violations within the hour
            // Block for 1 hour
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

// 4. Per‑IP rate limit + blocking (after global rate limit)
app.use('/api/pay', checkBlocked, paymentLimiter);
app.use('/api/retry-payment', checkBlocked, paymentLimiter);

/* -------------------------------
   4. Root Route
-------------------------------- */
app.get("/", (req, res) => {
    res.send("sarahapay API Running");
});

/* -------------------------------
   5. OAuth Token
-------------------------------- */
async function getAccessToken() {
    try {
        const credentials = Buffer
            .from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
            .toString("base64");

        const response = await axios.post(
            "https://api.kopokopo.com/oauth/token",
            qs.stringify({ grant_type: "client_credentials" }),
            {
                headers: {
                    Authorization: `Basic ${credentials}`,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                timeout: 10000
            }
        );

        return response.data.access_token;
    } catch (error) {
        console.error("OAuth Failure:", error.response?.data || error.message);
        throw new Error("Authentication failed");
    }
}

/* -------------------------------
   6. Helper: Initiate STK Push
-------------------------------- */
async function initiateStkPush(name, phone, amount, retryCount = 0) {
    let formattedPhone = phone
        .replace(/\s+/g, '')
        .replace(/^\+/, '')
        .replace(/^0/, '254');

    const names = name.trim().split(" ");
    const firstName = names[0];
    const lastName = names.slice(1).join(" ") || "Customer";

    const token = await getAccessToken();
    const formattedAmount = parseFloat(amount).toFixed(2);

    const payload = {
        payment_channel: "M-PESA STK Push",
        till_number: process.env.MERCHANT_NUMBER,
        subscriber: {
            first_name: firstName,
            last_name: lastName,
            phone_number: formattedPhone,
            email: "customer@example.com"
        },
        amount: {
            currency: "KES",
            value: formattedAmount
        },
        metadata: { notes: "Website Purchase" },
        _links: { callback_url: process.env.CALLBACK_URL }
    };

    console.log("STK Payload:", payload);

    const response = await axios.post(
        "https://api.kopokopo.com/api/v1/incoming_payments",
        payload,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            timeout: 10000
        }
    );

    const checkoutId = response.headers.location.split("/").pop();

    const tx = new Transaction({
        name,
        phone: formattedPhone,
        amount: formattedAmount,
        checkout_id: checkoutId,
        retryCount: retryCount,
        lastRetryAt: new Date()
    });

    await tx.save();
    return tx;
}

/* -------------------------------
   7. Initiate Payment (with 30‑second timeout & retry logic)
-------------------------------- */
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

        // Find the most recent transaction for this phone
        const lastTx = await Transaction.findOne({ phone: formattedPhone })
            .sort({ createdAt: -1 });

        // ---------- 30‑second timeout for pending transactions ----------
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

        // ---------- Retry limit handling (max 5 attempts) ----------
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
        console.error("STK Push Error:", error.response?.data || error.message);
        res.status(500).json({
            error: "Failed to initiate payment",
            details: error.response?.data || error.message
        });
    }
});

/* -------------------------------
   8. Retry Payment Endpoint
-------------------------------- */
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

/* -------------------------------
   9. Fetch Transactions
-------------------------------- */
app.get("/api/transactions", async (req, res) => {
    try {
        const transactions = await Transaction.find().sort({ createdAt: -1 });
        res.json(transactions);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch transactions" });
    }
});

/* -------------------------------
   10. Get Single Transaction by ID
-------------------------------- */
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

/* -------------------------------
   11. Payment Callback
-------------------------------- */
app.post("/callback", async (req, res) => {
    try {
        console.log("Callback received:", JSON.stringify(req.body, null, 2));

        if (!req.body || !req.body.data) {
            console.log("Empty callback payload – ignoring");
            return res.sendStatus(200);
        }

        const payload = req.body.data;
        const checkoutId = payload.id;
        const status = payload.attributes?.status;
        const receipt = payload.attributes?.event?.resource?.reference || "N/A";

        if (!checkoutId) {
            console.log("Callback missing checkoutId – ignoring");
            return res.sendStatus(200);
        }

        await Transaction.findOneAndUpdate(
            { checkout_id: checkoutId },
            { status: status, mpesa_receipt: receipt }
        );

        console.log(`Payment Update: ${status} | Receipt: ${receipt}`);
        res.sendStatus(200);
    } catch (error) {
        console.error("Callback Error:", error);
        res.sendStatus(200);
    }
});

/* -------------------------------
   12. Start Server
-------------------------------- */
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});