import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ProgressReporter, ToolContext } from "./registry.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * MCP progress is opt-in: a client that wants updates sends a progressToken with the call.
 * Without one, notifications/progress is not allowed, so this returns undefined and every
 * reportProgress call becomes a no-op.
 */
export function createProgressReporter(extra: ToolExtra): ProgressReporter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return (update) => {
    void extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, ...update } })
      .catch(() => {
        // A dropped progress notification must never fail the tool call it describes.
      });
  };
}

export function reportProgress(
  ctx: ToolContext,
  progress: number,
  message: string,
  total?: number,
): void {
  ctx.progress?.({ progress, message, ...(total === undefined ? {} : { total }) });
}
