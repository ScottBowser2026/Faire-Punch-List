/**
 * Faire Punch List — server-side PIN login.
 *
 * Before this, everyone's PIN was the KEY of a JSON blob at
 * faire-punch-list-pins, readable and writable by any anonymous visitor —
 * so anyone could read every PIN (admin included) or rewrite roles.
 *
 * Now:
 *  - People live at faire-punch-list-people/{id}: {name, role, crews, hasPin}
 *    with no PINs. Each PIN is kept only as an HMAC (keyed by the
 *    PL_PIN_PEPPER secret) under faire-punch-list-pin-index, which only these
 *    functions can read.
 *  - plLogin checks the PIN here and stamps the caller's anonymous Firebase
 *    account with custom claims (plRole, plId, plUntil). The database rules
 *    grant access from those, and re-check on every request that the person
 *    still exists with that role — so removing someone or changing their
 *    role takes effect immediately.
 *  - The old blob is converted on the next login and then deleted. If an
 *    old browser tab writes it back, the next login converts it again,
 *    matching people by name instead of duplicating them.
 */
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

const PL_PIN_PEPPER = defineSecret("PL_PIN_PEPPER");
const twilioAccountSid = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthToken = defineSecret("TWILIO_AUTH_TOKEN");
const twilioFromNumber = defineSecret("TWILIO_FROM_NUMBER");

const PEOPLE = "faire-punch-list-people";
const OLD_PINS = "faire-punch-list-pins";
const PIN_INDEX = "faire-punch-list-pin-index";
const PIN_BY_ID = "faire-punch-list-pin-by-id";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const FORGOT_COOLDOWN_MS = 5 * 60 * 1000;
const PIN_RE = /^\d{4,6}$/;
const ID_RE = /^p_[A-Za-z0-9]{6,24}$/;

const db = () => admin.database();
const pinKey = (pin) => crypto.createHmac("sha256", PL_PIN_PEPPER.value()).update(String(pin)).digest("hex");
const newId = () => "p_" + crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 12).padEnd(12, "0");

function parseBlob(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v) || {}; } catch (e) { return {}; }
}
function crewsArray(c) {
  if (Array.isArray(c)) return c.filter(Boolean);
  if (c && typeof c === "object") return Object.values(c).filter(Boolean);
  return [];
}
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (String(raw).trim().startsWith("+")) return String(raw).trim();
  return null;
}
function callerIp(req) {
  const raw = req.rawRequest;
  const fwd = raw && raw.headers && raw.headers["x-forwarded-for"];
  const ip = fwd ? String(fwd).split(",")[0].trim() : (raw && raw.ip) || "unknown";
  return ip.replace(/[.#$[\]/:]/g, "_");
}

// Converts the old PIN-keyed blob into people records + the private index.
async function migrateOldBlob() {
  const old = parseBlob((await db().ref(OLD_PINS).get()).val());
  const entries = Object.entries(old).filter(([pin, e]) => e && e.name);
  if (entries.length === 0) {
    if ((await db().ref(OLD_PINS).get()).exists()) await db().ref(OLD_PINS).remove();
    return 0;
  }
  const [peopleSnap, indexSnap, byIdSnap] = await Promise.all([
    db().ref(PEOPLE).get(), db().ref(PIN_INDEX).get(), db().ref(PIN_BY_ID).get(),
  ]);
  const people = peopleSnap.val() || {};
  const index = indexSnap.val() || {};
  const byId = byIdSnap.val() || {};
  const updates = {[OLD_PINS]: null};
  for (const [rawPin, e] of entries) {
    const pin = String(rawPin).trim();
    let id = Object.keys(people).find((k) => people[k] && people[k].name === e.name);
    if (!id) {
      id = newId();
      people[id] = {name: e.name, role: e.role || "manager", crews: crewsArray(e.crews)};
      updates[`${PEOPLE}/${id}`] = people[id];
    }
    if (!PIN_RE.test(pin)) {
      console.warn(`pl migrate: dropped an unusable PIN for ${e.name}`);
      continue;
    }
    const key = pinKey(pin);
    if (index[key] && index[key] !== id && people[index[key]]) {
      console.warn(`pl migrate: ${e.name} shares a PIN with someone else; dropped it`);
      continue;
    }
    if (byId[id] && byId[id] !== key) updates[`${PIN_INDEX}/${byId[id]}`] = null;
    index[key] = id;
    byId[id] = key;
    updates[`${PIN_INDEX}/${key}`] = id;
    updates[`${PIN_BY_ID}/${id}`] = key;
    updates[`${PEOPLE}/${id}/hasPin`] = true;
  }
  await db().ref().update(updates);
  console.log(`pl migrate: converted ${entries.length} PIN entr${entries.length === 1 ? "y" : "ies"}`);
  return entries.length;
}

async function requireCaller(req) {
  const t = (req.auth && req.auth.token) || {};
  if (!t.plId || !t.plRole || !(t.plUntil > Date.now())) throw new HttpsError("unauthenticated", "Please log in again.");
  const person = (await db().ref(`${PEOPLE}/${t.plId}`).get()).val();
  if (!person || person.role !== t.plRole) throw new HttpsError("unauthenticated", "Please log in again.");
  return {id: t.plId, role: t.plRole};
}

// Sets (or generates) a PIN for an existing person. Returns the PIN.
async function assignPin(id, wanted) {
  if (!(await db().ref(`${PEOPLE}/${id}`).get()).exists()) {
    throw new HttpsError("not-found", "That person wasn't found — save them first.");
  }
  const oldKey = (await db().ref(`${PIN_BY_ID}/${id}`).get()).val();
  const isFree = async (k) => {
    const holder = (await db().ref(`${PIN_INDEX}/${k}`).get()).val();
    return !holder || holder === id || !(await db().ref(`${PEOPLE}/${holder}`).get()).exists();
  };
  let pin = wanted ? String(wanted).trim() : "";
  let key;
  if (pin) {
    if (!PIN_RE.test(pin)) throw new HttpsError("invalid-argument", "PIN must be 4-6 digits.");
    key = pinKey(pin);
    if (!await isFree(key)) throw new HttpsError("already-exists", "That PIN is already taken — pick a different one.");
  } else {
    for (let i = 0; i < 60 && !key; i++) {
      const candidate = String(i < 50 ? crypto.randomInt(1000, 10000) : crypto.randomInt(10000, 100000));
      const k = pinKey(candidate);
      if (await isFree(k)) {
        pin = candidate;
        key = k;
      }
    }
    if (!key) throw new HttpsError("resource-exhausted", "Couldn't find a free PIN — try again.");
  }
  const updates = {[`${PIN_INDEX}/${key}`]: id, [`${PIN_BY_ID}/${id}`]: key, [`${PEOPLE}/${id}/hasPin`]: true};
  if (oldKey && oldKey !== key) updates[`${PIN_INDEX}/${oldKey}`] = null;
  await db().ref().update(updates);
  return pin;
}

// ---------- Login ----------
exports.plLogin = onCall({secrets: [PL_PIN_PEPPER]}, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Couldn't connect — reload and try again.");
  const pin = String((req.data || {}).pin || "").trim();
  const attemptRef = db().ref(`faire-punch-list-login-attempts/${callerIp(req)}`);
  const attempt = (await attemptRef.get()).val();
  const now = Date.now();
  if (attempt && now - attempt.windowStart < LOGIN_WINDOW_MS && attempt.count >= LOGIN_MAX_FAILS) {
    throw new HttpsError("resource-exhausted", "Too many wrong PINs. Try again in a few minutes.");
  }
  const fail = async () => {
    await attemptRef.transaction((cur) =>
      !cur || now - cur.windowStart > LOGIN_WINDOW_MS ?
        {count: 1, windowStart: now} :
        {count: (cur.count || 0) + 1, windowStart: cur.windowStart});
    throw new HttpsError("permission-denied", "That PIN isn't recognized.");
  };
  if (!PIN_RE.test(pin)) return fail();

  await migrateOldBlob();
  const key = pinKey(pin);
  const id = (await db().ref(`${PIN_INDEX}/${key}`).get()).val();
  if (!id) return fail();
  const person = (await db().ref(`${PEOPLE}/${id}`).get()).val();
  if (!person) {
    await db().ref().update({[`${PIN_INDEX}/${key}`]: null, [`${PIN_BY_ID}/${id}`]: null});
    return fail();
  }
  await attemptRef.remove();
  const role = person.role || "manager";
  if (role !== "admin" && (await db().ref("faire-punch-list-test-mode").get()).val()) {
    throw new HttpsError("failed-precondition", "The tracker is in test mode right now — only admin can sign in. Try again shortly.");
  }
  if (!person.role) await db().ref(`${PEOPLE}/${id}/role`).set(role);
  await admin.auth().setCustomUserClaims(req.auth.uid, {plRole: role, plId: id, plUntil: now + SESSION_MS});
  return {id, name: person.name, role, crews: crewsArray(person.crews)};
});

// ---------- Logout ----------
exports.plLogout = onCall(async (req) => {
  if (req.auth) await admin.auth().setCustomUserClaims(req.auth.uid, null);
  return {ok: true};
});

// ---------- Set someone's PIN ----------
// Admin: anyone. Everyone else: only themselves.
exports.plSetPin = onCall({secrets: [PL_PIN_PEPPER]}, async (req) => {
  const caller = await requireCaller(req);
  const {id, pin} = req.data || {};
  if (!ID_RE.test(String(id || ""))) throw new HttpsError("invalid-argument", "Bad request.");
  if (caller.role !== "admin" && caller.id !== id) throw new HttpsError("permission-denied", "You can only change your own PIN.");
  await migrateOldBlob();
  return {pin: await assignPin(id, pin)};
});

// ---------- Forgot PIN ----------
// The new PIN is texted to the phone on file — never returned to the
// browser, since whoever is at the login screen may not be the account owner.
exports.plForgotPin = onCall(
  {secrets: [PL_PIN_PEPPER, twilioAccountSid, twilioAuthToken, twilioFromNumber]},
  async (req) => {
    const generic = {message: "If that email is on file with a phone number, a new PIN has been texted to it."};
    if (!req.auth) return generic;
    const email = String((req.data || {}).email || "").trim().toLowerCase();
    if (!email) return generic;
    await migrateOldBlob();
    const [dirSnap, phonesSnap, peopleSnap] = await Promise.all([
      db().ref("faire-punch-list-directory").get(),
      db().ref("faire-punch-list-phones").get(),
      db().ref(PEOPLE).get(),
    ]);
    const directory = parseBlob(dirSnap.val());
    const phones = parseBlob(phonesSnap.val());
    const people = peopleSnap.val() || {};
    const name = Object.keys(directory).find((n) => String(directory[n] || "").trim().toLowerCase() === email);
    const id = name && Object.keys(people).find((k) => people[k] && people[k].name === name);
    const to = name && toE164(phones[name]);
    if (!id || !to) {
      console.log(`plForgotPin: ${!id ? "no account for that email" : "no usable phone on file"}`);
      return generic;
    }
    const lastRef = db().ref(`faire-punch-list-forgot-pin-at/${id}`);
    const last = (await lastRef.get()).val();
    if (last && Date.now() - last < FORGOT_COOLDOWN_MS) {
      console.log(`plForgotPin: ${id} still on cooldown`);
      return generic;
    }
    await lastRef.set(Date.now());
    const pin = await assignPin(id, null);
    try {
      const client = require("twilio")(twilioAccountSid.value(), twilioAuthToken.value());
      await client.messages.create({
        from: twilioFromNumber.value(),
        to,
        body: `Faire Punch List: your new PIN is ${pin}. If you didn't ask for this, tell Scott.`,
      });
      console.log(`plForgotPin: texted new PIN to ${id}`);
    } catch (err) {
      console.error(`plForgotPin: text to ${id} failed`, err && err.message);
    }
    return generic;
  }
);
