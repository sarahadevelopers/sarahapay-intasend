// =============================================
// INTASEND PAYMENT SCRIPT
// =============================================

// ─── Constants ──────────────────────────────────
// Update these to match your new backend
const API_BASE = 'https://your-render-url.onrender.com'; // ← UPDATE THIS
const API_SECRET = process.env.INTASEND_SECRET_KEY || 'your_intasend_secret_key'; // ← UPDATE
const RECAPTCHA_SITE_KEY = '6LcKDGEtAAAAAJKAWjXB7j5bSIPvzz94wBWapTD5';

// ─── Helper Functions ──────────────────────────
function showStatus(message, type) {
    const status = document.getElementById("status");
    if (!status) return;
    status.style.color = type === "success" ? "green" : type === "error" ? "red" : "blue";
    status.innerText = message;
}

function setPayButton(disabled, text = null) {
    const btn = document.getElementById("payBtn");
    if (!btn) return;
    btn.disabled = disabled;
    if (text !== null) btn.innerText = text;
}

function startCooldownTimer(seconds) {
    let remaining = seconds;
    const timerInterval = setInterval(() => {
        if (remaining <= 0) {
            clearInterval(timerInterval);
            showStatus("You can try again now.", "blue");
            setPayButton(false, "Pay Now");
        } else {
            showStatus(`Please wait ${remaining} seconds before trying again.`, "error");
            remaining--;
        }
    }, 1000);
}

// ─── Main Payment Function ─────────────────────
async function handlePayment() {
    const phone = document.getElementById("phone").value.trim();
    const plan = document.getElementById("plan").value;
    const userId = document.getElementById("userId").value || 'demo_user';

    if (!phone) {
        alert("Please enter your phone number");
        return;
    }

    // Format phone to 254XXXXXXXXX
    let formattedPhone = phone.replace(/\s/g, '');
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.slice(1);
    } else if (!formattedPhone.startsWith('254')) {
        formattedPhone = '254' + formattedPhone.replace(/^\+/, '');
    }

    setPayButton(true, "Processing...");
    showStatus("Sending M-Pesa prompt...", "blue");

    try {
        // Get reCAPTCHA token
        const recaptchaToken = await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: 'payment' });

        const response = await fetch(`${API_BASE}/api/pay`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Secret": API_SECRET,
                "X-Recaptcha-Token": recaptchaToken
            },
            body: JSON.stringify({ 
                phone: formattedPhone, 
                plan: plan, 
                userId: userId 
            })
        });

        const data = await response.json();

        if (response.ok) {
            showStatus("✅ STK Push sent! Check your phone for the M-Pesa prompt.", "success");
            // Hide retry button if exists
            const rb = document.getElementById("retryBtn");
            if (rb) rb.remove();
            setPayButton(false, "Pay Now");
            
            // Store transaction reference for status checking
            localStorage.setItem('lastTransactionRef', data.transactionRef);
        } else {
            const errorMsg = data.error || data.details || "Payment failed";
            
            if (response.status === 409) {
                showStatus("You already have a pending payment. Check your phone or wait a few minutes.", "error");
                startCooldownTimer(30);
            } else if (response.status === 429) {
                showStatus(errorMsg, "error");
                const match = errorMsg.match(/(\d+)\s*second/);
                const waitSeconds = match ? parseInt(match[1]) : 30;
                startCooldownTimer(waitSeconds);
            } else {
                showStatus(errorMsg, "error");
                setPayButton(false, "Pay Now");
            }
        }
    } catch (err) {
        console.error("Payment error:", err);
        showStatus("Network error. Please refresh and try again.", "error");
        setPayButton(false, "Pay Now");
    }
}

// ─── Check Transaction Status ───────────────────
async function checkTransactionStatus() {
    const ref = localStorage.getItem('lastTransactionRef');
    if (!ref) return;

    try {
        const response = await fetch(`${API_BASE}/api/transaction/${ref}`);
        const data = await response.json();
        
        if (data.status === 'completed') {
            showStatus("✅ Payment confirmed! Thank you.", "success");
            localStorage.removeItem('lastTransactionRef');
        } else if (data.status === 'failed') {
            showStatus("❌ Payment failed. Please try again.", "error");
            localStorage.removeItem('lastTransactionRef');
            setPayButton(false, "Pay Now");
        } else {
            // Still pending - check again in 10 seconds
            setTimeout(checkTransactionStatus, 10000);
        }
    } catch (err) {
        console.error('Status check failed:', err);
    }
}

// ─── Auto-check status on page load ────────────
document.addEventListener('DOMContentLoaded', () => {
    const ref = localStorage.getItem('lastTransactionRef');
    if (ref) {
        showStatus("Checking payment status...", "blue");
        setTimeout(checkTransactionStatus, 3000);
    }
});