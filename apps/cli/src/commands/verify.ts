import {
  buildContext,
  allTools,
  createMockBridgeClient,
} from "@uvibe/mcp-server";
import { ToolEnvelope } from "@uvibe/core";
import { CommandResult, GlobalOptions } from "../options.js";

export interface VerifyResult {
  total: number;
  passed: number;
  failed: number;
  cases: Array<{ name: string; ok: boolean; reason?: string }>;
}

/** Returns null when the tool's data matches the expected shape, else a human-readable reason. */
type ShapeCheck = (data: unknown) => string | null;

const rec = (d: unknown): Record<string, unknown> | null =>
  d !== null && typeof d === "object" ? (d as Record<string, unknown>) : null;

/** data[key] is an array. */
const hasArray = (key: string): ShapeCheck => (d) =>
  Array.isArray(rec(d)?.[key]) ? null : `missing ${key}[]`;

/** data has the key at all (value may be anything, including false/null). */
const hasKey = (key: string): ShapeCheck => (d) => {
  const r = rec(d);
  return r !== null && key in r ? null : `missing ${key}`;
};

/** data[key] === true. */
const isTrue = (key: string, reason: string): ShapeCheck => (d) =>
  rec(d)?.[key] === true ? null : reason;

/** data[key] is a string. */
const isString = (key: string): ShapeCheck => (d) =>
  typeof rec(d)?.[key] === "string" ? null : `missing ${key}`;

/** data[key] is a non-empty string. */
const isNonEmptyString = (key: string): ShapeCheck => (d) => {
  const v = rec(d)?.[key];
  return typeof v === "string" && v.length > 0 ? null : `missing ${key}`;
};

const ACCEPTANCE: Array<{ tool: string; args?: Record<string, unknown>; expectShape?: ShapeCheck }> = [
  { tool: "unity_project_summary", expectShape: isNonEmptyString("unityVersion") },
  { tool: "unity_get_open_scenes", expectShape: hasArray("scenes") },
  { tool: "unity_get_scene_hierarchy", expectShape: hasArray("roots") },
  { tool: "unity_inspect_selected", expectShape: hasKey("hasSelection") },
  { tool: "unity_get_console_logs", expectShape: hasArray("logs") },
  { tool: "unity_wait_for_compile", expectShape: hasKey("isCompiling") },
  { tool: "unity_refresh_assets", expectShape: hasKey("isCompiling") },
  { tool: "unity_check_git_status", expectShape: hasKey("isGitRepo") },
  { tool: "unity_capture_game_view", args: { save: false }, expectShape: isNonEmptyString("pngBase64") },
  { tool: "unity_capture_scene_view", args: { save: false }, expectShape: isNonEmptyString("pngBase64") },
  { tool: "unity_capture_selected", args: { save: false }, expectShape: isNonEmptyString("pngBase64") },
  { tool: "unity_get_performance_stats", expectShape: hasArray("counters") },
  { tool: "unity_run_tests", expectShape: hasKey("state") },
  { tool: "unity_get_build_settings", expectShape: hasKey("valid") },
  { tool: "unity_enter_play_mode", expectShape: hasKey("isPlaying") },
  { tool: "unity_configure_play_mode", args: { isPaused: false, timeScale: 1 }, expectShape: hasKey("timeScale") },
  { tool: "unity_find_runtime_objects", expectShape: hasArray("objects") },
  { tool: "unity_inspect_runtime_object", expectShape: hasKey("selected") },
  { tool: "unity_set_runtime_field", args: { path: "/Gameplay/Player", component: "PlayerController", field: "moveSpeed", value: 8 }, expectShape: isTrue("applied", "runtime override not applied") },
  { tool: "unity_find_missing_scripts", expectShape: hasArray("hits") },
  { tool: "unity_find_missing_references", expectShape: hasArray("hits") },
  { tool: "unity_find_dependencies", args: { path: "Assets/Prefabs/Player.prefab" }, expectShape: hasArray("assets") },
  { tool: "unity_find_references", args: { path: "Assets/Prefabs/Player.prefab" }, expectShape: hasArray("assets") },
  { tool: "unity_set_serialized_field", args: { component: "PlayerController", field: "moveSpeed", value: 9 }, expectShape: isTrue("applied", "edit not applied") },
  { tool: "unity_assign_reference", args: { component: "PlayerController", field: "currentWeapon", sourceAssetPath: "Assets/Prefabs/Sword.prefab" }, expectShape: isTrue("applied", "assign not applied") },
  { tool: "unity_instantiate_prefab", args: { prefabPath: "Assets/Prefabs/Enemy.prefab" }, expectShape: isString("createdPath") },
  { tool: "unity_create_scriptable_object", args: { type: "WeaponData", path: "Assets/Data/NewWeapon.asset" }, expectShape: isString("createdPath") },
  { tool: "unity_create_material", args: { path: "Assets/Materials/New.mat" }, expectShape: isString("createdPath") },
  { tool: "unity_create_prefab_variant", args: { sourcePath: "Assets/Prefabs/Enemy.prefab", path: "Assets/Prefabs/EliteEnemy.prefab" }, expectShape: isString("createdPath") },
  { tool: "unity_wire_ui_button", args: { path: "/Canvas/PlayButton", handlerComponent: "GameManager", method: "StartGame" }, expectShape: isTrue("applied", "wire not applied") },
  { tool: "unity_clear_console", expectShape: isTrue("applied", "clear not applied") },
  // Scene navigation
  { tool: "unity_open_scene", args: { scenePath: "Assets/Scenes/Level1.unity" }, expectShape: hasArray("scenes") },
  { tool: "unity_load_scene_additive", args: { scenePath: "Assets/Scenes/UI.unity" }, expectShape: hasArray("scenes") },
  // Layout
  { tool: "unity_set_transform", args: { path: "/Gameplay/Player", position: { x: 1, y: 2, z: 3 } }, expectShape: isTrue("applied", "transform not applied") },
  { tool: "unity_reparent", args: { path: "/Gameplay/Player", newParentPath: "/Gameplay/Container" }, expectShape: isTrue("applied", "reparent not applied") },
  // Prefab mode
  { tool: "unity_open_prefab", args: { prefabPath: "Assets/Prefabs/Player.prefab" }, expectShape: isTrue("inPrefabMode", "prefab not opened") },
  { tool: "unity_save_prefab", expectShape: isTrue("applied", "prefab not saved") },
  { tool: "unity_apply_prefab_instance", args: { path: "/Gameplay/Player" }, expectShape: isTrue("applied", "overrides not applied") },
  // Play-test + animation
  { tool: "unity_simulate_input", args: { control: "<Keyboard>/space" }, expectShape: isTrue("simulated", "input not simulated") },
  { tool: "unity_get_animator_state", args: { path: "/Gameplay/Player" }, expectShape: hasArray("layers") },
  { tool: "unity_set_animator_parameter", args: { path: "/Gameplay/Player", name: "Speed", value: 5 }, expectShape: isTrue("applied", "parameter not set") },
  { tool: "unity_animator_edit_transition", args: { controllerPath: "Assets/Animation/Crow.controller", fromState: "Run", toState: "Idle" }, expectShape: isTrue("applied", "transition not edited") },
  // Editor escape hatch (mock skips the whitelist)
  { tool: "unity_execute_menu_item", args: { menuItem: "Assets/Refresh" }, expectShape: isTrue("applied", "menu item not executed") },
  // Asset pipeline
  { tool: "unity_import_asset", args: { path: "Assets/Art/hero.png" }, expectShape: isString("createdPath") },
  { tool: "unity_slice_sprite", args: { texturePath: "Assets/Art/tiles.png", cellWidth: 16, cellHeight: 16 }, expectShape: isTrue("applied", "sprite not sliced") },
  { tool: "unity_paint_tilemap", args: { tilemapPath: "/Grid/Tilemap", tileAssetPath: "Assets/Tiles/Grass.asset", cells: [{ x: 0, y: 0 }] }, expectShape: isTrue("applied", "tilemap not painted") },
  // Composition tools (one-call orient / verify / batch)
  {
    tool: "unity_orient",
    expectShape: (d: unknown) => {
      const summary = rec(rec(d)?.summary);
      return typeof summary?.unityVersion === "string" && summary.unityVersion.length > 0 ? null : "missing summary";
    },
  },
  { tool: "unity_verify", expectShape: hasKey("compiled") },
  { tool: "unity_smoke_test", args: { settleMs: 0, captureGameView: false }, expectShape: hasKey("pass") },
  { tool: "unity_qa", args: { runTests: false, checkAssets: false, runSmokeTest: false }, expectShape: hasKey("pass") },
  { tool: "unity_batch", args: { operations: [{ tool: "unity_get_open_scenes" }] }, expectShape: isTrue("allOk", "batch op failed") },
];

export async function runVerify(g: GlobalOptions): Promise<CommandResult> {
  // Verify always runs against the mock bridge for determinism.
  const ctx = buildContext({
    mock: true,
    projectPath: g.project,
    bridgeOverride: createMockBridgeClient(),
  });
  const cases: VerifyResult["cases"] = [];
  for (const acceptance of ACCEPTANCE) {
    const tool = allTools.find((t) => t.name === acceptance.tool);
    if (!tool) {
      cases.push({ name: acceptance.tool, ok: false, reason: "tool not registered" });
      continue;
    }
    const env: ToolEnvelope<unknown> = await tool.run((acceptance.args ?? {}) as never, ctx);
    if (!env.ok) {
      cases.push({ name: tool.name, ok: false, reason: `envelope error ${env.error.code}: ${env.error.message}` });
      continue;
    }
    const shapeError = acceptance.expectShape?.(env.data) ?? null;
    if (shapeError) {
      cases.push({ name: tool.name, ok: false, reason: shapeError });
      continue;
    }
    cases.push({ name: tool.name, ok: true });
  }

  const passed = cases.filter((c) => c.ok).length;
  const failed = cases.length - passed;
  const result: VerifyResult = { total: cases.length, passed, failed, cases };

  if (g.json) {
    return { exitCode: failed === 0 ? 0 : 1, stdout: JSON.stringify(result, null, 2) + "\n" };
  }

  const lines: string[] = [];
  lines.push(`Unity Vibe OS — verify (mock bridge)`);
  for (const c of cases) lines.push(`  ${c.ok ? "✓" : "✗"}  ${c.name}${c.ok ? "" : ` — ${c.reason ?? ""}`}`);
  lines.push("");
  lines.push(`${passed}/${cases.length} passed${failed > 0 ? ` (${failed} failed)` : ""}`);
  return { exitCode: failed === 0 ? 0 : 1, stdout: lines.join("\n") + "\n" };
}
