import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebClient } from "@slack/web-api";
import Database from "better-sqlite3";
import { SessionManager } from "./session-manager.js";

vi.mock("./config.js", () => ({
  config: {
    allowedUserId: "U_TEST_USER",
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    dbPath: ":memory:",
  },
}));

import { formatUptime, buildHealthBlocks, findHealthPin, startHealthCheck } from "./health-check.js";

function createMockClient(overrides: Partial<Record<string, any>> = {}) {
  return {
    conversations: { open: vi.fn().mockResolvedValue({ channel: { id: "D123" } }) },
    pins: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      add: vi.fn().mockResolvedValue({}),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "msg_ts_123" }),
      update: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as unknown as WebClient;
}

describe("formatUptime", () => {
  it("returns '0m' for 0ms", () => {
    expect(formatUptime(0)).toBe("0m");
  });

  it("returns '5m' for 5 minutes", () => {
    expect(formatUptime(5 * 60 * 1000)).toBe("5m");
  });

  it("returns '2h 30m' for 2.5 hours", () => {
    expect(formatUptime(2.5 * 60 * 60 * 1000)).toBe("2h 30m");
  });

  it("returns '3d 12h 45m' for 3d 12h 45m", () => {
    const ms = (3 * 86400 + 12 * 3600 + 45 * 60) * 1000;
    expect(formatUptime(ms)).toBe("3d 12h 45m");
  });

  it("returns '1h 0m' for exactly 1 hour", () => {
    expect(formatUptime(3600 * 1000)).toBe("1h 0m");
  });

  it("returns '1d 0m' for exactly 1 day", () => {
    expect(formatUptime(86400 * 1000)).toBe("1d 0m");
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

  it("shows Online status with green circle", () => {
    const result = buildHealthBlocks(sessionManager, true);
    expect(result.text).toContain("Online");
    expect(result.blocks[0].text.text).toContain(":large_green_circle: Online");
  });

  it("shows Offline status with red circle", () => {
    const result = buildHealthBlocks(sessionManager, false);
    expect(result.text).toContain("Offline");
    expect(result.blocks[0].text.text).toContain(":red_circle: Offline");
  });

  it("shows 'No sessions yet' when no sessions exist", () => {
    const result = buildHealthBlocks(sessionManager, true);
    expect(result.blocks[0].text.text).toContain("No sessions yet");
  });

  it("shows Slack date format when sessions exist", () => {
    sessionManager.createSession({
      threadId: "t1",
      channelId: "C1",
      sessionId: "s1",
      workingDirectory: "/tmp",
    });
    const result = buildHealthBlocks(sessionManager, true);
    expect(result.blocks[0].text.text).toContain("<!date^");
  });

  it("has correct block structure", () => {
    const result = buildHealthBlocks(sessionManager, true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe("section");
    expect(result.blocks[0].block_id).toBe("health_check");
    expect(result.blocks[0].text.type).toBe("mrkdwn");
  });

  it("contains Updated with Slack date format", () => {
    const result = buildHealthBlocks(sessionManager, true);
    const text = result.blocks[0].text.text as string;
    expect(text).toContain("*Updated:*");
    expect(text).toMatch(/\*Updated:\* <!date\^/);
  });
});

describe("findHealthPin", () => {
  it("returns ts when pin with health_check block_id exists", async () => {
    const client = createMockClient({
      pins: {
        list: vi.fn().mockResolvedValue({
          items: [
            {
              message: {
                ts: "pin_ts_1",
                blocks: [{ block_id: "health_check" }],
              },
            },
          ],
        }),
      },
    });
    const ts = await findHealthPin(client, "C123");
    expect(ts).toBe("pin_ts_1");
  });

  it("returns undefined when no matching pin", async () => {
    const client = createMockClient({
      pins: {
        list: vi.fn().mockResolvedValue({
          items: [
            {
              message: {
                ts: "pin_ts_other",
                blocks: [{ block_id: "other_block" }],
              },
            },
          ],
        }),
      },
    });
    const ts = await findHealthPin(client, "C123");
    expect(ts).toBeUndefined();
  });

  it("returns undefined when pins.list has no items", async () => {
    const client = createMockClient();
    const ts = await findHealthPin(client, "C123");
    expect(ts).toBeUndefined();
  });

  it("returns undefined when pins.list throws", async () => {
    const client = createMockClient({
      pins: {
        list: vi.fn().mockRejectedValue(new Error("API error")),
      },
    });
    const ts = await findHealthPin(client, "C123");
    expect(ts).toBeUndefined();
  });

  it("ignores pins without matching block_id in multi-pin scenario", async () => {
    const client = createMockClient({
      pins: {
        list: vi.fn().mockResolvedValue({
          items: [
            { message: { ts: "ts_1", blocks: [{ block_id: "unrelated" }] } },
            { message: { ts: "ts_2", blocks: [{ block_id: "health_check" }] } },
            { message: { ts: "ts_3", blocks: [{ block_id: "another" }] } },
          ],
        }),
      },
    });
    const ts = await findHealthPin(client, "C123");
    expect(ts).toBe("ts_2");
  });
});

describe("startHealthCheck", () => {
  let db: Database.Database;
  let sessionManager: SessionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    sessionManager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("creates new pin when none exists", async () => {
    const client = createMockClient();
    const shutdown = await startHealthCheck(client, sessionManager);

    expect((client.chat.postMessage as any)).toHaveBeenCalledOnce();
    expect((client.pins.add as any)).toHaveBeenCalledWith({
      channel: "D123",
      timestamp: "msg_ts_123",
    });
    expect((client.chat.update as any)).toHaveBeenCalled();

    // clean up timers
    vi.useFakeTimers();
    await shutdown();
  });

  it("reuses existing pin and does not post new message", async () => {
    const client = createMockClient({
      pins: {
        list: vi.fn().mockResolvedValue({
          items: [
            {
              message: {
                ts: "existing_ts",
                blocks: [{ block_id: "health_check" }],
              },
            },
          ],
        }),
        add: vi.fn().mockResolvedValue({}),
      },
    });

    const shutdown = await startHealthCheck(client, sessionManager);

    expect((client.chat.postMessage as any)).not.toHaveBeenCalled();
    expect((client.pins.add as any)).not.toHaveBeenCalled();
    expect((client.chat.update as any)).toHaveBeenCalled();

    vi.useFakeTimers();
    await shutdown();
  });

  it("returns noop function when conversations.open fails", async () => {
    const client = createMockClient({
      conversations: { open: vi.fn().mockResolvedValue({}) },
    });

    const shutdown = await startHealthCheck(client, sessionManager);

    expect((client.chat.postMessage as any)).not.toHaveBeenCalled();
    // shutdown should not throw
    await shutdown();
  });

  it("returns noop function when postMessage fails", async () => {
    const client = createMockClient({
      chat: {
        postMessage: vi.fn().mockRejectedValue(new Error("post failed")),
        update: vi.fn().mockResolvedValue({}),
      },
    });

    const shutdown = await startHealthCheck(client, sessionManager);

    expect((client.pins.add as any)).not.toHaveBeenCalled();
    // shutdown should not throw
    await shutdown();
  });

  it("shutdown function calls chat.update with offline status", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const shutdown = await startHealthCheck(client, sessionManager);

    // Reset to track the shutdown call specifically
    (client.chat.update as any).mockClear();

    await shutdown();

    expect((client.chat.update as any)).toHaveBeenCalledOnce();
    const call = (client.chat.update as any).mock.calls[0][0];
    expect(call.text).toContain("Offline");
  });

  it("cleans up timers on shutdown", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const shutdown = await startHealthCheck(client, sessionManager);

    (client.chat.update as any).mockClear();

    await shutdown();

    // After shutdown, advancing time should not trigger additional updates
    (client.chat.update as any).mockClear();
    await vi.advanceTimersByTimeAsync(120_000);

    expect((client.chat.update as any)).not.toHaveBeenCalled();
  });
});
