import { z } from "zod";
import { ToolEnvelope } from "@uvibe/core";
import {
  ensureBrainCurrent,
  queryBrain,
  readKnowledgeBase,
} from "@uvibe/project-brain";
import {
  projectBrainQuery,
  projectKnowledgeManifest,
} from "../knowledgeProjection.js";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall, ok } from "./_helpers.js";
import { unityCheckGitStatus } from "./unityCheckGitStatus.js";

/**
 * One-call session bootstrap. Instead of Claude making 6 separate round trips to understand the
 * project at the start of a task, unity_orient fans them out in parallel and returns a single
 * compact snapshot: identity, open scenes, current selection, compile status, recent problems, git
 * state, and project-brain freshness. Read-only; every section degrades gracefully to an error
 * marker if the bridge or git is unavailable, so a partial answer is still useful.
 */

const InputShape = {
  problemLimit: z.number().int().min(0).max(200).optional().describe("Max recent warning/error logs to include (default 20)."),
  task: z
    .string()
    .min(1)
    .max(1_000)
    .optional()
    .describe("The user's current request. When provided, orientation includes bounded relevant matches from the maintained project map."),
};

export const unityOrient: ToolDef<typeof InputShape, unknown> = {
  name: "unity_orient",
  description:
    "Session bootstrap: refreshes the maintained project map and returns live Unity summary, open scenes, selection, compile status, recent problems, git status, knowledge coverage/freshness, and task-relevant map matches in ONE call. Pass the user's current request as task and call this first. Read-only.",
  requires: ["unity_bridge", "git", "project_brain"],
  inputShape: InputShape,
  async run(args, ctx) {
    const problemLimit = args.problemLimit ?? 20;
    const warnings: string[] = [];
    const section = (label: string, env: ToolEnvelope<unknown>): unknown => {
      if (env.ok) return env.data;
      warnings.push(`${label}: ${env.error.code}`);
      return { unavailable: env.error.code };
    };

    const knowledgePromise = (async () => {
      await ensureBrainCurrent(ctx.projectPath);
      const knowledge = await readKnowledgeBase(ctx.projectPath);
      if (!knowledge) throw new Error("project map is unavailable after refresh");
      const relevantQuery = args.task
        ? await queryBrain(ctx.projectPath, { query: args.task, limit: 6 })
        : undefined;
      const manifest = projectKnowledgeManifest(knowledge.manifest);
      return {
        exists: true as const,
        ageMs: Math.max(0, Date.now() - knowledge.manifest.generatedAt),
        stale: knowledge.manifest.dirty.value,
        manifest,
        relevant: relevantQuery
          ? projectBrainQuery(relevantQuery, { knowledge, queryLimit: 6 })
          : undefined,
      };
    })().catch((error: unknown) => ({
      exists: false as const,
      unavailable: error instanceof Error ? error.message : String(error),
    }));

    const [summary, scenes, selection, compile, problems, git, knowledge, health] = await Promise.all([
      bridgeCall(ctx.bridge, BRIDGE_METHODS.systemSummary),
      bridgeCall(ctx.bridge, BRIDGE_METHODS.sceneGetOpenScenes),
      bridgeCall(ctx.bridge, BRIDGE_METHODS.selectionInspect, { includeFields: false }),
      bridgeCall(ctx.bridge, BRIDGE_METHODS.compileStatus),
      bridgeCall(ctx.bridge, BRIDGE_METHODS.consoleGetLogs, { level: "warning_or_error", limit: problemLimit }),
      unityCheckGitStatus.run({}, ctx),
      knowledgePromise,
      ctx.bridge.health?.() ?? Promise.resolve(null),
    ]);

    const bridgeReachable = summary.ok;
    if (!bridgeReachable) warnings.push("Unity bridge not reachable — open the Editor for live state.");
    if (!knowledge.exists) warnings.push(`Project map unavailable — ${knowledge.unavailable}`);

    // Catch the #1 footgun up front: an editor that will freeze (and hang every tool call) the
    // moment the user focuses another window. Warn now, not after a 30-minute stall.
    if (health) {
      if (health.keepAwakeEnabled === false) {
        warnings.push(
          "'Keep Unity awake (background)' is OFF — Unity stops processing tool calls whenever its window is unfocused. Tell the user to enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background), or tool calls will hang."
        );
      } else if (health.editorTickAgeMs === undefined) {
        warnings.push(
          "The UnityVibeOS package in this project predates the background keep-awake driver — tool calls will hang whenever the Unity window is unfocused. Tell the user to update the UnityVibeOS package."
        );
      }
    }

    const data = {
      bridgeReachable,
      summary: section("summary", summary),
      openScenes: section("openScenes", scenes),
      selection: section("selection", selection),
      compile: section("compile", compile),
      recentProblems: section("recentProblems", problems),
      git: section("git", git),
      brain: knowledge,
    };

    return ok(data, { source: ctx.bridge.source, durationMs: 0 }, warnings);
  },
};
