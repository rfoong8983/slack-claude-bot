import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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

  try {
    const stream = query({
      prompt,
      options: {
        cwd: opts.cwd,
        permissionMode: "default",
        ...(opts.sessionId ? { resume: opts.sessionId } : {}),
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

    for await (const message of stream) {
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
  } catch (err) {
    opts.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }

  return resultSessionId;
}
