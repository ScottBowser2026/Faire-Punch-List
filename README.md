# PARF Unified Tracker Site

Live at: https://fbqc.lancelotbiz.com/

## Structure

- `index.html` — The Guild Board (hub/menu page), the site's homepage
- `CNAME` — points this repo at fbqc.lancelotbiz.com (do not delete)
- `qc/` — Faire QC Tracker, live at /qc/
- `punch-list/` — Faire Punch List webpage, live at /punch-list/
- `functions/`, `scripts/`, `firebase.json`, `.firebaserc`, `.github/workflows/` — Punch List's backend (Cloud Functions + daily summary email). These power features behind the Punch List page but are NOT served as a webpage themselves, which is why they sit at the repo root instead of inside punch-list/. GitHub only reads workflow files from `.github/workflows` at the root, and firebase.json expects its `functions` folder alongside it — moving these into a subfolder would break both.

### Punch List — one-time setup after upload

This tracker's GitHub Actions won't run until these repo secrets are added (Settings → Secrets and variables → Actions):
- `FIREBASE_SERVICE_ACCOUNT`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- `EMAILJS_PRIVATE_KEY`

If these were already set on the old standalone Faire-Punch-List repo, add the same values here — GitHub doesn't carry secrets over automatically when files move between repos.

Also: this page uses Firebase Authentication (anonymous sign-in). If anything auth-related ever misbehaves after the move, check Firebase Console → Authentication → Settings → Authorized domains and make sure `fbqc.lancelotbiz.com` is on the list.

### If a future tracker also needs its own Cloud Functions

Only one `firebase.json`/`.firebaserc` can exist per repo. A second tracker with its own Functions would need to be added as a second "codebase" inside this same firebase.json rather than getting its own — flag it here when that comes up and we'll merge it in properly.

## Adding the next tracker (e.g. Refrigeration Tracker)

1. Create a new folder at the repo root, e.g. `punch-list/`
2. Drop in that tracker's files (index.html, manifest.json, sw.js, icons, etc.)
3. Check for any absolute paths (starting with `/`) inside its index.html — fix to relative (`./`) if found
4. If it has a manifest.json, confirm `start_url` and `scope` are relative (`"./index.html"`, `"./"`) not `"/"`
5. In the hub's index.html, find that tracker's card and:
   - change `href="#"` to `href="/punch-list/"`
   - change `<span class="status placeholder">Add link</span>` to `<span class="status live">Live</span>`
   - remove `target="_blank" rel="noopener"` since it's now an internal page, not an external tool
6. Commit, wait for the Pages rebuild, test both `/punch-list/` directly and the hub link

## Notes

- Each tracker keeps its own Firebase/EmailJS project — only the hosting URL changes, not the backend.
- If a tracker's original repo has its own CNAME file, don't copy it in — only the root CNAME should exist, shared by the whole site.
