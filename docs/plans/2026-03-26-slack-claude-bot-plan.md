# Slack Claude Code Bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local Slack bot that proxies messages to Claude Code via the SDK, with interactive tool approval buttons and session continuity per thread.

**Architecture:** A TypeScript Node.js app using `@slack/bolt` (Socket Mode) for Slack connectivity and `@anthropic-ai/claude-agent-sdk` for Claude Code integration, with `better-sqlite3` for session persistence. Three modules: Slack adapter, session manager, Claude Code bridge.

**Tech Stack:** TypeScript, Node.js, @slack/bolt, @anthropic-ai/claude-agent-sdk, better-sqlite3

**Design doc:** `docs/plans/2026-03-26-slack-claude-bot-design.md`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/index.ts` (empty entry point)

**Step 1: Initialize the project**

```bash
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install @slack/bolt @anthropic-ai/claude-agent-sdk better-sqlite3 dotenv
npm install -D typescript @types/node @types/better-sqlite3 tsx vitest
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

**Step 4: Update package.json scripts**

Add to `package.json`:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run"
  }
}
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.db
```

**Step 6: Create .env.example**

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
# Optional: Bedrock support
# CLAUDE_CODE_USE_BEDROCK=1
# AWS_REGION=us-west-2
```

**Step 7: Create empty entry point**

```typescript
// src/index.ts
console.log("slack-claude-bot bot starting...");
```

**Step 8: Verify it runs**

Run: `npm run dev`
Expected: Prints "slack-claude-bot bot starting..."

**Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example src/index.ts
git commit -m "feat: scaffold TypeScript project with dependencies"
```

---

### Task 2: SQLite Session Manager

**Files:**
- Create: `src/session-manager.ts`
- Create: `src/session-manager.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/session-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionManager } from "./session-manager.js";
import Database from "better-sqlite3";

describe("SessionManager", () => {
  let db: Database.Database;
  let manager: SessionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a session and retrieves it", () => {
    manager.createSession({
      threadId: "thread_123",
      channelId: "C123",
      sessionId: "session_abc",
      workingDirectory: "/Users/test/project",
    });

    const session = manager.getSession("thread_123");
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe("session_abc");
    expect(session!.workingDirectory).toBe("/Users/test/project");
    expect(session!.channelId).toBe("C123");
  });

  it("returns undefined for nonexistent session", () => {
    const session = manager.getSession("thread_999");
    expect(session).toBeUndefined();
  });

  it("updates last_active_at on touch", () => {
    manager.createSession({
      threadId: "thread_123",
      channelId: "C123",
      sessionId: "session_abc",
      workingDirectory: "/tmp/test",
    });

    const before = manager.getSession("thread_123")!.lastActiveAt;
    manager.touchSession("thread_123");
    const after = manager.getSession("thread_123")!.lastActiveAt;
    expect(after).not.toBe(before);
  });

  it("updates session ID", () => {
    manager.createSession({
      threadId: "thread_123",
      channelId: "C123",
      sessionId: "placeholder",
      workingDirectory: "/tmp/test",
    });

    manager.updateSessionId("thread_123", "real_session_id");

    const session = manager.getSession("thread_123");
    expect(session!.sessionId).toBe("real_session_id");
  });
});
```

**Step 2: Run tests to verify failure**

Run: `npx vitest run src/session-manager.test.ts`
Expected: FAIL — cannot find `./session-manager.js`

**Step 3: Implement SessionManager**

```typescript
// src/session-manager.ts
import Database from "better-sqlite3";

export interface Session {
  threadId: string;
  channelId: string;
  sessionId: string;
  workingDirectory: string;
  createdAt: string;
  lastActiveAt: string;
}

interface CreateSessionParams {
  threadId: string;
  channelId: string;
  sessionId: string;
  workingDirectory: string;
}

export class SessionManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  createSession(params: CreateSessionParams): void {
    this.db
      .prepare(
        `INSERT INTO sessions (thread_id, channel_id, session_id, working_directory)
         VALUES (?, ?, ?, ?)`
      )
      .run(params.threadId, params.channelId, params.sessionId, params.workingDirectory);
  }

  getSession(threadId: string): Session | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE thread_id = ?")
      .get(threadId) as any;

    if (!row) return undefined;

    return {
      threadId: row.thread_id,
      channelId: row.channel_id,
      sessionId: row.session_id,
      workingDirectory: row.working_directory,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  touchSession(threadId: string): void {
    this.db
      .prepare("UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE thread_id = ?")
      .run(threadId);
  }

  updateSessionId(threadId: string, sessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET session_id = ? WHERE thread_id = ?")
      .run(sessionId, threadId);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session-manager.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/session-manager.ts src/session-manager.test.ts
git commit -m "feat: add SQLite session manager with tests"
```

---

### Task 3: Message Queue

**Files:**
- Create: `src/message-queue.ts`
- Create: `src/message-queue.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/message-queue.test.ts
import { describe, it, expect } from "vitest";
import { MessageQueue } from "./message-queue.js";

describe("MessageQueue", () => {
  it("executes tasks sequentially per thread", async () => {
    const queue = new MessageQueue();
    const order: string[] = [];

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    queue.enqueue("thread_1", async () => {
      await delay(50);
      order.push("A");
    });

    queue.enqueue("thread_1", async () => {
      order.push("B");
    });

    await queue.enqueue("thread_1", async () => {
      order.push("C");
    });

    expect(order).toEqual(["A", "B", "C"]);
  });

  it("executes different threads concurrently", async () => {
    const queue = new MessageQueue();
    const order: string[] = [];

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const p1 = queue.enqueue("thread_1", async () => {
      await delay(50);
      order.push("thread_1");
    });

    const p2 = queue.enqueue("thread_2", async () => {
      order.push("thread_2");
    });

    await Promise.all([p1, p2]);

    expect(order).toEqual(["thread_2", "thread_1"]);
  });

  it("continues queue after error", async () => {
    const queue = new MessageQueue();
    const errors: Error[] = [];
    const results: string[] = [];

    queue.enqueue(
      "thread_1",
      async () => { throw new Error("boom"); },
      (err) => errors.push(err)
    );

    await queue.enqueue("thread_1", async () => {
      results.push("after_error");
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
    expect(results).toEqual(["after_error"]);
  });
});
```

**Step 2: Run tests to verify failure**

Run: `npx vitest run src/message-queue.test.ts`
Expected: FAIL — cannot find `./message-queue.js`

**Step 3: Implement MessageQueue**

```typescript
// src/message-queue.ts
export class MessageQueue {
  private queues = new Map<string, Promise<void>>();

  enqueue(
    threadId: string,
    work: () => Promise<void>,
    onError?: (err: Error) => void
  ): Promise<void> {
    const existing = this.queues.get(threadId) ?? Promise.resolve();
    const next = existing.then(() => work()).catch((err) => {
      if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    });
    this.queues.set(threadId, next);
    return next;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/message-queue.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/message-queue.ts src/message-queue.test.ts
git commit -m "feat: add message queue with per-thread sequential execution"
```

---

### Task 4: Claude Code Bridge

**Files:**
- Create: `src/claude-bridge.ts`

The bridge wraps the `@anthropic-ai/claude-agent-sdk` `query()` function. It cannot be unit tested without the real SDK, so we test it end-to-end in Task 8.

**Step 1: Implement the bridge**

```typescript
// src/claude-bridge.ts
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ToolApprovalRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  resolve: (approved: boolean) => void;
}

export interface BridgeCallbacks {
  onProgress: (toolName: string) => void;
  onResult: (text: string) => void;
  onError: (error: Error) => void;
  onToolApproval: (request: ToolApprovalRequest) => void;
}

export async function runClaudeQuery(
  prompt: string,
  opts: {
    cwd: string;
    sessionId?: string;
    callbacks: BridgeCallbacks;
  }
): Promise<string | undefined> {
  let resultSessionId: string | undefined;

  const queryOpts: Record<string, unknown> = {
    cwd: opts.cwd,
    permissionMode: "default",
    canUseTool: async (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID: string }
    ) => {
      return new Promise<{ behavior: string; message?: string }>((resolve) => {
        opts.callbacks.onToolApproval({
          toolName,
          toolInput: input,
          toolUseId: options.toolUseID,
          resolve: (approved: boolean) => {
            if (approved) {
              resolve({ behavior: "allow" });
            } else {
              resolve({ behavior: "deny", message: "Denied via Slack" });
            }
          },
        });
      });
    },
  };

  if (opts.sessionId) {
    queryOpts.resume = opts.sessionId;
  }

  try {
    for await (const message of query({
      prompt,
      options: queryOpts as any,
    })) {
      const msg = message as SDKMessage & Record<string, unknown>;

      if (msg.type === "system" && (msg as any).subtype === "init") {
        resultSessionId = (msg as any).session_id;
      }

      if (msg.type === "tool_progress") {
        opts.callbacks.onProgress((msg as any).tool_name);
      }

      if (msg.type === "result") {
        const resultText = (msg as any).result ?? "";
        opts.callbacks.onResult(resultText);
      }
    }
  } catch (err) {
    opts.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }

  return resultSessionId;
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/claude-bridge.ts
git commit -m "feat: add Claude Code bridge wrapping agent SDK"
```

---

### Task 5: Config Module

**Files:**
- Create: `src/config.ts`

**Step 1: Create config module**

```typescript
// src/config.ts
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackAppToken: required("SLACK_APP_TOKEN"),
  dbPath: process.env.DB_PATH ?? "slack-claude-bot.db",
};
```

**Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: add config module for env vars"
```

---

### Task 6: Slack Adapter

**Files:**
- Create: `src/slack-adapter.ts`

This is the main wiring module connecting Slack events to the session manager and Claude bridge.

**Step 1: Implement the adapter**

```typescript
// src/slack-adapter.ts
import { App } from "@slack/bolt";
import { SessionManager } from "./session-manager.js";
import { MessageQueue } from "./message-queue.js";
import { runClaudeQuery, type ToolApprovalRequest } from "./claude-bridge.js";
import { config } from "./config.js";
import { randomUUID } from "crypto";
import { existsSync } from "fs";

const WORKING_DIR_REGEX = /`(~\/[^`]+|\/[^`]+)`/;
const SLACK_MSG_LIMIT = 4000;
const PROGRESS_THROTTLE_MS = 1500;

export function createApp(sessionManager: SessionManager): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const queue = new MessageQueue();
  const pendingApprovals = new Map<string, ToolApprovalRequest>();

  app.event("app_mention", async ({ event, client }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const userText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

    const existingSession = event.thread_ts
      ? sessionManager.getSession(threadTs)
      : undefined;

    if (!existingSession) {
      const match = userText.match(WORKING_DIR_REGEX);
      if (!match) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: "Please specify a working directory in backticks, e.g. `~/ted/ems`",
        });
        return;
      }

      const dir = match[1].replace(/^~/, process.env.HOME ?? "~");
      if (!existsSync(dir)) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Directory not found: \`${dir}\``,
        });
        return;
      }

      const prompt = userText.replace(WORKING_DIR_REGEX, "").trim();
      if (!prompt) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: "What would you like Claude to do?",
        });
        return;
      }

      const placeholderId = randomUUID();
      sessionManager.createSession({
        threadId: threadTs,
        channelId,
        sessionId: placeholderId,
        workingDirectory: dir,
      });

      enqueuePrompt(queue, client, sessionManager, pendingApprovals, {
        channelId,
        threadTs,
        prompt,
        cwd: dir,
        resumeSessionId: undefined,
      });
    } else {
      sessionManager.touchSession(threadTs);
      enqueuePrompt(queue, client, sessionManager, pendingApprovals, {
        channelId,
        threadTs,
        prompt: userText,
        cwd: existingSession.workingDirectory,
        resumeSessionId: existingSession.sessionId,
      });
    }
  });

  app.action(/^(approve|deny)_/, async ({ action, ack, body }) => {
    await ack();

    const actionId = (action as any).action_id as string;
    const approved = actionId.startsWith("approve_");
    const toolUseId = actionId.replace(/^(approve|deny)_/, "");

    const request = pendingApprovals.get(toolUseId);
    if (request) {
      request.resolve(approved);
      pendingApprovals.delete(toolUseId);
    }

    const userName = (body as any).user?.name ?? "User";
    const decision = approved ? "Approved" : "Denied";

    await app.client.chat.update({
      channel: (body as any).channel?.id,
      ts: (body as any).message?.ts,
      text: `${decision} by ${userName}: ${request?.toolName ?? "tool"}`,
      blocks: [],
    });
  });

  return app;
}

function enqueuePrompt(
  queue: MessageQueue,
  client: any,
  sessionManager: SessionManager,
  pendingApprovals: Map<string, ToolApprovalRequest>,
  opts: {
    channelId: string;
    threadTs: string;
    prompt: string;
    cwd: string;
    resumeSessionId: string | undefined;
  }
): void {
  queue.enqueue(
    opts.threadTs,
    async () => {
      const statusMsg = await client.chat.postMessage({
        channel: opts.channelId,
        thread_ts: opts.threadTs,
        text: "Working...",
      });
      const statusTs = statusMsg.ts;

      let lastProgressUpdate = 0;

      const newSessionId = await runClaudeQuery(opts.prompt, {
        cwd: opts.cwd,
        sessionId: opts.resumeSessionId,
        callbacks: {
          onProgress: (toolName: string) => {
            const now = Date.now();
            if (now - lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
            lastProgressUpdate = now;

            client.chat.update({
              channel: opts.channelId,
              ts: statusTs,
              text: `Working... (${toolName})`,
            }).catch(() => {});
          },

          onResult: (text: string) => {
            client.chat.update({
              channel: opts.channelId,
              ts: statusTs,
              text: "Done.",
            }).catch(() => {});

            const chunks = splitMessage(text);
            for (const chunk of chunks) {
              client.chat.postMessage({
                channel: opts.channelId,
                thread_ts: opts.threadTs,
                text: chunk,
              }).catch(() => {});
            }
          },

          onError: (error: Error) => {
            client.chat.update({
              channel: opts.channelId,
              ts: statusTs,
              text: `Error: ${error.message}`,
            }).catch(() => {});
          },

          onToolApproval: (request: ToolApprovalRequest) => {
            pendingApprovals.set(request.toolUseId, request);

            const inputPreview = JSON.stringify(request.toolInput, null, 2);
            const truncated =
              inputPreview.length > 2000
                ? inputPreview.slice(0, 2000) + "\n..."
                : inputPreview;

            client.chat.postMessage({
              channel: opts.channelId,
              thread_ts: opts.threadTs,
              text: `Tool approval needed: ${request.toolName}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*Claude wants to use:* \`${request.toolName}\`\n\`\`\`${truncated}\`\`\``,
                  },
                },
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Approve" },
                      style: "primary",
                      action_id: `approve_${request.toolUseId}`,
                    },
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Deny" },
                      style: "danger",
                      action_id: `deny_${request.toolUseId}`,
                    },
                  ],
                },
              ],
            }).catch(() => {});
          },
        },
      });

      if (!opts.resumeSessionId && newSessionId) {
        sessionManager.updateSessionId(opts.threadTs, newSessionId);
      }
    },
    (err) => {
      client.chat.postMessage({
        channel: opts.channelId,
        thread_ts: opts.threadTs,
        text: `Error: ${err.message}`,
      }).catch(() => {});
    }
  );
}

function splitMessage(text: string): string[] {
  if (text.length <= SLACK_MSG_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }
    const cutoff = remaining.lastIndexOf("\n", SLACK_MSG_LIMIT);
    const splitAt = cutoff > SLACK_MSG_LIMIT / 2 ? cutoff : SLACK_MSG_LIMIT;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/slack-adapter.ts
git commit -m "feat: add Slack adapter with mention handler and tool approval buttons"
```

---

### Task 7: Wire Up Entry Point

**Files:**
- Modify: `src/index.ts`

**Step 1: Update entry point**

```typescript
// src/index.ts
import Database from "better-sqlite3";
import { SessionManager } from "./session-manager.js";
import { createApp } from "./slack-adapter.js";
import { config } from "./config.js";

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

const sessionManager = new SessionManager(db);
const app = createApp(sessionManager);

(async () => {
  await app.start();
  console.log("slack-claude-bot bot is running");
})();
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up entry point with database and Slack app"
```

---

### Task 8: Slack App Setup Documentation

**Files:**
- Create: `docs/slack-app-setup.md`

**Step 1: Write the setup guide**

```markdown
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

## 7. Start the Bot

```bash
npm run dev
```

## Usage

In any channel where the bot is invited (or in a DM):

- Start a session: `@Claude Code Bot `~/path/to/project` fix the login bug`
- Continue in thread: `@Claude Code Bot now add tests for it`
```

**Step 2: Commit**

```bash
git add docs/slack-app-setup.md
git commit -m "docs: add Slack app setup guide"
```

---

### Task 9: End-to-End Manual Test

**No new files. Manual verification.**

**Step 1: Create `.env` from `.env.example` with real tokens**

(User creates Slack app per `docs/slack-app-setup.md` first)

**Step 2: Start the bot**

Run: `npm run dev`
Expected: Prints "slack-claude-bot bot is running"

**Step 3: Test new session**

1. Invite bot to a channel
2. Send: `@Claude Code Bot `~/ted/slack-claude-bot` list the files in this project`
3. Verify: "Working..." appears, updates with progress, final result posted

**Step 4: Test session continuity**

1. Reply in same thread: `@Claude Code Bot what's in package.json?`
2. Verify: Uses same session context

**Step 5: Test tool approval**

1. New thread: `@Claude Code Bot `~/ted/slack-claude-bot` create a file called test.txt with "hello"`
2. Verify: Approve/Deny buttons appear
3. Tap "Approve"
4. Verify: File created, button message updated to "Approved"

**Step 6: Test error cases**

1. New thread: `@Claude Code Bot fix the bugs` (no directory)
2. Verify: "Please specify a working directory in backticks"

**Step 7: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```
