# Slack App Setup

## 1. Create a Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" > "From scratch"
3. Name it (e.g., "Claude Code Bot") and select your workspace

## 2. Enable Socket Mode

1. Go to "Socket Mode" in the sidebar
2. Toggle "Enable Socket Mode" ON
3. Create an app-level token with scope `connections:write`
4. Copy the `xapp-...` token — this is your `SLACK_APP_TOKEN`

## 3. Add Bot Scopes

1. Go to "OAuth & Permissions"
2. Under "Bot Token Scopes", add:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `groups:history`
   - `im:history`
3. Install the app to your workspace
4. Copy the `xoxb-...` token — this is your `SLACK_BOT_TOKEN`

## 4. Enable Events

1. Go to "Event Subscriptions"
2. Toggle "Enable Events" ON
3. Under "Subscribe to bot events", add:
   - `app_mention`

## 5. Enable Interactivity

1. Go to "Interactivity & Shortcuts"
2. Toggle "Interactivity" ON
(No request URL needed — Socket Mode handles it)

## 6. Configure Environment

Copy `.env.example` to `.env` and fill in the tokens:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

Ensure your AWS credentials are configured (via env vars, `~/.aws/credentials`, or AWS profile) for Bedrock access.

## 7. Start the Bot

```bash
npm run dev
```

## Usage

In any channel where the bot is invited (or in a DM):

- Start a session: `@Claude Code Bot `~/path/to/project` fix the login bug`
- Continue in thread: `@Claude Code Bot now add tests for it`
- Tool approvals appear as Approve/Deny buttons in the thread
