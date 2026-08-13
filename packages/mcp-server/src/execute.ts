import { ToolEnvelope, err } from "@uvibe/core";
import { markBrainDirty } from "@uvibe/project-brain";
import { appendAction, createSnapshot, gateTool, loadConfig } from "@uvibe/safety";
import { AnyToolDef, ToolContext } from "./registry.js";

/**
 * Execute a tool with the full safety contract applied. Write tools are gated by safetyMode /
 * per-target flags, optionally snapshotted, and recorded to the action log. Non-write tools (and
 * everything in mock mode) run directly. This is the single execution path shared by the MCP
 * request handler and unity_batch, so gating/logging can never be bypassed by composing tools.
 */
export async function executeTool(
  tool: AnyToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolEnvelope<unknown>> {
  if (tool.write && !ctx.configMockMode) {
    return runGatedWrite(tool, args, ctx);
  }
  return tool.run(args as never, ctx);
}

async function runGatedWrite(
  tool: AnyToolDef,
  parsed: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolEnvelope<unknown>> {
  const config = await loadConfig(ctx.projectPath);
  const decision = gateTool(config, tool.name, tool.writeTarget);
  if (!decision.allowed) {
    const blocked = err(decision.errorCode ?? "SAFETY_MODE_BLOCKED", decision.reason, {
      source: ctx.bridge.source,
    });
    await safeAppend(ctx.projectPath, {
      timestamp: Date.now(),
      tool: tool.name,
      args: parsed,
      result: "blocked",
      errorCode: blocked.error.code,
    });
    return blocked;
  }

  // Best-effort snapshot of the scene file before a save, when autoSnapshot is on.
  let snapshotId: string | undefined;
  if (config.autoSnapshot && tool.name === "unity_save_scene" && typeof parsed.scenePath === "string") {
    try {
      const snap = await createSnapshot(ctx.projectPath, [parsed.scenePath]);
      snapshotId = snap.id;
    } catch {
      // Snapshot is best-effort; Unity's Undo system remains the primary safety net.
    }
  }

  const env = await tool.run(parsed as never, ctx);
  await safeAppend(ctx.projectPath, {
    timestamp: Date.now(),
    tool: tool.name,
    args: parsed,
    result: env.ok ? "ok" : "error",
    errorCode: env.ok ? undefined : env.error.code,
    snapshotId,
    notes:
      env.ok && typeof (env.data as { summary?: unknown })?.summary === "string"
        ? (env.data as { summary: string }).summary
        : undefined,
  });
  if (env.ok && shouldInvalidateKnowledge(tool, parsed, env.data)) {
    await safeMarkKnowledgeDirty(ctx.projectPath, describeKnowledgeChange(tool, parsed));
  }
  return env;
}

function shouldInvalidateKnowledge(
  tool: AnyToolDef,
  args: Record<string, unknown>,
  data: unknown
): boolean {
  if (args.preview === true) {
    const applied =
      typeof data === "object" &&
      data !== null &&
      (data as { applied?: unknown }).applied === true;
    if (!applied) return false;
  }
  switch (tool.writeTarget) {
    case "script":
    case "asset":
    case "prefab":
    case "editor":
    case "code":
      return true;
    case "scene":
      return tool.name === "unity_save_scene";
    case "console":
    default:
      return false;
  }
}

function describeKnowledgeChange(
  tool: AnyToolDef,
  args: Record<string, unknown>
): string {
  const pathValue = [args.path, args.assetPath, args.scenePath, args.prefabPath]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return pathValue ? `${tool.name}: ${pathValue}` : tool.name;
}

async function safeAppend(projectPath: string, entry: Parameters<typeof appendAction>[1]): Promise<void> {
  try {
    await appendAction(projectPath, entry);
  } catch {
    // Never let action-logging failure break a tool call.
  }
}

async function safeMarkKnowledgeDirty(projectPath: string, change: string): Promise<void> {
  try {
    await markBrainDirty(projectPath, change);
  } catch {
    // A maintenance failure must not turn a successful Unity edit into a failure.
  }
}
