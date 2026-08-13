import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { EditResult } from "@uvibe/core";

/**
 * Tilemap painting: stamp a tile asset onto cells of a scene Tilemap. Undo-wrapped and gated
 * (scene target). UnityEngine.Tilemaps is an engine module, so the bridge can use it directly.
 */

const CellShape = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int().optional(),
});

const PaintTilemapShape = {
  tilemapPath: z.string().optional().describe("Tilemap GameObject by hierarchy path (or current selection)."),
  tilemapInstanceId: z.number().int().optional().describe("Tilemap GameObject by instanceId."),
  tileAssetPath: z
    .string()
    .optional()
    .describe("TileBase asset path to paint, e.g. 'Assets/Tiles/Grass.asset'. Omit (or null tile) to erase."),
  cells: z
    .array(CellShape)
    .optional()
    .describe("Explicit cells to paint {x,y,z?}."),
  rect: z
    .object({ x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive(), z: z.number().int().optional() })
    .optional()
    .describe("Fill a rectangular block of cells instead of listing them."),
  erase: z.boolean().optional().describe("Clear the targeted cells instead of painting. Default false."),
};

export const unityPaintTilemap: ToolDef<typeof PaintTilemapShape, EditResult> = {
  name: "unity_paint_tilemap",
  description:
    "Paints (or erases) a tile asset onto cells of a scene Tilemap — either an explicit cell list or a rectangular block. Undo-wrapped; gated by safetyMode (confirm/autopilot + allowSceneWrites). Returns OBJECT_NOT_FOUND if the target has no Tilemap component.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: PaintTilemapShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editPaintTilemap, {
      tilemapPath: args.tilemapPath,
      tilemapInstanceId: args.tilemapInstanceId ?? 0,
      tileAssetPath: args.tileAssetPath,
      cells: args.cells,
      rect: args.rect,
      erase: args.erase ?? false,
    });
  },
};
