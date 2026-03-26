import { App } from "@slack/bolt";
import { SessionManager } from "./session-manager.js";
import { MessageQueue } from "./message-queue.js";
import { runClaudeQuery, type ToolApprovalRequest } from "./claude-bridge.js";
import { config } from "./config.js";
import { randomUUID } from "crypto";
import { existsSync } from "fs";

const REPO_REGEX = /repo:(\S+)/;
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

  // Listen for DM messages from the allowed user.
  app.event("message", async ({ event, client }) => {
    const msg = event as any;

    // Only respond in IM (DM) channels
    if (msg.channel_type !== "im") return;

    // Only respond to the allowed user
    if (msg.user !== config.allowedUserId) {
      console.log(`[msg] ignored message from user=${msg.user} (not allowed)`);
      return;
    }

    // Ignore subtypes (edits, bot messages, etc.)
    if (msg.subtype) return;

    const threadTs = msg.thread_ts ?? msg.ts;
    const channelId = msg.channel;
    const userText = (msg.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();

    console.log(`[msg] received thread=${threadTs} text="${userText.slice(0, 80)}"`);

    const existingSession = msg.thread_ts
      ? sessionManager.getSession(threadTs)
      : undefined;

    if (!existingSession) {
      const match = userText.match(REPO_REGEX);
      if (!match) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: "Please specify a repo, e.g. `repo:ems fix the login bug`",
        });
        return;
      }

      const repoName = match[1];
      const dir = `${process.env.HOME ?? "~"}/ted/${repoName}`;
      if (!existsSync(dir)) {
        console.log(`[msg] repo not found: ${dir}`);
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Repo not found: \`~/ted/${repoName}\``,
        });
        return;
      }

      const prompt = userText.replace(REPO_REGEX, "").trim();
      if (!prompt) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: "What would you like Claude to do?",
        });
        return;
      }

      const placeholderId = randomUUID();
      console.log(`[session] new session thread=${threadTs} repo=${repoName} cwd=${dir}`);
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
      console.log(`[session] resuming thread=${threadTs} sessionId=${existingSession.sessionId}`);
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
    console.log(`[approval] ${approved ? "approved" : "denied"} tool=${request?.toolName ?? "unknown"} toolUseId=${toolUseId}`);
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
  console.log(`[queue] enqueuing thread=${opts.threadTs} cwd=${opts.cwd} resume=${opts.resumeSessionId ?? "none"}`);
  queue.enqueue(
    opts.threadTs,
    async () => {
      console.log(`[claude] starting query thread=${opts.threadTs} prompt="${opts.prompt.slice(0, 80)}"`);
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
            console.log(`[claude] progress thread=${opts.threadTs} tool=${toolName}`);

            client.chat.update({
              channel: opts.channelId,
              ts: statusTs,
              text: `Working... (${toolName})`,
            }).catch(() => {});
          },

          onResult: (text: string) => {
            console.log(`[claude] result thread=${opts.threadTs} length=${text.length}`);
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
            console.error(`[claude] error thread=${opts.threadTs} error="${error.message}"`);
            client.chat.update({
              channel: opts.channelId,
              ts: statusTs,
              text: `Error: ${error.message}`,
            }).catch(() => {});
          },

          onToolApproval: (request: ToolApprovalRequest) => {
            console.log(`[claude] tool approval requested thread=${opts.threadTs} tool=${request.toolName}`);
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
        console.log(`[session] updated sessionId thread=${opts.threadTs} sessionId=${newSessionId}`);
        sessionManager.updateSessionId(opts.threadTs, newSessionId);
      }
      console.log(`[claude] query complete thread=${opts.threadTs}`);
    },
    (err) => {
      console.error(`[queue] error thread=${opts.threadTs} error="${err.message}"`);
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
