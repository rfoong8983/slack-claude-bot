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
  console.log("claude-mobile bot is running");
})();
