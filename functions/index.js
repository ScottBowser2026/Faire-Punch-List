const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const twilio = require("twilio");

const twilioAccountSid = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthToken = defineSecret("TWILIO_AUTH_TOKEN");
const twilioFromNumber = defineSecret("TWILIO_FROM_NUMBER");

admin.initializeApp({
  databaseURL: "https://faire-builder-tracker-default-rtdb.firebaseio.com"
});
const db = admin.database();

// Browsers may only call this from our own sites. (Server-to-server calls, such as the
// daily summary job, send no Origin header and are not affected by CORS.)
const ALLOWED_ORIGINS = [
  "https://punchlist.lancelotbiz.com",
  "https://lancelot-punchlist-live.web.app",
  "https://lancelot-punchlist-live.firebaseapp.com",
  "https://faire-punch-list.web.app",
  "https://scottbowser2026.github.io"
];

const MAX_MESSAGE_LENGTH = 800;
const MAX_PER_NUMBER_PER_HOUR = 20;
const MAX_TOTAL_PER_HOUR = 1000;

// Every message the tracker sends starts with one of these.
const ALLOWED_PREFIX = /^(\u{1F525}\s*)?(faire punch list:|faire campus priority)/iu;

const last10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);

// Phone numbers that are on file in the Punch List directory (name -> phone, stored as JSON text).
let cachedNumbers = null;
let cachedAt = 0;
async function directoryNumbers() {
  if (cachedNumbers && Date.now() - cachedAt < 60 * 1000) return cachedNumbers;
  const snap = await db.ref("faire-punch-list-phones").once("value");
  const raw = snap.val();
  let dir = {};
  try { dir = raw ? JSON.parse(raw) : {}; } catch (e) { dir = {}; }
  const set = new Set();
  Object.values(dir).forEach((p) => { const d = last10(p); if (d.length === 10) set.add(d); });
  cachedNumbers = set;
  cachedAt = Date.now();
  return set;
}

// Counts sends per hour. Lives outside any path the app's browser code can touch.
async function underLimit(path, max) {
  const result = await db.ref(path).transaction((n) => {
    n = n || 0;
    return n >= max ? undefined : n + 1; // undefined = abort, leave unchanged
  });
  return result.committed;
}

// POST { to: "+15551234567", message: "text body" }
exports.sendJobText = onRequest(
  { secrets: [twilioAccountSid, twilioAuthToken, twilioFromNumber], cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const { to, message } = req.body || {};
    if (typeof to !== "string" || typeof message !== "string" || !to || !message) {
      res.status(400).json({ error: "Missing 'to' or 'message'" });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH || !ALLOWED_PREFIX.test(message.trim())) {
      console.warn("Rejected message (format/length)", { len: message.length });
      res.status(400).json({ error: "Message not allowed" });
      return;
    }

    const digits = last10(to);
    let allowed;
    try {
      allowed = await directoryNumbers();
    } catch (err) {
      console.error("Could not read phone directory", err);
      res.status(503).json({ error: "Try again shortly" });
      return;
    }
    if (digits.length !== 10 || !allowed.has(digits)) {
      console.warn("Rejected recipient not in directory", { tail: digits.slice(-4) });
      res.status(403).json({ error: "Recipient not allowed" });
      return;
    }

    const hour = new Date().toISOString().slice(0, 13).replace(/[^0-9]/g, "");
    try {
      const okNumber = await underLimit(`sms-rate-limit/number/${digits}/${hour}`, MAX_PER_NUMBER_PER_HOUR);
      const okTotal = okNumber && await underLimit(`sms-rate-limit/total/${hour}`, MAX_TOTAL_PER_HOUR);
      if (!okNumber || !okTotal) {
        console.warn("Rate limit hit", { tail: digits.slice(-4), okNumber, okTotal });
        res.status(429).json({ error: "Too many texts, try later" });
        return;
      }
    } catch (err) {
      console.error("Rate limit check failed", err);
      res.status(503).json({ error: "Try again shortly" });
      return;
    }

    const fromNumber = twilioFromNumber.value();
    if (!fromNumber || fromNumber === "PENDING") {
      res.status(503).json({ error: "Twilio number not configured yet (compliance/registration pending)" });
      return;
    }

    try {
      const client = twilio(twilioAccountSid.value(), twilioAuthToken.value());
      const result = await client.messages.create({ body: message, from: fromNumber, to });
      res.status(200).json({ success: true, sid: result.sid });
    } catch (err) {
      console.error("Twilio send failed", err);
      res.status(500).json({ error: "Send failed" });
    }
  }
);
