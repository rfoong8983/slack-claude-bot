import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { watch, readFileSync, writeFileSync, existsSync } from "fs";

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
  let debugWatcher: ReturnType<typeof watch> | undefined;

  try {
    console.log(`[claude-bridge] starting query cwd=${opts.cwd} resume=${opts.sessionId ?? "none"}`);

    // Tail the debug log for errors
    const debugLogPath = `/tmp/claude-bridge-debug-${Date.now()}.log`;
    writeFileSync(debugLogPath, "");
    let debugBytesRead = 0;
    debugWatcher = watch(debugLogPath, () => {
      try {
        const content = readFileSync(debugLogPath, "utf-8");
        const newContent = content.slice(debugBytesRead);
        debugBytesRead = content.length;
        for (const line of newContent.split("\n")) {
          if (line.includes("[ERROR]") || line.includes("[WARN]")) {
            console.error(`[claude-bridge] ${line}`);
          }
        }
      } catch {}
    });

    const stream = query({
      prompt,
      options: {
        cwd: opts.cwd,
        permissionMode: "default",
        ...(opts.sessionId ? { resume: opts.sessionId } : {}),
        debug: true,
        debugFile: debugLogPath,
        canUseTool: async (toolName, input, options) => {
          return new Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>((resolve) => {
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
      },
    });

    let messageCount = 0;
    for await (const message of stream) {
      messageCount++;
      const subtype = "subtype" in message ? (message as any).subtype : "none";
      console.log(`[claude-bridge] message #${messageCount} type=${message.type} subtype=${subtype}`);
      if (message.type !== "tool_progress") {
        console.log(`[claude-bridge] payload: ${JSON.stringify(message)}`);
      }

      if (!resultSessionId && message.session_id) {
        resultSessionId = message.session_id;
      }

      if (message.type === "tool_progress") {
        const msg = message as SDKMessage & { tool_name?: string };
        opts.callbacks.onProgress(msg.tool_name ?? "tool");
      }

      if (message.type === "result" && message.subtype === "success") {
        const msg = message as SDKMessage & { result?: string };
        opts.callbacks.onResult(msg.result ?? "");
      }

      if (message.type === "result" && message.subtype !== "success") {
        const msg = message as SDKMessage & { errors?: string[] };
        const errors = msg.errors ?? [];
        opts.callbacks.onError(new Error(errors.join("\n") || "Claude Code error"));
      }
    }

    console.log(`[claude-bridge] stream ended after ${messageCount} messages`);
    debugWatcher.close();
    if (messageCount === 0) {
      console.warn(`[claude-bridge] stream produced no messages — query may have failed silently`);
      opts.callbacks.onError(new Error("Claude query returned no messages"));
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[claude-bridge] query failed: ${error.message}`, error.stack);
    debugWatcher?.close();
    opts.callbacks.onError(error);
  }

  return resultSessionId;
}
