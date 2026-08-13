import { z } from "zod";
import type {
  FilesystemStatus,
  OpenScenesResult,
  ProjectSummary,
  ReflectionResult,
  ResourceDependencyResult,
  SceneTreeResult,
  ScreenshotResult,
  SelectionInspectResult,
} from "@gvibe/core";
import type { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall, err } from "./_helpers.js";

const EmptyShape = {};

export const godotProjectSummary: ToolDef<typeof EmptyShape, ProjectSummary> = {
  name: "godot_project_summary",
  description: "Returns the live Godot version, project identity, edited scene, play state, platform, and import/index state from the open editor.",
  requires: ["godot_bridge"],
  inputShape: EmptyShape,
  run: (_args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.systemSummary),
};

export const godotGetOpenScenes: ToolDef<typeof EmptyShape, OpenScenesResult> = {
  name: "godot_get_open_scenes",
  description: "Lists scenes open in the Godot editor, identifying the edited scene and unsaved scenes.",
  requires: ["godot_bridge"],
  inputShape: EmptyShape,
  run: (_args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.sceneGetOpenScenes),
};

const TreeShape = {
  nodePath: z.string().optional().describe("NodePath relative to the edited scene root. Use '.' for the root."),
  maxDepth: z.number().int().min(0).max(64).optional(),
  maxNodes: z.number().int().min(1).max(10_000).optional(),
  includeProperties: z.boolean().optional().describe("Include serialized property metadata and JSON-safe values."),
};
export const godotGetSceneTree: ToolDef<typeof TreeShape, SceneTreeResult> = {
  name: "godot_get_scene_tree",
  description: "Reads the live edited scene as a bounded Node tree. Narrow with nodePath/maxDepth for large scenes.",
  requires: ["godot_bridge"],
  inputShape: TreeShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.sceneGetTree, args),
};

const SelectionShape = {
  includeProperties: z.boolean().optional(),
  maxProperties: z.number().int().min(1).max(500).optional(),
};
export const godotInspectSelected: ToolDef<typeof SelectionShape, SelectionInspectResult> = {
  name: "godot_inspect_selected",
  description: "Inspects the nodes currently selected in Godot, including exact NodePaths, types, ownership, scripts, and optionally properties.",
  requires: ["godot_bridge"],
  inputShape: SelectionShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.selectionInspect, args),
};

export const godotGetFilesystemStatus: ToolDef<typeof EmptyShape, FilesystemStatus> = {
  name: "godot_get_filesystem_status",
  description: "Reports whether Godot is scanning/importing and how many resource files are indexed.",
  requires: ["godot_bridge"],
  inputShape: EmptyShape,
  run: (_args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.filesystemStatus),
};

export const godotRefreshFilesystem: ToolDef<typeof EmptyShape, FilesystemStatus> = {
  name: "godot_refresh_filesystem",
  description: "Requests an EditorFileSystem scan after external file changes and returns current import/index state.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "editor",
  inputShape: EmptyShape,
  run: (_args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.filesystemScan),
};

const DependenciesShape = {
  path: z.string().describe("A res:// resource path, such as res://scenes/player.tscn."),
};
export const godotFindDependencies: ToolDef<typeof DependenciesShape, ResourceDependencyResult> = {
  name: "godot_find_dependencies",
  description: "Returns ResourceLoader dependencies for one Godot resource with parsed path, type, UID, and raw dependency data.",
  requires: ["godot_bridge"],
  inputShape: DependenciesShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.resourceGetDependencies, args),
};

const ReflectShape = {
  className: z.string().optional().describe("Exact ClassDB class to inspect, e.g. CharacterBody2D."),
  query: z.string().optional().describe("Class-name search when the exact class is unknown."),
  limit: z.number().int().min(1).max(100).optional(),
  includeInherited: z.boolean().optional(),
  includeProperties: z.boolean().optional(),
  includeMethods: z.boolean().optional(),
  includeSignals: z.boolean().optional(),
};
export const godotReflect: ToolDef<typeof ReflectShape, ReflectionResult> = {
  name: "godot_reflect",
  description: "Queries the open editor's ClassDB before code is written, returning real inheritance, properties, methods, and signals instead of relying on remembered Godot APIs.",
  requires: ["godot_bridge"],
  inputShape: ReflectShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.reflectQuery, args, "full"),
};

const CaptureShape = {
  outputPath: z.string().refine(isManagedCapturePath, "Capture output must be a PNG directly under res://.godot/godot-vibe-os/captures/.").optional().describe("Optional managed capture path under res://.godot/godot-vibe-os/captures/. The image is always returned inline too."),
  width: z.number().int().min(64).max(4096).optional(),
  height: z.number().int().min(64).max(4096).optional(),
};
export const godotCapture2DView: ToolDef<typeof CaptureShape, ScreenshotResult> = {
  name: "godot_capture_2d_view",
  description: "Captures the live Godot 2D editor viewport as a PNG and returns it as visible image content.",
  requires: ["godot_bridge"],
  inputShape: CaptureShape,
  run: (args, ctx) => {
    if (args.outputPath && !isManagedCapturePath(args.outputPath)) return Promise.resolve(capturePathError(ctx.bridge.source));
    return bridgeCall(ctx.bridge, BRIDGE_METHODS.viewportCapture2D, args, "full");
  },
};

const Capture3DShape = { ...CaptureShape, viewportIndex: z.number().int().min(0).max(3).optional() };
export const godotCapture3DView: ToolDef<typeof Capture3DShape, ScreenshotResult> = {
  name: "godot_capture_3d_view",
  description: "Captures a live Godot 3D editor viewport as a PNG and returns it as visible image content.",
  requires: ["godot_bridge"],
  inputShape: Capture3DShape,
  run: (args, ctx) => {
    if (args.outputPath && !isManagedCapturePath(args.outputPath)) return Promise.resolve(capturePathError(ctx.bridge.source));
    return bridgeCall(ctx.bridge, BRIDGE_METHODS.viewportCapture3D, args, "full");
  },
};

function isManagedCapturePath(value: string): boolean {
  return /^(?:res:\/\/)?\.godot\/godot-vibe-os\/captures\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(value);
}

function capturePathError(source: "godot_bridge" | "mock") {
  return err(
    "INVALID_ARGUMENT",
    "Capture outputPath must be a PNG directly under res://.godot/godot-vibe-os/captures/.",
    { source }
  );
}

const OpenSceneShape = {
  path: z.string().describe("Scene path, e.g. res://scenes/main.tscn."),
  inherited: z.boolean().optional(),
};
export const godotOpenScene: ToolDef<typeof OpenSceneShape, unknown> = {
  name: "godot_open_scene",
  description: "Opens a .tscn scene in the editor, optionally as an inherited scene.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "editor",
  inputShape: OpenSceneShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.sceneOpen, args),
};

const SaveSceneShape = {
  path: z.string().optional().describe("Optional res:// destination for an unsaved scene."),
  withPreview: z.boolean().optional(),
};
export const godotSaveScene: ToolDef<typeof SaveSceneShape, unknown> = {
  name: "godot_save_scene",
  description: "Saves the edited scene through Godot's editor API. File snapshots and the action log complement scene UndoRedo.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: SaveSceneShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.sceneSave, args),
};

const SetPropertyShape = {
  nodePath: z.string().describe("NodePath relative to the edited root."),
  property: z.string().describe("Exact property name confirmed by inspection or godot_reflect."),
  value: z.unknown().describe("JSON-safe value converted from the target property type: scalars; vectors/colors as numeric arrays or x/y/z/w and r/g/b/a objects; NodePath/StringName as strings; Resources as {resourcePath:'res://...'}; arrays/dictionaries as JSON."),
};
export const godotSetProperty: ToolDef<typeof SetPropertyShape, unknown> = {
  name: "godot_set_property",
  description: "Sets one live node property using an editor UndoRedo action. Inspect the node or reflect its class first.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: SetPropertyShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.editSetProperty, args),
};

const CreateNodeShape = {
  parentPath: z.string().optional().describe("Parent NodePath; defaults to the edited root."),
  className: z.string().optional().describe("ClassDB type, e.g. Sprite2D. Alias: type."),
  type: z.string().optional(),
  name: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
};
export const godotCreateNode: ToolDef<typeof CreateNodeShape, unknown> = {
  name: "godot_create_node",
  description: "Creates a persistent node under the edited scene, sets owner correctly, applies initial properties, and registers UndoRedo.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: CreateNodeShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.editCreateNode, args),
};

const DeleteNodeShape = { nodePath: z.string().describe("Exact NodePath to remove.") };
export const godotDeleteNode: ToolDef<typeof DeleteNodeShape, unknown> = {
  name: "godot_delete_node",
  description: "Removes a node from the edited scene through UndoRedo.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: DeleteNodeShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.editDeleteNode, args),
};

const ReparentShape = {
  nodePath: z.string(),
  newParentPath: z.string(),
  keepGlobalTransform: z.boolean().optional(),
};
export const godotReparentNode: ToolDef<typeof ReparentShape, unknown> = {
  name: "godot_reparent_node",
  description: "Reparents a node through UndoRedo, optionally preserving its global transform.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: ReparentShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.editReparentNode, args),
};

const InstantiateShape = {
  scenePath: z.string().describe("PackedScene path to instantiate."),
  parentPath: z.string().optional(),
  name: z.string().optional(),
};
export const godotInstantiateScene: ToolDef<typeof InstantiateShape, unknown> = {
  name: "godot_instantiate_scene",
  description: "Instantiates a PackedScene under the edited scene and registers the change with UndoRedo.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: InstantiateShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.editInstantiateScene, args),
};

const RunShape = {
  mode: z.enum(["current", "main", "custom"]).optional(),
  path: z.string().optional().describe("Required for custom mode."),
};
export const godotRunProject: ToolDef<typeof RunShape, unknown> = {
  name: "godot_run_project",
  description: "Runs the current, main, or a custom scene through the Godot editor.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "editor",
  inputShape: RunShape,
  run: (args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.playRun, args),
};

export const godotStopProject: ToolDef<typeof EmptyShape, unknown> = {
  name: "godot_stop_project",
  description: "Stops the currently running project process through the Godot editor.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "editor",
  inputShape: EmptyShape,
  run: (_args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.playStop),
};

export const godotGetPlayStatus: ToolDef<typeof EmptyShape, unknown> = {
  name: "godot_get_play_status",
  description: "Returns whether a project scene is running and its scene path.",
  requires: ["godot_bridge"],
  inputShape: EmptyShape,
  run: (_args, ctx) => bridgeCall(ctx.bridge, BRIDGE_METHODS.playStatus),
};
