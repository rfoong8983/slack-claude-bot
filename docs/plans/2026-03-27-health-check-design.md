# Health Check Pinned Message

## Overview

A periodic health check that updates a pinned message in the bot's DM channel with the allowed user. The staleness of the "Updated" timestamp serves as the health signal across all failure modes (WiFi drop, bot crash, shutdown).

## Design

### New module: `src/health-check.ts`

**Startup:**
1. Open DM channel via `conversations.open` with `ALLOWED_USER_ID`
2. Call `pins.list` on the channel
3. Scan for a pin with `block_id: "health_check"`
4. If found, store that message `ts` for future updates
5. If not found, post a new message via `chat.postMessage`, pin it via `pins.add`, store `ts`

**Interval:**
- Every 60 seconds, aligned to the clock minute boundary
- Update the pinned message via `chat.update` with current stats
- Errors caught and logged (no crash on network failure)

**Shutdown (SIGINT/SIGTERM):**
- One final update marking status as "Offline"
- Then exit

### Message content

Uses Block Kit with `block_id: "health_check"` for reliable identification among multiple pins. Uses Slack date formatting (`<!date^UNIX^{format}|fallback>`) so timestamps render in the viewer's local timezone.

```
Bot Health
Status: Online
Uptime: 3d 12h 45m
Last activity: Mar 27, 2026 at 10:28 AM
Updated: Mar 27, 2026 at 10:30 AM
```

### Wiring

Called from `index.ts` after `app.start()`. Receives the Slack `client` and `sessionManager`.

### New Slack app scopes

- `pins:read` — to list pins and find existing health message
- `pins:write` — to pin the health message

Added to README step 3 (Bot Scopes).

## Stats displayed

- **Status**: Online / Offline
- **Uptime**: Duration since bot started
- **Last activity**: Most recent `last_active_at` from sessions table (Slack date format)
- **Updated**: Timestamp of this health check update (Slack date format)

## Error handling

All `chat.update` calls are wrapped in try/catch with console logging. The stale "Updated" timestamp is the universal health signal — no special handling needed for WiFi drops, crashes, or unclean shutdowns.
