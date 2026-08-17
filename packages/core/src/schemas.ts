import { z } from "zod";
import { BRIDGE_METHODS, type BridgeMethod } from "./protocol.js";

const PrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const VariantSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([PrimitiveSchema, z.array(VariantSchema), z.record(z.string(), VariantSchema)]),
);

export const FilesystemStatusSchema = z.object({
  scanning: z.boolean(),
  importing: z.boolean(),
  progress: z.number(),
  indexedFiles: z.number().int().nonnegative(),
  requested: z.boolean().optional(),
});
export type FilesystemStatus = z.infer<typeof FilesystemStatusSchema>;

export const SystemHealthResultSchema = z.object({
  status: z.literal("ok"),
  godotVersion: z.string(),
  projectPath: z.string(),
  uptimeMs: z.number().int().nonnegative(),
  isPlaying: z.boolean(),
  filesystemScanning: z.boolean(),
});
export type SystemHealthResult = z.infer<typeof SystemHealthResultSchema>;

export const ProjectSummarySchema = z.object({
  engine: z.literal("godot"),
  godotVersion: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  platform: z.string(),
  openSceneCount: z.number().int().nonnegative(),
  editedScene: z.string(),
  isPlaying: z.boolean(),
  filesystem: FilesystemStatusSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const SceneSummarySchema = z.object({
  path: z.string(),
  name: z.string(),
  rootType: z.string(),
  active: z.boolean(),
  unsaved: z.boolean(),
});
export const OpenScenesResultSchema = z.object({
  scenes: z.array(SceneSummarySchema),
  count: z.number().int().nonnegative(),
  activeScene: z.string(),
});
export type OpenScenesResult = z.infer<typeof OpenScenesResultSchema>;

export const GodotPropertySchema = z.object({
  name: z.string(),
  type: z.number().int(),
  typeName: z.string(),
  hint: z.number().int(),
  hintString: z.string(),
  value: VariantSchema,
});

export interface SceneTreeNode {
  name: string;
  type: string;
  path: string;
  sceneFilePath: string;
  ownerPath: string;
  childCount: number;
  instanceId: number;
  properties?: z.infer<typeof GodotPropertySchema>[];
  children: SceneTreeNode[];
}
export const SceneTreeNodeSchema: z.ZodType<SceneTreeNode> = z.object({
  name: z.string(),
  type: z.string(),
  path: z.string(),
  sceneFilePath: z.string(),
  ownerPath: z.string(),
  childCount: z.number().int().nonnegative(),
  instanceId: z.number().int(),
  properties: z.array(GodotPropertySchema).optional(),
  children: z.array(z.lazy(() => SceneTreeNodeSchema)),
});
export const SceneTreeResultSchema = z.object({
  scenePath: z.string(),
  root: SceneTreeNodeSchema.nullable(),
  nodeCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type SceneTreeResult = z.infer<typeof SceneTreeResultSchema>;

export const GodotNodeSchema = z.object({
  name: z.string(),
  type: z.string(),
  path: z.string(),
  sceneFilePath: z.string(),
  ownerPath: z.string(),
  childCount: z.number().int().nonnegative(),
  instanceId: z.number().int(),
  properties: z.array(GodotPropertySchema).optional(),
});
export const SelectionInspectResultSchema = z.object({
  nodes: z.array(GodotNodeSchema),
  count: z.number().int().nonnegative(),
});
export type SelectionInspectResult = z.infer<typeof SelectionInspectResultSchema>;

export const FilesystemScanResultSchema = FilesystemStatusSchema.extend({
  requested: z.literal(true),
});
export type FilesystemScanResult = z.infer<typeof FilesystemScanResultSchema>;

export const ResourceDependencyResultSchema = z.object({
  path: z.string(),
  dependencies: z.array(z.object({
    path: z.string(),
    type: z.string(),
    uid: z.string(),
    raw: z.string(),
  })),
  count: z.number().int().nonnegative(),
});
export type ResourceDependencyResult = z.infer<typeof ResourceDependencyResultSchema>;

export const ReflectionResultSchema = z.object({
  query: z.string(),
  classes: z.array(z.object({
    name: z.string(),
    parent: z.string(),
    instantiable: z.boolean(),
    properties: z.array(z.record(z.string(), VariantSchema)).optional(),
    methods: z.array(z.record(z.string(), VariantSchema)).optional(),
    signals: z.array(z.record(z.string(), VariantSchema)).optional(),
  })),
  count: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
});
export type ReflectionResult = z.infer<typeof ReflectionResultSchema>;

export const ScreenshotResultSchema = z.object({
  kind: z.enum(["2d", "3d"]),
  mimeType: z.literal("image/png"),
  pngBase64: z.string().min(1),
  path: z.string(),
  absolutePath: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
});
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;

export const Screenshot2DResultSchema = ScreenshotResultSchema.extend({ kind: z.literal("2d") });
export const Screenshot3DResultSchema = ScreenshotResultSchema.extend({ kind: z.literal("3d") });

export const SceneOpenResultSchema = z.object({
  path: z.string(),
  opened: z.literal(true),
});
export type SceneOpenResult = z.infer<typeof SceneOpenResultSchema>;

export const SceneSaveResultSchema = z.object({
  path: z.string(),
  saved: z.boolean(),
});
export type SceneSaveResult = z.infer<typeof SceneSaveResultSchema>;

export const EditSetPropertyResultSchema = z.object({
  nodePath: z.string(),
  property: z.string(),
  previous: VariantSchema,
  value: VariantSchema,
});
export type EditSetPropertyResult = z.infer<typeof EditSetPropertyResultSchema>;

export const EditCreateNodeResultSchema = GodotNodeSchema;
export type EditCreateNodeResult = z.infer<typeof EditCreateNodeResultSchema>;

export const EditDeleteNodeResultSchema = z.object({
  nodePath: z.string(),
  deleted: z.boolean(),
});
export type EditDeleteNodeResult = z.infer<typeof EditDeleteNodeResultSchema>;

export const EditReparentNodeResultSchema = z.object({
  nodePath: z.string(),
  parentPath: z.string(),
});
export type EditReparentNodeResult = z.infer<typeof EditReparentNodeResultSchema>;

export const EditInstantiateSceneResultSchema = GodotNodeSchema.extend({
  sourceScene: z.string(),
});
export type EditInstantiateSceneResult = z.infer<typeof EditInstantiateSceneResultSchema>;

export const PlayStatusSchema = z.object({
  playing: z.boolean(),
  scenePath: z.string(),
  started: z.boolean().optional(),
  stopped: z.boolean().optional(),
  requestedMode: z.string().optional(),
});
export type PlayStatus = z.infer<typeof PlayStatusSchema>;

export const PlayRunResultSchema = PlayStatusSchema.extend({
  started: z.boolean(),
  requestedMode: z.enum(["current", "main", "custom"]).optional(),
});
export const PlayStopResultSchema = PlayStatusSchema.extend({ stopped: z.boolean() });

export const DebugEventSchema = z.object({
  cursor: z.number().int().nonnegative(),
  source: z.enum(["editor", "runtime"]),
  severity: z.enum(["info", "warning", "error"]),
  kind: z.string(),
  message: z.string(),
  file: z.string(),
  line: z.number().int(),
  function: z.string(),
  timestampMs: z.number().int().nonnegative(),
});
export type DebugEvent = z.infer<typeof DebugEventSchema>;

const NullableFiniteMetricSchema = z.number().finite().nullable();
export const DebugSampleSchema = z.object({
  cursor: z.number().int().nonnegative(),
  timestampMs: z.number().int().nonnegative(),
  fps: NullableFiniteMetricSchema,
  processMs: NullableFiniteMetricSchema,
  physicsMs: NullableFiniteMetricSchema,
  memoryBytes: NullableFiniteMetricSchema,
  objectCount: NullableFiniteMetricSchema,
  nodeCount: NullableFiniteMetricSchema,
  orphanNodeCount: NullableFiniteMetricSchema,
  drawCalls: NullableFiniteMetricSchema,
});
export type DebugSample = z.infer<typeof DebugSampleSchema>;

export const DebugRuntimeSchema = z.object({
  scenePath: z.string(),
  rootName: z.string(),
  rootType: z.string(),
  nodeCount: z.number().int().nonnegative(),
  pid: z.number().int().nonnegative(),
});
export type DebugRuntime = z.infer<typeof DebugRuntimeSchema>;

export const DebugScreenshotSchema = z.object({
  id: z.string().min(1),
  mimeType: z.literal("image/png"),
  pngBase64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  capturedAtMs: z.number().int().nonnegative(),
});
export type DebugScreenshot = z.infer<typeof DebugScreenshotSchema>;

export const DebugSnapshotParamsSchema = z.object({
  sinceEventCursor: z.number().int().nonnegative().optional(),
  sinceSampleCursor: z.number().int().nonnegative().optional(),
  maxEvents: z.number().int().min(1).max(200).optional(),
  maxSamples: z.number().int().min(1).max(120).optional(),
  requestScreenshot: z.boolean().optional(),
  includeScreenshot: z.boolean().optional(),
});
export type DebugSnapshotParams = z.infer<typeof DebugSnapshotParamsSchema>;

export const DebugSnapshotResultSchema = z.object({
  runId: z.string(),
  sessionId: z.number().int().nullable(),
  runtimeConnected: z.boolean(),
  playing: z.boolean(),
  breaked: z.boolean(),
  startedAtMs: z.number().int().nonnegative(),
  stoppedAtMs: z.number().int().nonnegative().nullable(),
  eventCursor: z.number().int().nonnegative(),
  sampleCursor: z.number().int().nonnegative(),
  firstEventCursor: z.number().int().nonnegative(),
  firstSampleCursor: z.number().int().nonnegative(),
  missedEvents: z.number().int().nonnegative(),
  missedSamples: z.number().int().nonnegative(),
  events: z.array(DebugEventSchema),
  samples: z.array(DebugSampleSchema),
  droppedEvents: z.number().int().nonnegative(),
  droppedSamples: z.number().int().nonnegative(),
  runtime: DebugRuntimeSchema.nullable(),
  screenshotId: z.string(),
  screenshot: DebugScreenshotSchema.nullable(),
  capturePending: z.boolean(),
  captureError: z.string().nullable(),
});
export type DebugSnapshotResult = z.infer<typeof DebugSnapshotResultSchema>;

export const CAPTURE_FRAME_LIMITS = {
  frames: { min: 2, max: 16, default: 8 },
  /** Godot's own viewport-capture cadence guidance: get_image() forces a GPU flush (#75877). */
  intervalMs: { min: 100, max: 2_000, default: 400 },
  width: { min: 160, max: 1_280, default: 480 },
  quality: { min: 1, max: 100, default: 70 },
  /** Frames returned per debug.captureFrames page, so one bridge response stays small. */
  page: { min: 1, max: 4, default: 4 },
} as const;

export const DebugCaptureFramesParamsSchema = z.object({
  captureId: z.string().optional().describe("Poll an in-flight sequence. Omit to start a new one."),
  frames: z.number().int().min(CAPTURE_FRAME_LIMITS.frames.min).max(CAPTURE_FRAME_LIMITS.frames.max).optional(),
  intervalMs: z.number().int().min(CAPTURE_FRAME_LIMITS.intervalMs.min).max(CAPTURE_FRAME_LIMITS.intervalMs.max).optional(),
  width: z.number().int().min(CAPTURE_FRAME_LIMITS.width.min).max(CAPTURE_FRAME_LIMITS.width.max).optional(),
  format: z.enum(["jpg", "png"]).optional(),
  quality: z.number().int().min(CAPTURE_FRAME_LIMITS.quality.min).max(CAPTURE_FRAME_LIMITS.quality.max).optional(),
  sinceIndex: z.number().int().nonnegative().optional(),
  maxFrames: z.number().int().min(CAPTURE_FRAME_LIMITS.page.min).max(CAPTURE_FRAME_LIMITS.page.max).optional(),
});
export type DebugCaptureFramesParams = z.infer<typeof DebugCaptureFramesParamsSchema>;

export const DebugFrameSchema = z.object({
  index: z.number().int().positive(),
  /** Milliseconds after the first captured frame of this sequence. */
  tMs: z.number().int().nonnegative(),
  /** Milliseconds since the previous captured frame; 0 for the first. */
  deltaMs: z.number().int().nonnegative(),
  /** Godot's reported process time for the frame this image came from. */
  frameTimeMs: z.number().finite().nonnegative(),
  /** Wall time the running game spent inside get_image/resize/encode for this frame. */
  captureCostMs: z.number().finite().nonnegative(),
  mimeType: z.enum(["image/jpeg", "image/png"]),
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  /** 8x8 grayscale average hash, 64 bits as 16 lowercase hex characters. */
  hash: z.string().regex(/^[0-9a-f]{16}$/),
});
export type DebugFrame = z.infer<typeof DebugFrameSchema>;

export const DebugCaptureFramesResultSchema = z.object({
  captureId: z.string(),
  state: z.enum(["pending", "complete", "error", "not_running"]),
  runId: z.string(),
  requested: z.object({
    frames: z.number().int().positive(),
    intervalMs: z.number().int().positive(),
    width: z.number().int().positive(),
    format: z.enum(["jpg", "png"]),
    quality: z.number().int().positive(),
  }),
  capturedCount: z.number().int().nonnegative(),
  frameCursor: z.number().int().nonnegative(),
  frames: z.array(DebugFrameSchema),
  droppedFrames: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type DebugCaptureFramesResult = z.infer<typeof DebugCaptureFramesResultSchema>;

export const BridgeResultSchemas = {
  [BRIDGE_METHODS.systemHealth]: SystemHealthResultSchema,
  [BRIDGE_METHODS.systemSummary]: ProjectSummarySchema,
  [BRIDGE_METHODS.sceneGetOpenScenes]: OpenScenesResultSchema,
  [BRIDGE_METHODS.sceneGetTree]: SceneTreeResultSchema,
  [BRIDGE_METHODS.selectionInspect]: SelectionInspectResultSchema,
  [BRIDGE_METHODS.filesystemStatus]: FilesystemStatusSchema,
  [BRIDGE_METHODS.filesystemScan]: FilesystemScanResultSchema,
  [BRIDGE_METHODS.resourceGetDependencies]: ResourceDependencyResultSchema,
  [BRIDGE_METHODS.reflectQuery]: ReflectionResultSchema,
  [BRIDGE_METHODS.viewportCapture2D]: Screenshot2DResultSchema,
  [BRIDGE_METHODS.viewportCapture3D]: Screenshot3DResultSchema,
  [BRIDGE_METHODS.sceneOpen]: SceneOpenResultSchema,
  [BRIDGE_METHODS.sceneSave]: SceneSaveResultSchema,
  [BRIDGE_METHODS.editSetProperty]: EditSetPropertyResultSchema,
  [BRIDGE_METHODS.editCreateNode]: EditCreateNodeResultSchema,
  [BRIDGE_METHODS.editDeleteNode]: EditDeleteNodeResultSchema,
  [BRIDGE_METHODS.editReparentNode]: EditReparentNodeResultSchema,
  [BRIDGE_METHODS.editInstantiateScene]: EditInstantiateSceneResultSchema,
  [BRIDGE_METHODS.playRun]: PlayRunResultSchema,
  [BRIDGE_METHODS.playStop]: PlayStopResultSchema,
  [BRIDGE_METHODS.playStatus]: PlayStatusSchema,
  [BRIDGE_METHODS.debugSnapshot]: DebugSnapshotResultSchema,
  [BRIDGE_METHODS.debugCaptureFrames]: DebugCaptureFramesResultSchema,
} satisfies Record<BridgeMethod, z.ZodTypeAny>;

export const ScriptReadResultSchema = z.object({
  path: z.string(), contents: z.string(), sha256: z.string(), lineCount: z.number().int(),
  sizeBytes: z.number().int(), truncated: z.boolean().optional(),
});
export type ScriptReadResult = z.infer<typeof ScriptReadResultSchema>;
export const ScriptShaResultSchema = z.object({
  path: z.string(), exists: z.boolean(), sha256: z.string(), sizeBytes: z.number().int(), lineCount: z.number().int(),
});
export type ScriptShaResult = z.infer<typeof ScriptShaResultSchema>;
export const ScriptFindResultSchema = z.object({
  path: z.string(), pattern: z.string(), matchCount: z.number().int(), truncated: z.boolean().optional(),
  matches: z.array(z.object({ line: z.number().int(), column: z.number().int(), match: z.string(), lineText: z.string() })),
});
export type ScriptFindResult = z.infer<typeof ScriptFindResultSchema>;
export const ScriptEditResultSchema = z.object({
  applied: z.boolean(), changed: z.boolean(), summary: z.string(), path: z.string(),
  sha256Before: z.string().optional(), sha256After: z.string().optional(), editCount: z.number().int().optional(),
  diff: z.string().optional(), createdPath: z.string().optional(), undoable: z.literal(false),
});
export type ScriptEditResult = z.infer<typeof ScriptEditResultSchema>;

export const VerifyResultSchema = z.object({
  verdict: z.enum(["pass", "fail", "unverified"]),
  import: z.object({ ok: z.boolean(), command: z.string(), exitCode: z.number().int(), output: z.string() }),
  scripts: z.object({ checked: z.number().int(), failed: z.number().int(), failures: z.array(z.object({ path: z.string(), output: z.string() })) }),
  csharp: z.object({
    status: z.enum(["not_present", "unverified"]),
    scripts: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    message: z.string(),
  }),
  tests: z.object({ status: z.literal("not_configured"), message: z.string() }),
  warnings: z.array(z.string()),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export const TestRunResultSchema = z.object({
  verdict: z.enum(["pass", "fail", "timeout"]),
  runnerPath: z.string(),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  output: z.string(),
  outputBytes: z.number().int().nonnegative(),
  outputTruncated: z.boolean(),
});
export type TestRunResult = z.infer<typeof TestRunResultSchema>;
