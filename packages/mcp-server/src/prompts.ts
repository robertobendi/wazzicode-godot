import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP prompts. Claude Code surfaces each of these as a slash command
 * (/mcp__unity-vibe-os__<name>) the user can trigger to kick off a Unity workflow. They expand to a
 * user message that drives the unity_* tools — packaging the canonical loops from CLAUDE.md so the
 * user doesn't have to remember which tools to chain. (Other MCP clients ignore prompts, which is
 * why CoplayDev — being client-agnostic — doesn't ship them; for a Claude-Code-only tool they're
 * free UX.)
 */
export interface UnityPrompt {
  name: string;
  config: { title: string; description: string; argsSchema?: Record<string, z.ZodType> };
  build: (args: Record<string, string>) => string;
}

export const UNITY_PROMPTS: UnityPrompt[] = [
  {
    name: "orient",
    config: { title: "Orient in the Unity project", description: "Summarize the current Unity project state in one pass." },
    build: () =>
      "Call `unity_orient` and give me a concise status of the Unity project: open scenes and which is active, the current selection, compile status (with any errors), recent warnings/errors, git status, and how stale the project brain is. Flag anything that looks broken.",
  },
  {
    name: "diagnose_scene",
    config: { title: "Diagnose a broken scene/prefab", description: "Find missing scripts and dangling references and explain how to fix them." },
    build: () =>
      "Diagnose why the current scene/prefab might be broken. Run `unity_find_missing_scripts` and `unity_find_missing_references`, then summarize each missing script and dangling reference (object path, component, field) and the most likely fix. Use `unity_find_references`/`unity_find_dependencies` to trace anything before suggesting a rename or delete. Don't change anything yet — just report.",
  },
  {
    name: "analyze_scene",
    config: { title: "Analyze the current scene", description: "Review the scene for issues and optimization opportunities." },
    build: () =>
      "Analyze the current Unity scene and report issues + optimization opportunities. Inspect structure with `unity_get_scene_hierarchy`; find broken links with `unity_find_missing_scripts` and `unity_find_missing_references`; for performance, read `unity_get_performance_stats` (enter play mode first if needed — draw calls, batches, GC alloc, FPS). Then give a prioritized report: structural problems, missing/dangling references, and performance concerns, each with a concrete fix ranked by impact. Don't change anything yet — propose, and ask before applying.",
  },
  {
    name: "verify",
    config: { title: "Verify the latest changes", description: "Run the compile → console → tests verdict." },
    build: () =>
      "Run `unity_verify` and report a single pass/fail verdict: whether it compiled, any new console errors, and the test results (name + status for failures). If it failed, point at the specific file/line and propose the fix.",
  },
  {
    name: "new_script",
    config: {
      title: "Create a new C# script",
      description: "Scaffold a verified C# script with API checks.",
      argsSchema: { name: z.string().describe("Class/file name, e.g. EnemyController"), description: z.string().describe("What the script should do") },
    },
    build: (a) =>
      `Create a new C# script named "${a.name || "NewBehaviour"}" that does the following: ${a.description || "(describe the behaviour)"}.\n` +
      "Before writing, use `unity_reflect` to confirm any Unity/package APIs you rely on actually exist with the signatures you expect. Then `unity_create_script` under an appropriate Assets/ path, and finish with `unity_verify` to confirm it compiles and tests pass. If anything fails to compile, fix it and re-verify.",
  },
  {
    name: "play_test",
    config: { title: "Play-test the game", description: "Run a guarded runtime smoke test with automatic cleanup." },
    build: () =>
      "Run `unity_smoke_test` on the current scene and report its pass/fail checks, new runtime errors, performance sample, screenshot path, and cleanup result. If it exposes a problem, investigate in play mode with `unity_find_runtime_objects`/`unity_inspect_runtime_object`, `unity_configure_play_mode`, `unity_set_runtime_field`, `unity_simulate_input`, or `unity_step_frame`, then leave the Editor in its original play state.",
  },
  {
    name: "qa",
    config: { title: "Run the full Unity QA gate", description: "Compile, test, scan assets/build settings, and smoke-test runtime." },
    build: () =>
      "Run `unity_qa` with its default full gate. Report one pass/fail verdict followed by only actionable failures: compile or console errors, failed/inconclusive tests, missing scripts or references, build-settings issues, smoke-test runtime errors, performance budget failures, and cleanup failures.",
  },
];

export function registerPrompts(server: McpServer): void {
  for (const p of UNITY_PROMPTS) {
    server.registerPrompt(
      p.name,
      p.config as { title: string; description: string; argsSchema?: Record<string, z.ZodType> & Record<string, z.ZodTypeAny> },
      ((args: Record<string, string> = {}) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: p.build(args) } }],
      })) as never
    );
  }
}
