import { z } from "zod";

export const Vector3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type Vector3 = z.infer<typeof Vector3Schema>;

export const TransformSchema = z.object({
  position: Vector3Schema,
  rotation: Vector3Schema,
  localScale: Vector3Schema,
  worldPosition: Vector3Schema.optional(),
});
export type TransformData = z.infer<typeof TransformSchema>;

export const ObjectReferenceSchema = z.object({
  referenceType: z.enum(["GameObject", "Component", "Asset", "ScriptableObject", "Missing"]),
  name: z.string().optional(),
  path: z.string().optional(),
  guid: z.string().optional(),
  fileId: z.string().optional(),
  type: z.string().optional(),
});
export type ObjectReference = z.infer<typeof ObjectReferenceSchema>;

const PrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const SerializedFieldValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    PrimitiveSchema,
    Vector3Schema,
    ObjectReferenceSchema,
    z.array(SerializedFieldValueSchema),
    z.record(z.string(), SerializedFieldValueSchema),
  ])
);

export const ComponentSchema = z.object({
  type: z.string(),
  assembly: z.string().optional(),
  enabled: z.boolean().optional(),
  fields: z.record(z.string(), SerializedFieldValueSchema).optional(),
  isMissingScript: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
});
export type ComponentData = z.infer<typeof ComponentSchema>;

export const PrefabInfoSchema = z.object({
  isPrefabInstance: z.boolean(),
  isPrefabAsset: z.boolean().optional(),
  sourcePath: z.string().optional(),
  sourceGuid: z.string().optional(),
  hasOverrides: z.boolean().optional(),
});
export type PrefabInfo = z.infer<typeof PrefabInfoSchema>;

export const GameObjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  instanceId: z.number().int().optional(),
  activeSelf: z.boolean(),
  activeInHierarchy: z.boolean(),
  tag: z.string(),
  layer: z.string(),
  scene: z.string().optional(),
  prefab: PrefabInfoSchema.optional(),
  transform: TransformSchema,
  components: z.array(ComponentSchema),
  warnings: z.array(z.string()).optional(),
});
export type GameObjectData = z.infer<typeof GameObjectSchema>;

export const SceneSummarySchema = z.object({
  path: z.string(),
  name: z.string(),
  isLoaded: z.boolean(),
  isDirty: z.boolean(),
  rootCount: z.number().int(),
  buildIndex: z.number().int(),
});
export type SceneSummary = z.infer<typeof SceneSummarySchema>;

export interface SceneHierarchyNode {
  name: string;
  path: string;
  active: boolean;
  childCount: number;
  components?: string[];
  children?: SceneHierarchyNode[];
  warnings?: string[];
}

export const SceneHierarchyNodeSchema: z.ZodType<SceneHierarchyNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    active: z.boolean(),
    childCount: z.number().int(),
    components: z.array(z.string()).optional(),
    children: z.array(SceneHierarchyNodeSchema).optional(),
    warnings: z.array(z.string()).optional(),
  })
);

export const SceneHierarchySchema = z.object({
  scene: z.string(),
  roots: z.array(SceneHierarchyNodeSchema),
  totalObjects: z.number().int().optional(),
});
export type SceneHierarchy = z.infer<typeof SceneHierarchySchema>;

export const ConsoleLogSchema = z.object({
  type: z.enum(["Log", "Warning", "Error", "Assert", "Exception"]),
  message: z.string(),
  stackTrace: z.string().optional(),
  timestamp: z.number(),
});
export type ConsoleLog = z.infer<typeof ConsoleLogSchema>;

export const ConsoleLogsResultSchema = z.object({
  logs: z.array(ConsoleLogSchema),
  truncated: z.boolean(),
  bufferSize: z.number().int(),
  fallback: z.string().optional(),
});
export type ConsoleLogsResult = z.infer<typeof ConsoleLogsResultSchema>;

export const CompileErrorSchema = z.object({
  file: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  message: z.string(),
  type: z.enum(["error", "warning"]).optional(),
});
export type CompileError = z.infer<typeof CompileErrorSchema>;

export const CompileStatusSchema = z.object({
  isCompiling: z.boolean(),
  hasErrors: z.boolean(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  errors: z.array(CompileErrorSchema).optional(),
  fallback: z.string().optional(),
  /** Set by the compile.await long-poll: false means the window closed while still compiling. */
  settled: z.boolean().optional(),
});
export type CompileStatus = z.infer<typeof CompileStatusSchema>;

export const PackageRefSchema = z.object({
  name: z.string(),
  version: z.string(),
});
export type PackageRef = z.infer<typeof PackageRefSchema>;

export const ProjectSummarySchema = z.object({
  unityVersion: z.string(),
  projectPath: z.string(),
  productName: z.string().optional(),
  companyName: z.string().optional(),
  bundleIdentifier: z.string().optional(),
  renderPipeline: z.string().optional(),
  inputSystem: z.string().optional(),
  scriptingBackend: z.string().optional(),
  buildTarget: z.string().optional(),
  packages: z.array(PackageRefSchema).optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const SelectionInspectResultSchema = z.object({
  hasSelection: z.boolean(),
  selected: GameObjectSchema.optional(),
});
export type SelectionInspectResult = z.infer<typeof SelectionInspectResultSchema>;

export const OpenScenesResultSchema = z.object({
  scenes: z.array(SceneSummarySchema),
  activeScene: z.string().optional(),
});
export type OpenScenesResult = z.infer<typeof OpenScenesResultSchema>;

export const ScreenshotSourceSchema = z.enum([
  "game_view",
  "scene_view",
  "selected_object",
  "editor_window",
]);
export type ScreenshotSource = z.infer<typeof ScreenshotSourceSchema>;

export const ScreenshotResultSchema = z.object({
  source: ScreenshotSourceSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  /** base64-encoded image bytes (without the data: URL prefix). Historical name — the bytes
   *  are JPEG when mimeType says so. */
  pngBase64: z.string().min(1),
  /** Absolute path of the auto-saved PNG, when persisted to .unity-vibe/screenshots/. */
  savedTo: z.string().optional(),
  /** Human-readable description of what was captured (camera name, object path, etc.). */
  subject: z.string().optional(),
  /** Camera used to capture, if applicable. */
  cameraName: z.string().optional(),
});
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;

// ----- Performance probes -----

export const PerfCounterSchema = z.object({
  name: z.string(),
  /** Profiler category, e.g. "Render", "Memory", "Internal". */
  category: z.string().optional(),
  /** Rolling average across the sampled frames. */
  average: z.number(),
  last: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** "ns", "bytes", "count", etc. */
  unit: z.string().optional(),
  /** Number of frame samples that backed this average. */
  sampleCount: z.number().int().optional(),
});
export type PerfCounter = z.infer<typeof PerfCounterSchema>;

export const PerfSampleResultSchema = z.object({
  /** Recorders only advance while frames render; richest data is in play mode. */
  isPlaying: z.boolean(),
  /** True the very first time recorders are read (buffers not yet primed). */
  warmingUp: z.boolean().optional(),
  /** Derived FPS estimate from the main-thread counter, when available. */
  estimatedFps: z.number().optional(),
  /** Main-thread frame time in milliseconds, when available. */
  mainThreadMs: z.number().optional(),
  counters: z.array(PerfCounterSchema),
  fallback: z.string().optional(),
});
export type PerfSampleResult = z.infer<typeof PerfSampleResultSchema>;

// ----- Test runner -----

export const TestModeSchema = z.enum(["EditMode", "PlayMode"]);
export type TestMode = z.infer<typeof TestModeSchema>;

export const TestCaseResultSchema = z.object({
  name: z.string(),
  fullName: z.string().optional(),
  status: z.enum(["Passed", "Failed", "Skipped", "Inconclusive"]),
  durationSec: z.number().optional(),
  message: z.string().optional(),
  stackTrace: z.string().optional(),
});
export type TestCaseResult = z.infer<typeof TestCaseResultSchema>;

export const TestRunStatusSchema = z.object({
  runId: z.string(),
  /** Lifecycle of the async run; survives domain reloads triggered by PlayMode tests. */
  state: z.enum(["running", "completed", "cancelled", "not_found"]),
  mode: TestModeSchema.optional(),
  total: z.number().int().optional(),
  passed: z.number().int().optional(),
  failed: z.number().int().optional(),
  skipped: z.number().int().optional(),
  durationSec: z.number().optional(),
  results: z.array(TestCaseResultSchema).optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** Set by the test.await long-poll: false means the window closed while still running. */
  settled: z.boolean().optional(),
});
export type TestRunStatus = z.infer<typeof TestRunStatusSchema>;

// ----- Play mode + runtime inspection -----

export const PlayModeStatusSchema = z.object({
  isPlaying: z.boolean(),
  isPaused: z.boolean(),
  /** Runtime speed multiplier. Available on bridges with play-mode configuration support. */
  timeScale: z.number().optional(),
  /** True during the play-mode enter transition (domain reload in flight). */
  isTransitioning: z.boolean().optional(),
  /** Editor frame count, useful to confirm step/frame advances took effect. */
  frameCount: z.number().int().optional(),
  timeSinceLevelLoad: z.number().optional(),
  /** Set by playmode.await/playmode.step long-polls: false means the window closed first. */
  settled: z.boolean().optional(),
  /** Frames actually advanced by a multi-frame playmode.step (absent on older bridges). */
  framesStepped: z.number().int().optional(),
  /** True while a multi-frame step is still draining. */
  stepping: z.boolean().optional(),
});
export type PlayModeStatus = z.infer<typeof PlayModeStatusSchema>;

export const RuntimeObjectRefSchema = z.object({
  name: z.string(),
  path: z.string(),
  instanceId: z.number().int(),
  activeInHierarchy: z.boolean().optional(),
  components: z.array(z.string()).optional(),
});
export type RuntimeObjectRef = z.infer<typeof RuntimeObjectRefSchema>;

export const RuntimeFindResultSchema = z.object({
  isPlaying: z.boolean(),
  query: z.string().optional(),
  matchCount: z.number().int(),
  objects: z.array(RuntimeObjectRefSchema),
  truncated: z.boolean().optional(),
});
export type RuntimeFindResult = z.infer<typeof RuntimeFindResultSchema>;

export const RuntimeMutationResultSchema = z.object({
  applied: z.boolean(),
  changed: z.boolean().optional(),
  summary: z.string(),
  target: z.string(),
  runtimeOnly: z.boolean(),
  undoable: z.boolean(),
});
export type RuntimeMutationResult = z.infer<typeof RuntimeMutationResultSchema>;

// ----- Build readiness -----

export const BuildSettingsSceneSchema = z.object({
  path: z.string(),
  enabled: z.boolean(),
  guid: z.string().optional(),
  exists: z.boolean(),
});
export type BuildSettingsScene = z.infer<typeof BuildSettingsSceneSchema>;

export const BuildSettingsResultSchema = z.object({
  valid: z.boolean(),
  activeBuildTarget: z.string(),
  buildTargetGroup: z.string(),
  targetSupported: z.boolean(),
  developmentBuild: z.boolean(),
  enabledSceneCount: z.number().int().nonnegative(),
  scenes: z.array(BuildSettingsSceneSchema),
  issues: z.array(z.string()),
});
export type BuildSettingsResult = z.infer<typeof BuildSettingsResultSchema>;

// ----- Asset / reference graph -----

export const AssetRefSchema = z.object({
  path: z.string(),
  guid: z.string().optional(),
  type: z.string().optional(),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

export const MissingScriptHitSchema = z.object({
  assetPath: z.string(),
  objectPath: z.string(),
  missingCount: z.number().int(),
});
export type MissingScriptHit = z.infer<typeof MissingScriptHitSchema>;

export const MissingReferenceHitSchema = z.object({
  assetPath: z.string(),
  objectPath: z.string(),
  component: z.string(),
  field: z.string(),
});
export type MissingReferenceHit = z.infer<typeof MissingReferenceHitSchema>;

export const MissingScriptsResultSchema = z.object({
  scanned: z.number().int(),
  hits: z.array(MissingScriptHitSchema),
  truncated: z.boolean().optional(),
});
export type MissingScriptsResult = z.infer<typeof MissingScriptsResultSchema>;

export const MissingReferencesResultSchema = z.object({
  scanned: z.number().int(),
  hits: z.array(MissingReferenceHitSchema),
  truncated: z.boolean().optional(),
});
export type MissingReferencesResult = z.infer<typeof MissingReferencesResultSchema>;

export const AssetDependencyResultSchema = z.object({
  /** The asset whose graph was queried. */
  asset: AssetRefSchema,
  /** "dependencies" = assets this one uses; "references" = assets that use this one. */
  direction: z.enum(["dependencies", "references"]),
  recursive: z.boolean().optional(),
  count: z.number().int(),
  assets: z.array(AssetRefSchema),
  truncated: z.boolean().optional(),
});
export type AssetDependencyResult = z.infer<typeof AssetDependencyResultSchema>;

// ----- Write operations -----

export const EditResultSchema = z.object({
  applied: z.boolean(),
  /** What changed, human-readable, suitable for an action-log note. */
  summary: z.string(),
  /** Object affected, when applicable. */
  target: z.string().optional(),
  /** Path of the GameObject/asset created, when applicable. */
  createdPath: z.string().optional(),
  /** Scene marked dirty by this edit (caller may want to save). */
  sceneDirtied: z.string().optional(),
  /** Whether a Unity Undo entry was recorded (so the user can Ctrl+Z). */
  undoable: z.boolean().optional(),
});
export type EditResult = z.infer<typeof EditResultSchema>;

// ----- C# script editing -----

export const ScriptReadResultSchema = z.object({
  path: z.string(),
  contents: z.string(),
  /** SHA-256 of the file's UTF-8 bytes; pass back as a precondition to guard against races. */
  sha256: z.string(),
  lineCount: z.number().int(),
  sizeBytes: z.number().int(),
  /** True when contents were clipped to a requested line window. */
  truncated: z.boolean().optional(),
});
export type ScriptReadResult = z.infer<typeof ScriptReadResultSchema>;

export const ScriptShaResultSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  lineCount: z.number().int(),
});
export type ScriptShaResult = z.infer<typeof ScriptShaResultSchema>;

export const ScriptFindMatchSchema = z.object({
  line: z.number().int(),
  column: z.number().int(),
  match: z.string(),
  lineText: z.string(),
});
export const ScriptFindResultSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  matchCount: z.number().int(),
  matches: z.array(ScriptFindMatchSchema),
  truncated: z.boolean().optional(),
});
export type ScriptFindResult = z.infer<typeof ScriptFindResultSchema>;

export const ScriptEditResultSchema = z.object({
  applied: z.boolean(),
  summary: z.string(),
  path: z.string(),
  /** SHA of the file before/after the edit; lets a caller confirm what actually changed. */
  sha256Before: z.string().optional(),
  sha256After: z.string().optional(),
  /** False when a no-op (e.g. preview, or new == old). */
  changed: z.boolean().optional(),
  /** Number of discrete edits applied. */
  editCount: z.number().int().optional(),
  /** Unified diff, when preview mode is requested (no write performed). */
  diff: z.string().optional(),
  createdPath: z.string().optional(),
  undoable: z.boolean().optional(),
});
export type ScriptEditResult = z.infer<typeof ScriptEditResultSchema>;

// ----- In-Editor C# execution -----

export const CodeExecResultSchema = z.object({
  compiled: z.boolean(),
  executed: z.boolean(),
  errorCount: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), number: z.string().optional(), message: z.string() })).optional(),
  warnings: z.array(z.object({ line: z.number().int(), number: z.string().optional(), message: z.string() })).optional(),
  returnType: z.string().optional(),
  returnValue: z.string().nullable().optional(),
  logs: z.array(z.object({ type: z.string(), message: z.string() })).optional(),
  runtimeError: z.string().optional(),
  summary: z.string(),
});
export type CodeExecResult = z.infer<typeof CodeExecResultSchema>;
