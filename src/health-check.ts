import type { WebClient } from "@slack/web-api";
import type { SessionManager } from "./session-manager.js";
import { config } from "./config.js";

const HEALTH_BLOCK_ID = "health_check";
const UPDATE_INTERVAL_MS = 60_000;

const startTime = Date.now();

export function formatUptime(ms: number): string {
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

export function buildHealthBlocks(sessionManager: SessionManager, online: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const uptime = formatUptime(Date.now() - startTime);
  const status = online ? ":large_green_circle: Online" : ":red_circle: Offline";

  const lastActiveIso = sessionManager.getLastActiveAt();
  let lastActivityLine: string;
  if (lastActiveIso) {
    // SQLite CURRENT_TIMESTAMP lacks timezone suffix — ensure UTC parsing
    const normalized = lastActiveIso.endsWith("Z") || lastActiveIso.includes("+")
      ? lastActiveIso
      : lastActiveIso.replace(" ", "T") + "Z";
    const lastActiveSec = Math.floor(new Date(normalized).getTime() / 1000);
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

export async function findHealthPin(client: WebClient, channel: string): Promise<string | undefined> {
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
): Promise<() => Promise<void>> {
  // Open DM channel with allowed user
  let channel: string | undefined;
  try {
    const openResult = await client.conversations.open({
      users: config.allowedUserId,
    });
    channel = openResult.channel?.id;
  } catch (err: any) {
    console.error(`[health] failed to open DM channel: ${err.message}`);
  }
  if (!channel) {
    console.error("[health] could not open DM channel — health check disabled");
    return async () => {};
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
      return async () => {};
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
