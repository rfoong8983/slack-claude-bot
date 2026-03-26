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
