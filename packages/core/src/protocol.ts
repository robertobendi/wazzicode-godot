import { PROTOCOL_VERSION } from "./version.js";

export const BRIDGE_METHODS = {
  systemHealth: "system.health",
  systemSummary: "system.summary",
  buildGetSettings: "build.getSettings",
  sceneGetOpenScenes: "scene.getOpenScenes",
  sceneGetHierarchy: "scene.getHierarchy",
  selectionInspect: "selection.inspect",
  consoleGetLogs: "console.getLogs",
  consoleClear: "console.clear",
  compileStatus: "compile.status",
  assetRefresh: "asset.refresh",
  /** Long-poll: settles when compilation goes idle (falls back to compile.status polling on old bridges). */
  compileAwait: "compile.await",
  screenshotGameView: "screenshot.gameView",
  screenshotSceneView: "screenshot.sceneView",
  screenshotSelected: "screenshot.selected",
  screenshotEditorWindow: "screenshot.editorWindow",

  // Performance probes (Unity.Profiling.ProfilerRecorder)
  perfSample: "perf.sample",

  // Test runner (optional; needs com.unity.test-framework)
  testRun: "test.run",
  testStatus: "test.status",
  testCancel: "test.cancel",
  /** Long-poll: settles when the active test run finishes. */
  testAwait: "test.await",

  // Play-mode control + runtime inspection
  playModeEnter: "playmode.enter",
  playModeExit: "playmode.exit",
  playModeStep: "playmode.step",
  playModeStatus: "playmode.status",
  playModeConfigure: "playmode.configure",
  /** Long-poll: settles when play mode reaches params.until ("playing" | "stopped"). */
  playModeAwait: "playmode.await",
  runtimeFindObjects: "runtime.findObjects",
  runtimeInspect: "runtime.inspect",
  runtimeSetField: "runtime.setField",

  // Asset / reference graph (read-only)
  assetFindMissingScripts: "asset.findMissingScripts",
  assetFindMissingReferences: "asset.findMissingReferences",
  assetFindReferences: "asset.findReferences",
  assetFindDependencies: "asset.findDependencies",

  // Scene navigation (non-write; lets Claude traverse the project autonomously)
  sceneOpen: "scene.open",
  sceneLoadAdditive: "scene.loadAdditive",

  // Prefab mode (open the prefab asset for editing, save it, apply instance overrides)
  prefabOpen: "prefab.open",
  prefabSave: "prefab.save",
  prefabApplyInstance: "prefab.applyInstance",

  // Play-mode input simulation + animator runtime/asset control
  inputSimulate: "input.simulate",
  animatorGetState: "animator.getState",
  animatorSetParameter: "animator.setParameter",
  animatorEditTransition: "animator.editTransition",

  // Generic Editor menu escape hatch (whitelisted at the MCP layer)
  editorExecuteMenuItem: "editor.executeMenuItem",

  // C# script editing (read + write; writes gated by the 'script' target)
  scriptRead: "script.read",
  scriptGetSha: "script.getSha",
  scriptFindInFile: "script.findInFile",
  scriptCreate: "script.create",
  scriptApplyEdits: "script.applyEdits",
  scriptApplyStructuredEdits: "script.applyStructuredEdits",

  // Arbitrary in-Editor C# execution (gated by allowCodeExecution)
  codeExecute: "code.execute",

  // Live reflection over loaded assemblies (anti-hallucination: verify a type/member exists)
  reflectQuery: "reflect.query",

  // Asset import / 2D pipeline
  assetImport: "asset.import",
  assetSliceSprite: "asset.sliceSprite",

  // Write operations (gated by safety mode at the MCP layer)
  editSetSerializedField: "edit.setSerializedField",
  editSetTransform: "edit.setTransform",
  editReparent: "edit.reparent",
  editAddComponent: "edit.addComponent",
  editCreateGameObject: "edit.createGameObject",
  editSaveScene: "edit.saveScene",
  editAssignReference: "edit.assignReference",
  editInstantiatePrefab: "edit.instantiatePrefab",
  editCreateScriptableObject: "edit.createScriptableObject",
  editCreateMaterial: "edit.createMaterial",
  editCreatePrefabVariant: "edit.createPrefabVariant",
  editWireUiButton: "edit.wireUiButton",
  editPaintTilemap: "edit.paintTilemap",
  editDeleteGameObject: "edit.deleteGameObject",
  editRemoveComponent: "edit.removeComponent",
  editDeleteAsset: "edit.deleteAsset",
} as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS];

/**
 * What kind of project state a write tool touches; drives the per-target safety flags in
 * `.unity-vibe/config.json` (allowSceneWrites, allowPrefabWrites, ...). Single source of
 * truth shared by @uvibe/safety (gating) and @uvibe/mcp-server (tool definitions).
 */
export type WriteTarget = "scene" | "prefab" | "asset" | "script" | "console" | "editor" | "code";

export interface BridgeRequest<P = Record<string, unknown>> {
  id: string;
  version: string;
  method: BridgeMethod;
  params: P;
}

export interface BridgeResponseMeta {
  unityVersion: string;
  projectPath: string;
  durationMs: number;
}

export interface BridgeResponseOk<T = unknown> {
  id: string;
  ok: true;
  result: T;
  error: null;
  meta: BridgeResponseMeta;
}

export interface BridgeResponseErr {
  id: string;
  ok: false;
  result: null;
  error: { code: string; message: string; details?: Record<string, unknown> };
  meta: Partial<BridgeResponseMeta>;
}

export type BridgeResponse<T = unknown> = BridgeResponseOk<T> | BridgeResponseErr;

export function makeBridgeRequest<P extends Record<string, unknown>>(
  method: BridgeMethod,
  params?: P
): BridgeRequest<P> {
  return {
    id: randomId(),
    version: PROTOCOL_VERSION,
    method,
    params: (params ?? ({} as P)) as P,
  };
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
