const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: 'https://faire-builder-tracker-default-rtdb.firebaseio.com'
});
const db = admin.database();

const EMAILJS_SERVICE_ID = 'service_yutnnpk';
const EMAILJS_TEMPLATE_ID = 'template_ph5468d';
const EMAILJS_PUBLIC_KEY = 'SJmpLfL-sFiy6y2Nb';
const TRACKER_URL = 'https://punchlist.lancelotbiz.com/';
const TZ = 'America/New_York';
const SEND_SMS_URL = 'https://us-central1-faire-builder-tracker.cloudfunctions.net/sendJobText';

// Morning lists go out once a day at 7:45 AM Eastern. The workflow fires at
// both 11:45 and 12:45 UTC (7:45 Eastern in summer and in winter); this only
// sends between 7 and 11 AM Eastern, and once per day.
const SEND_FROM_HOUR = 7;
const SEND_UNTIL_HOUR = 11;

// Who gets the all-jobs list: a name from the team list, set by admin in
// Team Management > Summary.
const MANAGER_SETTING = 'faire-punch-list-manager-summary-person';
const LAST_MORNING_DATE = 'faire-punch-list-last-morning-date';

// Optional: a Power Automate (Teams Workflows) URL that posts a message to one
// person's Teams chat. Without it, everything still goes out by email.
const TEAMS_WORKFLOW_URL = process.env.TEAMS_WORKFLOW_URL || '';

// Manual runs: TEST_RECIPIENT sends only that person's own list plus the
// all-jobs list, both to that person, and nothing to anyone else.
const TEST_RECIPIENT = (process.env.TEST_RECIPIENT || '').trim();
const MANUAL = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

// This repo is public, so its Actions logs are too: log counts, never names or jobs.

function parseBlob(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch (e) { return {}; }
}

function easternNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) % 24 };
}

function fmtDue(due) {
  const d = new Date(due + 'T12:00:00');
  return isNaN(d) ? due : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const isOpen = t => t && (t.pct || 0) < 100;
const isOverdue = (t, today) => isOpen(t) && !t.longRange && t.due && t.due < today;
const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || String(a.name).localeCompare(String(b.name));

function jobLine(t) {
  const bits = [t.dept, t.due ? `due ${fmtDue(t.due)}` : 'no due date', `${t.pct || 0}% done`];
  if (t.longRange) bits.push('long-range');
  return `${t.name} (${bits.filter(Boolean).join(', ')})`;
}

// Each section is { title, items: [string] }; rendered as plain text for email
// and as simple HTML for Teams.
function render(heading, sections, footer) {
  const text = [heading, ''];
  const html = [`<b>${esc(heading)}</b>`];
  sections.forEach(s => {
    if (!s.items.length) return;
    text.push(`${s.title}:`);
    s.items.forEach(i => text.push(`  - ${i}`));
    text.push('');
    html.push(`<br><b>${esc(s.title)}</b>`);
    s.items.forEach(i => html.push(`• ${esc(i)}`));
  });
  text.push(footer);
  html.push(`<br>${esc(footer)}`);
  return { text: text.join('\n'), html: html.join('<br>') };
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// One person's own list: waiting for acceptance, overdue, then everything else open.
function personalMessage(owner, jobs, today, dateLabel) {
  const pending = jobs.filter(t => t.pendingAcceptance).sort(byDue);
  const overdue = jobs.filter(t => !t.pendingAcceptance && isOverdue(t, today)).sort(byDue);
  const rest = jobs.filter(t => !t.pendingAcceptance && !isOverdue(t, today)).sort(byDue);
  const first = owner.split(' ')[0];
  return {
    subject: `Your Punch List jobs — ${dateLabel}`,
    ...render(
      `Good morning ${first} — your open Punch List jobs for ${dateLabel}`,
      [
        { title: `Waiting for you to accept (${pending.length})`, items: pending.map(jobLine) },
        { title: `OVERDUE (${overdue.length})`, items: overdue.map(jobLine) },
        { title: `Open (${rest.length})`, items: rest.map(jobLine) },
      ],
      `Open the tracker: ${TRACKER_URL}`
    ),
  };
}

// The all-jobs list: overdue by person first, then every open job by person.
function managerMessage(openByOwner, today, dateLabel) {
  const owners = Object.keys(openByOwner).sort((a, b) => (a === 'Unassigned') - (b === 'Unassigned') || a.localeCompare(b));
  const overdueSections = owners
    .map(o => ({ o, jobs: openByOwner[o].filter(t => isOverdue(t, today)).sort(byDue) }))
    .filter(x => x.jobs.length)
    .map(x => ({ title: `OVERDUE — ${x.o} (${x.jobs.length})`, items: x.jobs.map(jobLine) }));
  const allSections = owners.map(o => {
    const jobs = openByOwner[o].slice().sort(byDue);
    return { title: `${o} — ${jobs.length} open`, items: jobs.map(t => (isOverdue(t, today) ? 'OVERDUE: ' : t.pendingAcceptance ? 'Not yet accepted: ' : '') + jobLine(t)) };
  });
  const totalOpen = owners.reduce((n, o) => n + openByOwner[o].length, 0);
  const totalOverdue = overdueSections.reduce((n, s) => n + s.items.length, 0);
  return {
    subject: `Punch List — overdue and all open jobs by person — ${dateLabel}`,
    ...render(
      `Punch List for ${dateLabel}: ${totalOverdue} overdue, ${totalOpen} open across ${owners.length} people`,
      overdueSections.length ? overdueSections.concat(allSections) : [{ title: 'Overdue', items: ['Nothing overdue.'] }].concat(allSections),
      `Open the tracker: ${TRACKER_URL}`
    ),
  };
}

async function sendEmail(to, toName, subject, message) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: { to_email: to, to_name: toName, subject, message, cc_email: '' }
    })
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status} ${await res.text()}`);
}

async function sendTeams(email, subject, html) {
  if (!TEAMS_WORKFLOW_URL) return false;
  const res = await fetch(TEAMS_WORKFLOW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, subject, html })
  });
  if (!res.ok) throw new Error(`Teams workflow ${res.status}`);
  return true;
}

// Sends one message by email and Teams. Returns what got through.
// The message log line says which of the two actually went through, so the
// app's Log tab shows who got what.
async function deliver(name, email, msg, stats) {
  if (!email) { stats.noEmail++; return; }
  let emailResult = 'failed';
  let teamsResult = TEAMS_WORKFLOW_URL ? 'failed' : 'not set up';
  try { await sendEmail(email, name, msg.subject, msg.text); stats.emails++; emailResult = 'sent'; } catch (err) { stats.emailFailures++; console.warn('An email failed:', err.message); }
  try { if (await sendTeams(email, msg.subject, msg.html)) { stats.teams++; teamsResult = 'sent'; } } catch (err) { stats.teamsFailures++; console.warn('A Teams message failed:', err.message); }
  await db.ref('faire-punch-list-message-log').push({
    type: 'email', toName: name, contact: email,
    message: `[Email ${emailResult}, Teams ${teamsResult}] ${msg.subject}: ${msg.text.slice(0, 300)}`,
    sentBy: 'system (morning list)', at: new Date().toISOString()
  });
}

async function sendPendingAcceptanceReminders(tasks, phoneDirectory) {
  const pendingByOwner = {};
  tasks.forEach(t => {
    if (t.pendingAcceptance && t.owner && isOpen(t)) (pendingByOwner[t.owner] = pendingByOwner[t.owner] || []).push(t.name);
  });
  let sent = 0;
  for (const owner of Object.keys(pendingByOwner)) {
    const phone = phoneDirectory[owner];
    if (!phone) continue;
    const jobNames = pendingByOwner[owner];
    const jobText = jobNames.length === 1 ? `"${jobNames[0]}"` : `${jobNames.length} jobs`;
    const message = `Faire Punch List: Reminder — you still have ${jobText} waiting for your acceptance. Open the tracker to accept or decline: ${TRACKER_URL}`;
    try {
      const res = await fetch(SEND_SMS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: phone, message }) });
      if (!res.ok) { console.warn('A reminder text failed:', res.status); continue; }
      sent++;
      await db.ref('faire-punch-list-message-log').push({
        type: 'text', toName: owner, contact: phone, message, sentBy: 'system (daily reminder)', at: new Date().toISOString()
      });
    } catch (err) {
      console.warn('A reminder text failed:', err.message);
    }
  }
  console.log(`Acceptance reminder texts: ${sent} sent.`);
}

async function main() {
  const now = easternNow();
  if (!MANUAL && (now.hour < SEND_FROM_HOUR || now.hour >= SEND_UNTIL_HOUR)) {
    console.log(`It's ${now.hour}:xx Eastern — outside the morning window, nothing to do.`);
    return;
  }
  const lastSent = (await db.ref(LAST_MORNING_DATE).once('value')).val();
  if (!TEST_RECIPIENT && !MANUAL && lastSent === now.date) {
    console.log('Morning lists already went out today.');
    return;
  }

  const [tasksSnap, dirSnap, phoneSnap, managerSnap] = await Promise.all([
    db.ref('faire-punch-list-tasks').once('value'),
    db.ref('faire-punch-list-directory').once('value'),
    db.ref('faire-punch-list-phones').once('value'),
    db.ref(MANAGER_SETTING).once('value'),
  ]);
  const tasksVal = tasksSnap.val();
  const tasks = (typeof tasksVal === 'string' ? parseBlob(tasksVal) : tasksVal) || [];
  const allTasks = (Array.isArray(tasks) ? tasks : Object.values(tasks)).filter(Boolean);
  const directory = parseBlob(dirSnap.val());
  const phones = parseBlob(phoneSnap.val());
  const manager = (managerSnap.val() || '').trim();

  const open = allTasks.filter(isOpen);
  const openByOwner = {};
  open.forEach(t => { const o = (t.owner || '').trim() || 'Unassigned'; (openByOwner[o] = openByOwner[o] || []).push(t); });
  const dateLabel = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric' });
  const stats = { emails: 0, teams: 0, emailFailures: 0, teamsFailures: 0, noEmail: 0 };

  if (TEST_RECIPIENT) {
    const email = directory[TEST_RECIPIENT];
    if (!email) throw new Error('TEST_RECIPIENT is not a name in the team list with an email.');
    if (openByOwner[TEST_RECIPIENT]) await deliver(TEST_RECIPIENT, email, personalMessage(TEST_RECIPIENT, openByOwner[TEST_RECIPIENT], now.date, dateLabel), stats);
    await deliver(TEST_RECIPIENT, email, managerMessage(openByOwner, now.date, dateLabel), stats);
    console.log(`Test run — sent only to the test recipient:`, JSON.stringify(stats));
    return;
  }

  await sendPendingAcceptanceReminders(allTasks, phones);

  for (const owner of Object.keys(openByOwner)) {
    if (owner === 'Unassigned') continue;
    await deliver(owner, directory[owner], personalMessage(owner, openByOwner[owner], now.date, dateLabel), stats);
  }
  if (manager) {
    await deliver(manager, directory[manager], managerMessage(openByOwner, now.date, dateLabel), stats);
  } else {
    console.log('No all-jobs recipient set in Team Management > Summary — skipped that list.');
  }

  await db.ref(LAST_MORNING_DATE).set(now.date);
  console.log(`Morning lists: ${Object.keys(openByOwner).length} people with open jobs;`, JSON.stringify(stats));
  if (stats.emails === 0 && stats.teams === 0 && (stats.emailFailures || stats.teamsFailures)) {
    throw new Error('Nothing could be delivered — see the warnings above.');
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { personalMessage, managerMessage, isOverdue };
