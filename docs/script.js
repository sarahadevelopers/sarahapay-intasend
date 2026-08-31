// =============================================
// INTASEND PAYMENT SCRIPT – Fixed Version
// =============================================

// ─── Constants ──────────────────────────────────
const API_BASE = 'https://sarahapay-intasend.onrender.com'; // your deployed backend
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
    // Get form values
    const phoneInput = document.getElementById("phone");
    const amountInput = document.getElementById("amount");
    const planInput = document.getElementById("plan");
    const userIdInput = document.getElementById("userId");

    // Validate phone
    const phone = phoneInput ? phoneInput.value.trim() : '';
    if (!phone) {
        alert("Please enter your phone number");
        return;
    }

    // Get plan and userId (with defaults)
    const plan = planInput ? planInput.value : 'basic';
    const userId = userIdInput ? userIdInput.value : 'demo_user';

    // Get amount (if present), otherwise the server will use plan price
    let amount = null;
    if (amountInput) {
        const rawAmount = parseFloat(amountInput.value);
        if (!isNaN(rawAmount) && rawAmount > 0) {
            amount = rawAmount;
        }
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
        // Get reCAPTCHA token (if available)
        let recaptchaToken = '';
        if (typeof grecaptcha !== 'undefined') {
            recaptchaToken = await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: 'payment' });
        }

        // Build request payload
        const payload = {
            phone: formattedPhone,
            plan: plan,
            userId: userId
        };
        if (amount !== null) {
            payload.amount = amount;
        }
        // Optionally add callbackUrl if you have one
        // payload.callbackUrl = 'https://your-app.com/api/payment-confirmation';

        const response = await fetch(`${API_BASE}/api/pay`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Recaptcha-Token": recaptchaToken
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok) {
            showStatus("✅ STK Push sent! Check your phone for the M-Pesa prompt.", "success");
            setPayButton(false, "Pay Now");
            // Store transaction reference for status checking
            if (data.transactionRef) {
                localStorage.setItem('lastTransactionRef', data.transactionRef);
            }
        } else {
            const errorMsg = data.error || data.details || "Payment failed";
            
            // Handle specific status codes
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
        if (!response.ok) {
            // If not found or error, maybe clear storage
            if (response.status === 404) {
                localStorage.removeItem('lastTransactionRef');
                showStatus("Transaction not found. Please try again.", "error");
                setPayButton(false, "Pay Now");
            }
            return;
        }
        const data = await response.json();
        
        if (data.status === 'completed') {
            showStatus("✅ Payment confirmed! Thank you.", "success");
            localStorage.removeItem('lastTransactionRef');
            setPayButton(false, "Pay Now");
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
        // Retry after a longer delay
        setTimeout(checkTransactionStatus, 20000);
    }
}

// ─── Auto-check status on page load ────────────
document.addEventListener('DOMContentLoaded', () => {
    const ref = localStorage.getItem('lastTransactionRef');
    if (ref) {
        showStatus("Checking payment status...", "blue");
        setPayButton(true, "Processing...");
        // Wait a bit before first check
        setTimeout(checkTransactionStatus, 3000);
    }
});