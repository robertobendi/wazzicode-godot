import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import {
  AssetDependencyResult,
  MissingReferencesResult,
  MissingScriptsResult,
} from "@uvibe/core";

const MissingShape = {
  limit: z.number().int().min(1).max(2000).optional(),
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityFindMissingScripts: ToolDef<typeof MissingShape, MissingScriptsResult> = {
  name: "unity_find_missing_scripts",
  description:
    "Scans all prefab assets and currently-open scenes for GameObjects with missing MonoBehaviour scripts (the dreaded 'The associated script can not be loaded'). Returns the asset, object path, and count per hit. Closed scenes are not opened (that would be destructive) — open them first to include them.",
  requires: ["unity_bridge"],
  inputShape: MissingShape,
  async run(args, ctx) {
    return bridgeCall<MissingScriptsResult>(
      ctx.bridge,
      BRIDGE_METHODS.assetFindMissingScripts,
      { limit: args.limit ?? 200 },
      args.detailLevel ?? "normal"
    );
  },
};

export const unityFindMissingReferences: ToolDef<typeof MissingShape, MissingReferencesResult> = {
  name: "unity_find_missing_references",
  description:
    "Scans prefab assets and open scenes for serialized object-reference fields whose target is gone (a dangling reference: the field points at a fileID that no longer resolves). Returns asset, object path, component, and field for each broken link — the usual cause of NullReferenceExceptions at runtime.",
  requires: ["unity_bridge"],
  inputShape: MissingShape,
  async run(args, ctx) {
    return bridgeCall<MissingReferencesResult>(
      ctx.bridge,
      BRIDGE_METHODS.assetFindMissingReferences,
      { limit: args.limit ?? 200 },
      args.detailLevel ?? "normal"
    );
  },
};

const DepsShape = {
  path: z.string().describe("Project-relative asset path, e.g. 'Assets/Prefabs/Player.prefab'."),
  recursive: z.boolean().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityFindDependencies: ToolDef<typeof DepsShape, AssetDependencyResult> = {
  name: "unity_find_dependencies",
  description:
    "Lists the assets that a given asset depends on (uses), via AssetDatabase.GetDependencies. Set recursive=true (default) for the full transitive set, false for direct dependencies only.",
  requires: ["unity_bridge"],
  inputShape: DepsShape,
  async run(args, ctx) {
    return bridgeCall<AssetDependencyResult>(
      ctx.bridge,
      BRIDGE_METHODS.assetFindDependencies,
      { path: args.path, recursive: args.recursive ?? true, limit: args.limit ?? 500 },
      args.detailLevel ?? "normal"
    );
  },
};

const RefsShape = {
  path: z.string().describe("Project-relative asset path to find usages of."),
  limit: z.number().int().min(1).max(5000).optional(),
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityFindReferences: ToolDef<typeof RefsShape, AssetDependencyResult> = {
  name: "unity_find_references",
  description:
    "Reverse dependency lookup: lists assets that reference (use) the given asset. Answers 'what breaks if I delete/rename this?'. Scans the whole project so it can take a moment on large projects.",
  requires: ["unity_bridge"],
  inputShape: RefsShape,
  async run(args, ctx) {
    return bridgeCall<AssetDependencyResult>(
      ctx.bridge,
      BRIDGE_METHODS.assetFindReferences,
      { path: args.path, limit: args.limit ?? 500 },
      args.detailLevel ?? "normal"
    );
  },
};
