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
      .prepare("UPDATE sessions SET last_active_at = ? WHERE thread_id = ?")
      .run(new Date().toISOString(), threadId);
  }

  updateSessionId(threadId: string, sessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET session_id = ? WHERE thread_id = ?")
      .run(sessionId, threadId);
  }
}
