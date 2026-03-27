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
