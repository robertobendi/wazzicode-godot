import { z, ZodRawShape } from "zod";
import { ToolDef } from "../registry.js";
import { ok } from "./_helpers.js";
import { executeTool } from "../execute.js";

/**
 * Apply an ordered list of tool operations in a single call. This collapses a known multi-step
 * plan (e.g. create GameObject → add component → set fields → save scene) from many model
 * round-trips into one, which is faster and more autonomous. Each operation still flows through
 * the same safety gate and action log as a direct call (writes are gated per-op by safetyMode),
 * so batching can never escalate permissions. Stops at the first failure unless stopOnError=false.
 */

const InputShape = {
  operations: z
    .array(
      z.object({
        tool: z.string().describe("Tool name, e.g. 'unity_set_transform'."),
        args: z.record(z.string(), z.unknown()).optional().describe("Arguments for that tool."),
      })
    )
    .min(1)
    .max(50)
    .describe("Ordered operations to run."),
  stopOnError: z.boolean().optional().describe("Stop at the first failed op (default true). false runs them all."),
};

export const unityBatch: ToolDef<typeof InputShape, unknown> = {
  name: "unity_batch",
  description:
    "Runs an ordered list of Unity tool operations in a single call so a multi-step edit is one round trip instead of many. Each op is gated and logged exactly like a direct call (writes still require the right safetyMode). Returns per-op results; stops at the first failure unless stopOnError=false. Cannot nest unity_batch.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    const operations = Array.isArray(args.operations) ? args.operations : [];
    const stopOnError = args.stopOnError ?? true;
    const registry = ctx.tools ?? [];
    const results: Array<Record<string, unknown>> = [];
    let allOk = true;

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const record = (entry: Record<string, unknown>) => results.push({ index: i, tool: op.tool, ...entry });

      if (op.tool === "unity_batch") {
        allOk = false;
        record({ ok: false, error: { code: "INVALID_ARGUMENT", message: "unity_batch cannot be nested." } });
        if (stopOnError) break;
        continue;
      }
      const tool = registry.find((t) => t.name === op.tool);
      if (!tool) {
        allOk = false;
        record({ ok: false, error: { code: "INVALID_ARGUMENT", message: `Unknown tool '${op.tool}'.` } });
        if (stopOnError) break;
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = z.object(tool.inputShape as ZodRawShape).parse(op.args ?? {}) as Record<string, unknown>;
      } catch (e: unknown) {
        allOk = false;
        record({ ok: false, error: { code: "INVALID_ARGUMENT", message: `Invalid args: ${e instanceof Error ? e.message : String(e)}` } });
        if (stopOnError) break;
        continue;
      }

      const env = await executeTool(tool, parsed, ctx);
      if (env.ok) {
        record({ ok: true, data: env.data });
      } else {
        allOk = false;
        record({ ok: false, error: { code: env.error.code, message: env.error.message } });
        if (stopOnError) break;
      }
    }

    const summary = `${results.filter((r) => r.ok).length}/${operations.length} operation(s) succeeded`;
    const data = { allOk, ranCount: results.length, total: operations.length, summary, results };
    // Envelope is ok as long as the batch itself executed; per-op failures live in `results`.
    return ok(data, { source: ctx.bridge.source, durationMs: 0 }, allOk ? [] : [summary]);
  },
};
