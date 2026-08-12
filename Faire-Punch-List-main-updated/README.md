# Faire Punch List

Live at: https://punchlist.lancelotbiz.com/

Crew task management for Pennsylvania Renaissance Faire — job creation, PIN-based login, Ops/Entertainment progress tracking, and long-range project planning.

## Structure

- `index.html` — the Punch List app itself (this repo's homepage)
- `privacy.html`, `terms.html`, `consent-script.html` — SMS program documentation (referenced by the Twilio toll-free registration for +1 833 749-1031 — see note below before changing these)
- `emailjs.min.js`, `firebase-*-compat.js` — self-hosted SDK files the app depends on
- `CNAME` — points this repo at punchlist.lancelotbiz.com (do not delete)
- `functions/`, `scripts/`, `firebase.json`, `.firebaserc`, `.github/workflows/` — backend: Cloud Functions for job-assignment texts, plus a scheduled daily summary email

## Important: don't remove privacy.html / terms.html / consent-script.html

These three files are the exact URLs Twilio has on file for the approved toll-free registration (+1 833 749-1031, shared across PARF/SRF/KRF/GARF alerts). Twilio doesn't allow editing an already-approved registration's URLs without a full resubmission, so as of now these pages stay here rather than pointing to the newer shared pages at legal.lancelotbiz.com.

## One-time setup after any move to a new repo

The backend's GitHub Actions won't run without these repo secrets (Settings → Secrets and variables → Actions):
- `FIREBASE_SERVICE_ACCOUNT`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- `EMAILJS_PRIVATE_KEY`

## Related sites

- Hub / Guild Board: https://guildboard.lancelotbiz.com/
- Faire QC Tracker: https://foodqc.lancelotbiz.com/
- Shared legal pages (for other trackers' SMS programs): https://legal.lancelotbiz.com/
