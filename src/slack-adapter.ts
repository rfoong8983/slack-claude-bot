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

  // Listen for messages in DMs that @mention the bot.
  // app_mention doesn't fire in self-DMs, so we use message events instead.
  app.event("message", async ({ event, client }) => {
    const msg = event as any;

    // Only respond in IM (DM) channels
    if (msg.channel_type !== "im") return;

    // Only respond to the allowed user
    if (msg.user !== config.allowedUserId) return;

    // Ignore subtypes (edits, bot messages, etc.)
    if (msg.subtype) return;

    // Only respond when the bot is @mentioned
    const botMentionRegex = /<@[A-Z0-9]+>/;
    if (!botMentionRegex.test(msg.text ?? "")) return;

    const threadTs = msg.thread_ts ?? msg.ts;
    const channelId = msg.channel;
    const userText = (msg.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();

    const existingSession = msg.thread_ts
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
