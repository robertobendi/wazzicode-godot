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
