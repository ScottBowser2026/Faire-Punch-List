// GitHub's manual "Run workflow" button for the morning job lists. The real
// 7:45 AM run is the sendMorningLists Cloud Function — GitHub's own schedule
// started runs hours late, so it no longer schedules anything.
const admin = require('firebase-admin');
const { runMorningLists } = require('../functions/morning-lists-core');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: 'https://faire-builder-tracker-default-rtdb.firebaseio.com'
});

runMorningLists({
  db: admin.database(),
  emailjsKey: process.env.EMAILJS_PRIVATE_KEY,
  teamsUrl: process.env.TEAMS_WORKFLOW_URL || '',
  testRecipient: (process.env.TEST_RECIPIENT || '').trim(),
})
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
