# Sending the morning job lists to Teams chat

The 7:45 AM job (`scripts/send-daily-summary.js`) emails everyone their open
jobs. To also send each list as a one-to-one Teams chat, create one Teams
workflow that receives the message and posts it to that person. This takes
about 10 minutes and is done once.

Only people with a parenfaire.com Microsoft account can get Teams chats.
Anyone else still gets the email.

## 1. Create the workflow

1. In Teams, open **Workflows** (left bar, or **Apps → Workflows**).
2. Click **New flow → Create from blank**.
3. Search for the trigger **When a Teams webhook request is received** and
   add it. Set **Who can trigger the flow** to **Anyone**.
4. Click **New step**, search for **Post message in a chat or channel**, and
   add it:
   - **Post as:** Flow bot
   - **Post in:** Chat with Flow bot
   - **Recipient:** click in the box, choose **Expression**, paste
     `triggerBody()?['email']` and click **OK**
   - **Message:** choose **Expression**, paste `triggerBody()?['html']` and
     click **OK**
5. Name it **Punch List morning lists** and click **Save**.
6. Open the trigger again and copy the **HTTP POST URL** it now shows.

Treat that URL like a password: anyone who has it can post Teams messages
as the Flow bot.

## 2. Give the URL to GitHub

1. Go to
   https://github.com/ScottBowser2026/Faire-Punch-List/settings/secrets/actions
2. Click **New repository secret**.
3. Name: `TEAMS_WORKFLOW_URL`. Secret: paste the URL. Click **Add secret**.

## 3. Test it on yourself

1. Go to
   https://github.com/ScottBowser2026/Faire-Punch-List/actions/workflows/daily-summary.yml
2. Click **Run workflow**, type your name exactly as it appears in the team
   list (for example `Scott Bowser`) in the test box, and click the green
   **Run workflow** button.
3. You should get your own list (if you own any open jobs) and the all-jobs
   list, by Teams chat and by email. Nobody else gets anything.

Leaving the test box blank sends everyone their list right away.
