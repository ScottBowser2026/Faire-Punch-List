const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const twilio = require("twilio");

const twilioAccountSid = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthToken = defineSecret("TWILIO_AUTH_TOKEN");
const twilioFromNumber = defineSecret("TWILIO_FROM_NUMBER");

// POST { to: "+15551234567", message: "text body" }
// Called from the tracker whenever a new job is assigned to someone with a phone number on file.
exports.sendJobText = onRequest(
  { secrets: [twilioAccountSid, twilioAuthToken, twilioFromNumber], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const { to, message } = req.body || {};
    if (!to || !message) {
      res.status(400).json({ error: "Missing 'to' or 'message'" });
      return;
    }

    const fromNumber = twilioFromNumber.value();
    if (!fromNumber || fromNumber === "PENDING") {
      res.status(503).json({ error: "Twilio number not configured yet (compliance/registration pending)" });
      return;
    }

    try {
      const client = twilio(twilioAccountSid.value(), twilioAuthToken.value());
      const result = await client.messages.create({
        body: message,
        from: fromNumber,
        to
      });
      res.status(200).json({ success: true, sid: result.sid });
    } catch (err) {
      console.error("Twilio send failed", err);
      res.status(500).json({ error: err.message || "Send failed" });
    }
  }
);
