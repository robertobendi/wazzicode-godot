import { BRIDGE_METHODS, OpenScenesResult, ToolEnvelope, err } from "@gvibe/core";
import { markBrainDirty } from "@gvibe/project-brain";
import {
  ProjectWriteLockError,
  ProjectWriteLockOptions,
  appendAction,
  createSnapshot,
  gateTool,
  loadConfig,
  withProjectWriteLock,
} from "@gvibe/safety";
import { AnyToolDef, ToolContext } from "./registry.js";

/**
 * Execute a tool with the full safety contract applied. Write tools are gated by safetyMode /
 * per-target flags, optionally snapshotted, and recorded to the action log. Non-write tools (and
 * mock-backed writes) use the same contract. This is also used by godot_batch.
 */
export async function executeTool(
  tool: AnyToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
  options: { writeLock?: ProjectWriteLockOptions } = {},
): Promise<ToolEnvelope<unknown>> {
  if (tool.write) {
    let env: ToolEnvelope<unknown>;
    try {
      env = await withProjectWriteLock(
        ctx.projectPath,
        () => runGatedWrite(tool, args, ctx),
        { operation: tool.name, ...options.writeLock },
      );
    } catch (error) {
      if (!(error instanceof ProjectWriteLockError)) throw error;
      const details = error.holder ? { holder: error.holder } : undefined;
      return err(
        error.kind === "timeout" ? "PROJECT_BUSY" : "FILE_WRITE_FAILED",
        error.message,
        { source: ctx.bridge.source },
        details,
      );
    }
    if (env.ok && shouldInvalidateKnowledge(tool, args, env.data)) {
      await safeMarkKnowledgeDirty(ctx.projectPath, describeKnowledgeChange(tool, args));
    }
    return env;
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
  let confirmedByOwner = false;
  if (!decision.allowed) {
    // "confirm" is the one mode whose refusal is about a missing approval signal rather than a
    // policy decision, so an accepted elicitation satisfies it. Every other mode stays refused.
    confirmedByOwner = config.safetyMode === "confirm" && ctx.confirmWrite !== undefined
      ? await ctx.confirmWrite({ message: confirmMessage(tool, parsed) })
      : false;
    if (!confirmedByOwner) {
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
  }

  // Disk-backed writes receive a recoverable file snapshot in addition to editor UndoRedo.
  let snapshotId: string | undefined;
  if (config.autoSnapshot && parsed.preview !== true) {
    try {
      const snapshotPath = await snapshotPathFor(tool, parsed, ctx);
      if (snapshotPath) {
        const snap = await createSnapshot(ctx.projectPath, [snapshotPath]);
        snapshotId = snap.id;
      }
    } catch (error) {
      const blocked = err(
        "WRITE_REQUIRES_SNAPSHOT",
        `Required snapshot failed, so '${tool.name}' did not run: ${error instanceof Error ? error.message : String(error)}`,
        { source: ctx.bridge.source }
      );
      await safeAppend(ctx.projectPath, {
        timestamp: Date.now(),
        tool: tool.name,
        args: parsed,
        result: "blocked",
        errorCode: blocked.error.code,
      });
      return blocked;
    }
  }

  const env = await tool.run(parsed as never, ctx);
  const summary =
    env.ok && typeof (env.data as { summary?: unknown })?.summary === "string"
      ? (env.data as { summary: string }).summary
      : undefined;
  const approval = confirmedByOwner ? "Approved interactively in confirm mode." : undefined;
  await safeAppend(ctx.projectPath, {
    timestamp: Date.now(),
    tool: tool.name,
    args: parsed,
    result: env.ok ? "ok" : "error",
    errorCode: env.ok ? undefined : env.error.code,
    snapshotId,
    notes: [approval, summary].filter(Boolean).join(" ") || undefined,
  });
  return env;
}

function confirmMessage(tool: AnyToolDef, args: Record<string, unknown>): string {
  const target = [args.path, args.nodePath, args.scenePath, args.resourcePath]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const subject = tool.writeTarget ? `${tool.writeTarget} state` : "project state";
  return `Godot Vibe OS is in confirm mode. Allow '${tool.name}' to change ${subject}${target ? ` for ${target}` : ""}?`;
}

async function snapshotPathFor(
  tool: AnyToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string | undefined> {
  if (tool.name === "godot_save_scene") {
    if (typeof args.path === "string" && args.path.length > 0) return args.path;
    const response = await ctx.bridge.call<OpenScenesResult>(BRIDGE_METHODS.sceneGetOpenScenes);
    if (!response.ok) {
      throw new Error(`Could not resolve the active scene (${response.error.code}): ${response.error.message}`);
    }
    const active = response.result.scenes.find((scene) => scene.active);
    const activePath = active?.path || response.result.activeScene;
    if (!active || !activePath.startsWith("res://") || activePath.length <= "res://".length) {
      throw new Error("The editor has no active scene with a saved res:// path.");
    }
    return activePath;
  }
  if (tool.writeTarget === "script") {
    return typeof args.path === "string" ? args.path : undefined;
  }
  return undefined;
}

function shouldInvalidateKnowledge(
  tool: AnyToolDef,
  args: Record<string, unknown>,
  data: unknown
): boolean {
  if (tool.name === "godot_open_scene") return false;
  if (tool.name === "godot_debug_run") return false;
  if (args.preview === true) {
    const applied =
      typeof data === "object" &&
      data !== null &&
      (data as { applied?: unknown }).applied === true;
    if (!applied) return false;
  }
  switch (tool.writeTarget) {
    case "script":
    case "resource":
    case "project_settings":
    case "editor":
      return true;
    case "scene":
      return tool.name === "godot_save_scene";
    default:
      return false;
  }
}

function describeKnowledgeChange(
  tool: AnyToolDef,
  args: Record<string, unknown>
): string {
  const pathValue = [args.path, args.resourcePath, args.scenePath]
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
    // A maintenance failure must not turn a successful Godot edit into a failure.
  }
}
