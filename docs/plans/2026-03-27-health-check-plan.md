# Health Check Pinned Message — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Periodically update a pinned Slack message with bot health stats (status, uptime, last activity) every minute.

**Architecture:** New `health-check.ts` module discovers or creates a pinned health message on startup, then updates it every 60s via `chat.update`. Uses Block Kit with a stable `block_id` to identify the message among multiple pins. Shutdown handler posts a final "Offline" update.

**Tech Stack:** @slack/bolt client, better-sqlite3 (existing), vitest for tests

---

### Task 1: Add `getLastActiveAt()` to SessionManager

**Files:**
- Modify: `src/session-manager.ts:19-73`
- Modify: `src/session-manager.test.ts`

**Step 1: Write the failing test**

Add to `src/session-manager.test.ts`:

```typescript
it("returns the most recent last_active_at", () => {
  manager.createSession({
    threadId: "thread_1",
    channelId: "C1",
    sessionId: "s1",
    workingDirectory: "/tmp/a",
  });
  manager.createSession({
    threadId: "thread_2",
    channelId: "C2",
    sessionId: "s2",
    workingDirectory: "/tmp/b",
  });
  manager.touchSession("thread_2");

  const lastActive = manager.getLastActiveAt();
  expect(lastActive).toBeDefined();
  expect(typeof lastActive).toBe("string");
});

it("returns undefined when no sessions exist", () => {
  const lastActive = manager.getLastActiveAt();
  expect(lastActive).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-manager.test.ts`
Expected: FAIL — `getLastActiveAt` is not a function

**Step 3: Write minimal implementation**

Add to `SessionManager` class in `src/session-manager.ts`:

```typescript
getLastActiveAt(): string | undefined {
  const row = this.db
    .prepare("SELECT MAX(last_active_at) as last_active FROM sessions")
    .get() as any;
  return row?.last_active ?? undefined;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/session-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/session-manager.ts src/session-manager.test.ts
git commit -m "feat: add getLastActiveAt to SessionManager"
```

---

### Task 2: Create `health-check.ts` — core module

**Files:**
- Create: `src/health-check.ts`

**Step 1: Create the health check module**

Create `src/health-check.ts` with:

```typescript
import type { WebClient } from "@slack/web-api";
import type { SessionManager } from "./session-manager.js";
import { config } from "./config.js";

const HEALTH_BLOCK_ID = "health_check";
const UPDATE_INTERVAL_MS = 60_000;

const startTime = Date.now();

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function slackDate(unixSeconds: number, format: string, fallback: string): string {
  return `<!date^${unixSeconds}^${format}|${fallback}>`;
}

function buildHealthBlocks(sessionManager: SessionManager, online: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const uptime = formatUptime(Date.now() - startTime);
  const status = online ? ":large_green_circle: Online" : ":red_circle: Offline";

  const lastActiveIso = sessionManager.getLastActiveAt();
  let lastActivityLine: string;
  if (lastActiveIso) {
    const lastActiveSec = Math.floor(new Date(lastActiveIso).getTime() / 1000);
    lastActivityLine = `*Last activity:* ${slackDate(lastActiveSec, "{date_short_pretty} at {time}", lastActiveIso)}`;
  } else {
    lastActivityLine = "*Last activity:* No sessions yet";
  }

  return {
    text: `Bot Health — ${online ? "Online" : "Offline"}`,
    blocks: [
      {
        type: "section",
        block_id: HEALTH_BLOCK_ID,
        text: {
          type: "mrkdwn",
          text: [
            "*Bot Health*",
            `*Status:* ${status}`,
            `*Uptime:* ${uptime}`,
            lastActivityLine,
            `*Updated:* ${slackDate(now, "{date_short_pretty} at {time}", new Date().toISOString())}`,
          ].join("\n"),
        },
      },
    ],
  };
}

async function findHealthPin(client: WebClient, channel: string): Promise<string | undefined> {
  try {
    const result = await client.pins.list({ channel });
    const items = (result as any).items ?? [];
    for (const item of items) {
      const blocks = item.message?.blocks ?? [];
      if (blocks.some((b: any) => b.block_id === HEALTH_BLOCK_ID)) {
        return item.message.ts;
      }
    }
  } catch (err: any) {
    console.error(`[health] failed to list pins: ${err.message}`);
  }
  return undefined;
}

export async function startHealthCheck(
  client: WebClient,
  sessionManager: SessionManager
): Promise<() => void> {
  // Open DM channel with allowed user
  const openResult = await client.conversations.open({
    users: config.allowedUserId,
  });
  const channel = openResult.channel?.id;
  if (!channel) {
    console.error("[health] could not open DM channel");
    return () => {};
  }
  console.log(`[health] DM channel=${channel}`);

  // Find existing pinned health message or create one
  let messageTs = await findHealthPin(client, channel);

  if (messageTs) {
    console.log(`[health] found existing pin ts=${messageTs}`);
  } else {
    try {
      const { text, blocks } = buildHealthBlocks(sessionManager, true);
      const postResult = await client.chat.postMessage({ channel, text, blocks });
      messageTs = postResult.ts!;
      await client.pins.add({ channel, timestamp: messageTs });
      console.log(`[health] created and pinned new message ts=${messageTs}`);
    } catch (err: any) {
      console.error(`[health] failed to create health message: ${err.message}`);
      return () => {};
    }
  }

  // Update function
  const update = async (online: boolean) => {
    try {
      const { text, blocks } = buildHealthBlocks(sessionManager, online);
      await client.chat.update({ channel, ts: messageTs!, text, blocks });
    } catch (err: any) {
      console.error(`[health] failed to update: ${err.message}`);
    }
  };

  // Initial update
  await update(true);

  // Align to next minute boundary
  const msUntilNextMinute = UPDATE_INTERVAL_MS - (Date.now() % UPDATE_INTERVAL_MS);
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const alignTimeout = setTimeout(() => {
    update(true);
    intervalId = setInterval(() => update(true), UPDATE_INTERVAL_MS);
  }, msUntilNextMinute);

  // Return cleanup/shutdown function
  return async () => {
    clearTimeout(alignTimeout);
    if (intervalId) clearInterval(intervalId);
    await update(false);
  };
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/health-check.ts
git commit -m "feat: add health-check module with pinned message"
```

---

### Task 3: Wire health check into `index.ts` with shutdown handler

**Files:**
- Modify: `src/index.ts:1-19`

**Step 1: Update index.ts**

Replace contents of `src/index.ts` with:

```typescript
import Database from "better-sqlite3";
import { SessionManager } from "./session-manager.js";
import { createApp } from "./slack-adapter.js";
import { startHealthCheck } from "./health-check.js";
import { config } from "./config.js";

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

const sessionManager = new SessionManager(db);
const app = createApp(sessionManager);

(async () => {
  await app.start();
  console.log("slack-claude-bot is running");
  console.log(`  CLAUDE_CODE_USE_BEDROCK=${process.env.CLAUDE_CODE_USE_BEDROCK ?? "unset"}`);
  console.log(`  AWS_REGION=${process.env.AWS_REGION ?? "unset"}`);
  console.log(`  AWS_PROFILE=${process.env.AWS_PROFILE ?? "unset"}`);
  console.log(`  DB_PATH=${config.dbPath}`);

  const shutdownHealth = await startHealthCheck(app.client, sessionManager);

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] received ${signal}`);
    await shutdownHealth();
    await app.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
})();
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire health check into startup with shutdown handler"
```

---

### Task 4: Add tests for health-check module

**Files:**
- Create: `src/health-check.test.ts`

**Step 1: Write tests**

Create `src/health-check.test.ts`. Test the pure functions by extracting them or testing via the module's behavior. Since the core logic involves Slack API calls, test `formatUptime` and `buildHealthBlocks` by importing them. To make them testable, export them from `health-check.ts`.

First, add exports to `src/health-check.ts` — add `export` to `formatUptime` and `buildHealthBlocks`:

```typescript
// In health-check.ts, change:
//   function formatUptime(...)
//   function buildHealthBlocks(...)
// to:
//   export function formatUptime(...)
//   export function buildHealthBlocks(...)
```

Then create `src/health-check.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatUptime, buildHealthBlocks } from "./health-check.js";
import { SessionManager } from "./session-manager.js";
import Database from "better-sqlite3";

describe("formatUptime", () => {
  it("formats minutes only", () => {
    expect(formatUptime(5 * 60 * 1000)).toBe("5m");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(2 * 3600 * 1000 + 30 * 60 * 1000)).toBe("2h 30m");
  });

  it("formats days, hours, and minutes", () => {
    expect(formatUptime(3 * 86400 * 1000 + 12 * 3600 * 1000 + 45 * 60 * 1000)).toBe("3d 12h 45m");
  });

  it("formats zero as 0m", () => {
    expect(formatUptime(0)).toBe("0m");
  });
});

describe("buildHealthBlocks", () => {
  let db: Database.Database;
  let sessionManager: SessionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    sessionManager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns blocks with health_check block_id when online", () => {
    const result = buildHealthBlocks(sessionManager, true);
    expect(result.text).toContain("Online");
    expect(result.blocks[0].block_id).toBe("health_check");
    expect(result.blocks[0].text.text).toContain("Online");
  });

  it("returns blocks with Offline status when offline", () => {
    const result = buildHealthBlocks(sessionManager, false);
    expect(result.text).toContain("Offline");
    expect(result.blocks[0].text.text).toContain("Offline");
  });

  it("shows 'No sessions yet' when no sessions exist", () => {
    const result = buildHealthBlocks(sessionManager, true);
    expect(result.blocks[0].text.text).toContain("No sessions yet");
  });

  it("shows last activity date when sessions exist", () => {
    sessionManager.createSession({
      threadId: "t1",
      channelId: "C1",
      sessionId: "s1",
      workingDirectory: "/tmp/a",
    });
    const result = buildHealthBlocks(sessionManager, true);
    expect(result.blocks[0].text.text).toContain("<!date^");
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run src/health-check.test.ts`
Expected: PASS

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/health-check.ts src/health-check.test.ts
git commit -m "test: add health-check unit tests"
```

---

### Task 5: Update README with new Slack scopes

**Files:**
- Modify: `README.md:21-27`

**Step 1: Update the Bot Scopes section**

In `README.md`, update step 3 to include the new scopes:

```markdown
### 3. Add Bot Scopes

1. Go to "OAuth & Permissions"
2. Under "Bot Token Scopes", add:
   - `chat:write`
   - `im:history`
   - `pins:read`
   - `pins:write`
3. Install the app to your workspace
4. Copy the `xoxb-...` token — this is your `SLACK_BOT_TOKEN`
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add pins:read and pins:write to required bot scopes"
```

---

### Task 6: Manual verification

**Step 1: Start the bot**

Run: `npm run dev`

Expected console output includes:
```
[health] DM channel=D...
[health] created and pinned new message ts=...
```

**Step 2: Verify in Slack**

1. Open the bot in the Apps section
2. Check pins — should see the health message pinned
3. Wait 1 minute — message should update with new timestamp
4. Stop the bot with Ctrl+C — message should show "Offline"

**Step 3: Restart and verify pin reuse**

Run: `npm run dev` again

Expected console output:
```
[health] found existing pin ts=...
```

The bot should update the existing pinned message, not create a new one.
