const DB_URL = 'https://faire-builder-tracker-default-rtdb.firebaseio.com';
const EMAILJS_SERVICE_ID = 'service_yutnnpk';
const EMAILJS_TEMPLATE_ID = 'template_d39wd5a';
const EMAILJS_PUBLIC_KEY = 'sB7w0MyBj_u6ayu_0';
const TRACKER_URL = 'https://scottbowser2026.github.io/Faire-Punch-List/';
const TZ = 'America/New_York';
const SEND_SMS_URL = 'https://us-central1-faire-builder-tracker.cloudfunctions.net/sendJobText';

async function sendPendingAcceptanceReminders(tasks) {
  const phoneRes = await fetch(`${DB_URL}/faire-punch-list-phones.json`);
  const phoneRaw = await phoneRes.json();
  let phoneDirectory = {};
  try { phoneDirectory = phoneRaw ? JSON.parse(phoneRaw) : {}; } catch (e) { phoneDirectory = {}; }

  const pendingByOwner = {};
  tasks.forEach(t => {
    if (t.pendingAcceptance && t.owner) {
      if (!pendingByOwner[t.owner]) pendingByOwner[t.owner] = [];
      pendingByOwner[t.owner].push(t.name);
    }
  });

  const owners = Object.keys(pendingByOwner);
  if (!owners.length) {
    console.log('No pending job acceptances — no reminder texts needed.');
    return;
  }

  for (const owner of owners) {
    const phone = phoneDirectory[owner];
    if (!phone) {
      console.log(`${owner} has ${pendingByOwner[owner].length} pending job(s) but no phone on file — skipping text.`);
      continue;
    }
    const jobNames = pendingByOwner[owner];
    const jobText = jobNames.length === 1
      ? `"${jobNames[0]}"`
      : `${jobNames.length} jobs`;
    const message = `Faire Punch List: Reminder — you still have ${jobText} waiting for your acceptance. Open the tracker to accept or decline: ${TRACKER_URL}`;
    try {
      const res = await fetch(SEND_SMS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: phone, message })
      });
      if (res.ok) {
        console.log(`Reminder text sent to ${owner} (${jobNames.length} pending job(s)).`);
      } else {
        console.warn(`Reminder text failed for ${owner}:`, await res.text());
      }
    } catch (err) {
      console.warn(`Reminder text failed for ${owner}:`, err.message);
    }
  }
}

async function main() {
  const [tasksRes, emailRes] = await Promise.all([
    fetch(`${DB_URL}/faire-punch-list-tasks.json`),
    fetch(`${DB_URL}/faire-punch-list-daily-summary-email.json`)
  ]);
  const tasksObj = await tasksRes.json();
  const recipient = await emailRes.json();

  const tasks = tasksObj ? (Array.isArray(tasksObj) ? tasksObj : Object.values(tasksObj)).filter(Boolean) : [];

  // Pending-acceptance reminders run regardless of whether a daily summary recipient is configured.
  await sendPendingAcceptanceReminders(tasks);

  if (!recipient) {
    console.log('No daily summary email configured in Team Management — skipping summary email.');
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const scheduled = tasks.filter(t => !t.longRange);
  const overall = scheduled.length ? Math.round(scheduled.reduce((s, t) => s + t.pct, 0) / scheduled.length) : 0;
  const overdue = scheduled.filter(t => t.due && t.pct < 100 && new Date(t.due + 'T00:00:00') < today);

  const deptOrder = [];
  tasks.forEach(t => { if (!deptOrder.includes(t.dept)) deptOrder.push(t.dept); });

  const dateLabel = new Date().toLocaleDateString('en-US', { timeZone: TZ });
  const lines = [`Faire Punch List — Daily Summary — ${dateLabel}`, ''];
  lines.push(`Overall: ${overall}% complete across ${scheduled.length} jobs.`);
  lines.push('');
  deptOrder.forEach(dept => {
    const items = tasks.filter(t => t.dept === dept && !t.longRange);
    if (!items.length) return;
    const avg = Math.round(items.reduce((s, t) => s + t.pct, 0) / items.length);
    const open = items.filter(t => t.pct < 100).length;
    lines.push(`${dept}: ${avg}% complete, ${open} job${open === 1 ? '' : 's'} open`);
  });
  if (overdue.length) {
    lines.push('', `OVERDUE (${overdue.length}):`);
    overdue.forEach(t => lines.push(`- ${t.name} (${t.dept}, due ${t.due})`));
  }
  lines.push('', `Open the tracker: ${TRACKER_URL}`);
  const message = lines.join('\n');

  const sendRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: recipient,
        to_name: 'Faire 2026',
        subject: `Faire Punch List: Daily Summary — ${dateLabel}`,
        message,
        cc_email: ''
      }
    })
  });

  if (!sendRes.ok) {
    const text = await sendRes.text();
    throw new Error(`EmailJS send failed: ${sendRes.status} ${text}`);
  }
  console.log('Daily summary sent successfully to', recipient);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const dateSetRes = await fetch(`${DB_URL}/faire-punch-list-last-summary-date.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(todayStr)
  });
  if (!dateSetRes.ok) {
    console.warn('Could not update last-summary-date (non-fatal):', await dateSetRes.text());
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
