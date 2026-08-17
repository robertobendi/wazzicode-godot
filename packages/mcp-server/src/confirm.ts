import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ConfirmRequest, WriteConfirmer } from "./registry.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * `safetyMode: "confirm"` blocks writes because an MCP session normally has no trusted approval
 * signal. Elicitation is that signal: the client asks the project owner, in person, for this one
 * operation. Clients without the capability (Codex CLI today) keep the existing refusal, so the
 * gate never silently weakens.
 */
export function createWriteConfirmer(server: Server, extra: ToolExtra): WriteConfirmer | undefined {
  if (!server.getClientCapabilities()?.elicitation) return undefined;
  return async (request: ConfirmRequest) => {
    try {
      const result = await extra.sendRequest(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: request.message,
            requestedSchema: { type: "object", properties: {} },
          },
        },
        ElicitResultSchema,
      );
      return result.action === "accept";
    } catch {
      // A failed or unanswered elicitation is not approval.
      return false;
    }
  };
}
