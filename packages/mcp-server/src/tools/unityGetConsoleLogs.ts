import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { ConsoleLogsResult } from "@uvibe/core";

const InputShape = {
  level: z.enum(["all", "warning_or_error", "error"]).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  sinceTimestamp: z.number().optional().describe("Unix ms; only return logs after this time."),
  query: z
    .string()
    .max(500)
    .optional()
    .describe("Case-insensitive substring to match in the message or stack trace."),
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityGetConsoleLogs: ToolDef<typeof InputShape, ConsoleLogsResult> = {
  name: "unity_get_console_logs",
  description:
    "Returns Unity console logs captured since the UnityVibeOS package loaded. Logs are captured via Application.logMessageReceivedThreaded; logs emitted before package load are not retained (documented limitation). Filter by level, time, and a case-insensitive message/stack substring.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    const query = args.query?.trim().toLowerCase();
    const env = await bridgeCall<ConsoleLogsResult>(
      ctx.bridge,
      BRIDGE_METHODS.consoleGetLogs,
      {
        level: args.level ?? "all",
        limit: query ? 2000 : (args.limit ?? 200),
        sinceTimestamp: args.sinceTimestamp,
      },
      args.detailLevel ?? "normal"
    );
    if (!env.ok || !query) return env;

    const logs = env.data.logs.filter(
      (entry) =>
        entry.message.toLowerCase().includes(query) ||
        (entry.stackTrace ?? "").toLowerCase().includes(query)
    );
    const limit = args.limit ?? 200;
    return {
      ...env,
      data: {
        ...env.data,
        logs: logs.slice(-limit),
        truncated: env.data.truncated || logs.length > limit,
      },
    };
  },
};
