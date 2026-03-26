# Slack App Setup

## 1. Create a Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" > "From scratch"
3. Name it "claudebot" and select your workspace

## 2. Enable Socket Mode

1. Go to "Socket Mode" in the sidebar
2. Toggle "Enable Socket Mode" ON
3. Create an app-level token with scope `connections:write`
4. Copy the `xapp-...` token — this is your `SLACK_APP_TOKEN`

## 3. Add Bot Scopes

1. Go to "OAuth & Permissions"
2. Under "Bot Token Scopes", add:
   - `chat:write`
   - `im:history`
3. Install the app to your workspace
4. Copy the `xoxb-...` token — this is your `SLACK_BOT_TOKEN`

## 4. Enable Events

1. Go to "Event Subscriptions"
2. Toggle "Enable Events" ON
3. Under "Subscribe to bot events", add:
   - `message.im`

## 5. Enable Interactivity

1. Go to "Interactivity & Shortcuts"
2. Toggle "Interactivity" ON
(No request URL needed — Socket Mode handles it)

## 6. Configure Environment

Copy `.env.example` to `.env` and fill in the values:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
ALLOWED_USER_ID=U-your-slack-user-id
```

To find your Slack user ID: click your profile picture > "Profile" > click the three dots > "Copy member ID".

Ensure your AWS credentials are configured (via env vars, `~/.aws/credentials`, or AWS profile) for Bedrock access.

## 7. Start the Bot

```bash
npm run dev
```

## Usage

Open a DM with @claudebot and send a message:

- Start a session: `repo:ems fix the login bug`
- Continue in thread: reply with `now add tests for it`
- Tool approvals appear as Approve/Deny buttons in the thread
- Each top-level message starts a new session; reply in-thread to continue

The bot only responds to the configured `ALLOWED_USER_ID`.
