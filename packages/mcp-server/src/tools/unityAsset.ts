import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { EditResult } from "@uvibe/core";

/**
 * Asset pipeline writes: (re)import assets (optionally copying an external file into the project)
 * and slice a texture into sprites. Both persist to the AssetDatabase and are gated (asset target).
 */

const ImportAssetShape = {
  path: z.string().describe("Project-relative target path under Assets/, e.g. 'Assets/Art/hero.png'."),
  sourcePath: z
    .string()
    .optional()
    .describe("Absolute path of an external file to copy into `path` before importing. Omit to (re)import an asset already at `path`."),
  recursive: z.boolean().optional().describe("Import a folder recursively (ImportAssetOptions.ImportRecursive). Default false."),
};

export const unityImportAsset: ToolDef<typeof ImportAssetShape, EditResult> = {
  name: "unity_import_asset",
  description:
    "Imports or reimports an asset into the project — optionally copying an external file (sourcePath) into Assets/ first, then running AssetDatabase.ImportAsset so Unity generates the .meta and processes it. Gated by safetyMode (confirm/autopilot; asset target).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "asset",
  inputShape: ImportAssetShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.assetImport, {
      path: args.path,
      sourcePath: args.sourcePath,
      recursive: args.recursive ?? false,
    });
  },
};

const SliceSpriteShape = {
  texturePath: z.string().describe("Texture asset path under Assets/, e.g. 'Assets/Art/tiles.png'."),
  mode: z
    .enum(["grid_by_cell_size", "grid_by_cell_count"])
    .optional()
    .describe("Grid slicing strategy. Default 'grid_by_cell_size'."),
  cellWidth: z.number().int().optional().describe("Cell width in px (grid_by_cell_size)."),
  cellHeight: z.number().int().optional().describe("Cell height in px (grid_by_cell_size)."),
  columns: z.number().int().optional().describe("Column count (grid_by_cell_count)."),
  rows: z.number().int().optional().describe("Row count (grid_by_cell_count)."),
  paddingX: z.number().int().optional().describe("Horizontal padding between cells, px. Default 0."),
  paddingY: z.number().int().optional().describe("Vertical padding between cells, px. Default 0."),
  offsetX: z.number().int().optional().describe("Left/bottom offset before the first cell, px. Default 0."),
  offsetY: z.number().int().optional().describe("Offset, px. Default 0."),
  pixelsPerUnit: z.number().optional().describe("Sprite pixels-per-unit. Default 100."),
  pivot: z
    .enum(["Center", "TopLeft", "Top", "TopRight", "Left", "Right", "BottomLeft", "Bottom", "BottomRight"])
    .optional()
    .describe("Sprite pivot. Default 'Center'."),
};

export const unitySliceSprite: ToolDef<typeof SliceSpriteShape, EditResult> = {
  name: "unity_slice_sprite",
  description:
    "Slices a texture into multiple sprites on a regular grid (sets the importer to Sprite/Multiple, builds the sprite rects, and reimports). Specify cell size or a column/row count. Gated by safetyMode (confirm/autopilot; asset target).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "asset",
  inputShape: SliceSpriteShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.assetSliceSprite, { ...args });
  },
};
