# slack-claude-bot

A Slack bot that runs Claude Code sessions via DM. Each thread maps to a Claude Code session scoped to a local repo directory.

## Slack App Setup

### 1. Create a Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" > "From scratch"
3. Name it "claudebot" and select your workspace

### 2. Enable Socket Mode

1. Go to "Socket Mode" in the sidebar
2. Toggle "Enable Socket Mode" ON
3. Create an app-level token with scope `connections:write`
4. Copy the `xapp-...` token — this is your `SLACK_APP_TOKEN`

### 3. Add Bot Scopes

1. Go to "OAuth & Permissions"
2. Under "Bot Token Scopes", add:
   - `chat:write`
   - `im:history`
3. Install the app to your workspace
4. Copy the `xoxb-...` token — this is your `SLACK_BOT_TOKEN`

### 4. Enable Events

1. Go to "Event Subscriptions"
2. Toggle "Enable Events" ON
3. Under "Subscribe to bot events", add:
   - `message.im`

### 5. Enable Interactivity

1. Go to "Interactivity & Shortcuts"
2. Toggle "Interactivity" ON
(No request URL needed — Socket Mode handles it)

### 6. Configure Environment

Copy `.env.example` to `.env` and fill in the values:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
ALLOWED_USER_ID=U-your-slack-user-id
```

To find your Slack user ID: click your profile picture > "Profile" > click the three dots > "Copy member ID".

Ensure your AWS credentials are configured (via env vars, `~/.aws/credentials`, or AWS profile) for Bedrock access.

### 7. Start the Bot

```bash
npm run dev
```

### Running with the Lid Closed

To keep the bot running with the Mac lid closed, you need the Mac to stay awake and connected to WiFi. This requires a power adapter and Amphetamine (free on the Mac App Store).

#### Setup

1. Install Amphetamine from the Mac App Store
2. If on Apple Silicon, install Amphetamine Power Protect to handle power adapter disconnect/reconnect
3. Open Amphetamine Preferences > Session Defaults > Closed-Display Mode
   a. **Uncheck** "Closed-Display Mode: Allow system sleep when display is closed"

#### Running

1. Plug in your power adapter
2. Start the bot: `npm run dev`
3. Start an Amphetamine session (menu bar icon > "Start New Session" > "Indefinitely")
4. Lock the screen: `Ctrl+Cmd+Q`
5. Close the lid

The Mac stays awake with WiFi active, the screen is locked, and the bot keeps running. When you open the lid, you'll need your password/Touch ID to unlock.

**Note:** This does not work on battery — macOS will sleep when the lid closes without power connected.

## Usage

Open a DM with @claudebot and send a message:

- Start a session: `repo:ems fix the login bug`
- Continue in thread: reply with `now add tests for it`
- Tool approvals appear as Approve/Deny buttons in the thread
- Each top-level message starts a new session; reply in-thread to continue

The bot only responds to the configured `ALLOWED_USER_ID`.

## Querying Sessions

The bot stores thread-to-session mappings in a SQLite database (`slack-claude-bot.db` by default, configurable via `DB_PATH`).

You can query it directly with `sqlite3`:

```bash
# Open the database
sqlite3 slack-claude-bot.db

# List all sessions
SELECT thread_id, session_id, working_directory, created_at, last_active_at
FROM sessions
ORDER BY last_active_at DESC;

# Find sessions for a specific repo
SELECT * FROM sessions WHERE working_directory LIKE '%/ems';

# Find a session by thread ID
SELECT * FROM sessions WHERE thread_id = '1774563032.718379';

# See active sessions from the last 24 hours
SELECT thread_id, session_id, working_directory, last_active_at
FROM sessions
WHERE last_active_at > datetime('now', '-1 day')
ORDER BY last_active_at DESC;

# Count sessions per repo
SELECT working_directory, COUNT(*) as session_count
FROM sessions
GROUP BY working_directory
ORDER BY session_count DESC;
```

### Schema

| Column | Type | Description |
|---|---|---|
| `thread_id` | TEXT (PK) | Slack thread timestamp |
| `channel_id` | TEXT | Slack DM channel ID |
| `session_id` | TEXT | Claude Code session ID (for resuming) |
| `working_directory` | TEXT | Local repo path (e.g. `~/ted/ems`) |
| `created_at` | DATETIME | When the session was created |
| `last_active_at` | DATETIME | Last message in the thread |
