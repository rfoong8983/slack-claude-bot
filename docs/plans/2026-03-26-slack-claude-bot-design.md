# Slack Claude Code Bot — Design

## Overview

A local TypeScript/Node.js app that connects to Slack via Socket Mode and proxies messages to a local Claude Code instance using the `@anthropic-ai/claude-code` SDK. Allows remote control of Claude Code from any device (phone, tablet, etc.) via Slack DMs or channels.

## Architecture

Three main components:

1. **Slack Adapter** — Connects via Socket Mode, listens for `app_mention` events, handles button interactions, posts messages/updates to threads.
2. **Session Manager** — Maps Slack thread IDs to Claude Code session IDs + working directory. Backed by SQLite.
3. **Claude Code Bridge** — Wraps `@anthropic-ai/claude-code` SDK. Manages invoking Claude, streaming progress, and pausing execution for tool approvals.

```
Slack (any device)
  |
  v (Socket Mode WebSocket)
Slack Adapter (@slack/bolt)
  |
  +-- @mention in new thread --> Session Manager (create session, parse working dir)
  +-- @mention in existing thread --> Session Manager (lookup session)
  +-- Button click --> Claude Code Bridge (resolve pending approval)
        |
        v
Claude Code Bridge (@anthropic-ai/claude-code SDK)
  |
  +-- onToolUse --> post approval buttons to Slack thread, wait for click
  +-- streaming progress --> update "working..." message in thread
  +-- completion --> post final response to thread
```

## Bedrock Support

Configured via environment variables inherited by the Claude Code SDK:

- `CLAUDE_CODE_USE_BEDROCK=1`
- `AWS_REGION`
- AWS credentials (via env vars or AWS profile)

## Session Lifecycle

### Start

User `@claude-bot` in a new thread with a backtick-wrapped directory path (e.g., `` `~/ted/ems` ``). Bot validates the directory exists on disk, creates a SQLite row, and sends the prompt to Claude Code.

If no directory path is provided, the bot returns an error asking the user to specify one.

### Continue

User `@claude-bot` in an existing thread. Bot looks up the session by thread_id and sends the new prompt using the stored session_id.

### Message Queueing

Messages are queued in-memory per thread using Promise chaining. If Claude is processing a message and another arrives, it queues and executes after the current one completes. The bot posts a "Queued" notice in the thread.

```typescript
const sessionQueues = new Map<string, Promise<void>>();

function enqueue(threadId: string, work: () => Promise<void>) {
  const existing = sessionQueues.get(threadId) ?? Promise.resolve();
  const next = existing.then(() => work()).catch(postErrorToThread);
  sessionQueues.set(threadId, next);
}
```

On error, the error is posted to the Slack thread and the chain continues for subsequent messages.

### Cleanup

No auto-cleanup. Claude Code sessions are just conversation history on disk — no running processes between messages. Stale SQLite rows have negligible cost.

### Error Handling

If Claude Code crashes or the SDK throws, the bot posts the error to the Slack thread. The session remains usable for subsequent messages.

## Tool Approval Flow

1. Claude Code SDK fires `onToolUse` callback with tool name and input.
2. Bot posts a message to the Slack thread with tool details and **Approve / Deny** buttons.
3. Bot returns a Promise that awaits resolution.
4. User taps a button -> Slack Adapter receives the interaction via Socket Mode -> resolves the Promise.
5. Claude Code continues or skips the tool accordingly.

**Permissions integration:** The SDK respects `~/.claude/settings.json`. Tools in the allow list run automatically (no button). Tools in the deny list are blocked automatically. Buttons only appear for tools in neither list.

**Timeout:** None. Approval waits indefinitely. Since the allow list handles routine tools, buttons only appear for unusual actions worth thinking about.

## Progress Updates & Response Format

1. Bot posts a "Working..." message with the current action (e.g., "Reading `src/app.ts`...").
2. As Claude streams tool calls, the bot **edits that same message** to reflect the latest action.
3. Rate limited to ~1 update per 1.5 seconds (Slack API constraint).
4. On completion, bot posts a **new message** in the thread with the final response.
5. Responses exceeding Slack's 4,000 character limit are split across multiple messages.

## Slack Interaction Model

- Bot responds only to `@mentions` (not every message in a thread).
- One Claude Code session per Slack thread.
- New thread + @mention = new session.
- Reply in existing thread + @mention = continue session.

## SQLite Schema

```sql
CREATE TABLE sessions (
  thread_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Slack App Configuration

### Required Scopes

- `app_mentions:read` — receive @mention events
- `chat:write` — post and update messages
- `channels:history` — read messages in public channels
- `groups:history` — read messages in private channels
- `im:history` — read DMs

### Features

- Socket Mode: enabled
- Interactivity: enabled (for approval buttons)

### Tokens

- **App-Level Token** (`xapp-...`) — for Socket Mode WebSocket connection
- **Bot Token** (`xoxb-...`) — for posting messages and API calls

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Slack:** `@slack/bolt` (handles Socket Mode + interactivity + events)
- **Claude Code:** `@anthropic-ai/claude-code` SDK
- **Database:** `better-sqlite3` (synchronous, no async overhead, local use)
