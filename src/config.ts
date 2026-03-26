import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackAppToken: required("SLACK_APP_TOKEN"),
  allowedUserId: required("ALLOWED_USER_ID"),
  dbPath: process.env.DB_PATH ?? "slack-claude-bot.db",
};
