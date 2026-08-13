import { z } from "zod";
import { loadConfig } from "@uvibe/safety";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall, err } from "./_helpers.js";

/**
 * Generic Editor escape hatch: run a menu command by its path. This can do almost anything, so it
 * is doubly gated — the server's safety gate blocks it unless allowMenuItems is on, and this tool
 * additionally requires the exact path (or `*`) in `allowedMenuItems`. The allowlist lives in
 * .unity-vibe/config.json (TS side), so it is enforced here rather than in Unity. Skipped in mock
 * mode for deterministic verification.
 */

const ExecuteMenuItemShape = {
  menuItem: z
    .string()
    .describe("Exact menu path, e.g. 'Assets/Refresh' or 'GameObject/Align With View'."),
};

export function isMenuItemAllowed(allowedItems: readonly string[], menuItem: string): boolean {
  return allowedItems.includes("*") || allowedItems.includes(menuItem);
}

export const unityExecuteMenuItem: ToolDef<typeof ExecuteMenuItemShape, unknown> = {
  name: "unity_execute_menu_item",
  description:
    "Runs an Editor menu command by path (EditorApplication.ExecuteMenuItem) — a generic escape hatch for Editor commands without a dedicated tool. App-managed projects allow all paths with `allowedMenuItems:[\"*\"]`; custom configs can still use an exact allowlist.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "editor",
  inputShape: ExecuteMenuItemShape,
  async run(args, ctx) {
    if (!ctx.configMockMode) {
      const config = await loadConfig(ctx.projectPath);
      const allowed = config.allowedMenuItems ?? [];
      if (!config.allowMenuItems || !isMenuItemAllowed(allowed, args.menuItem)) {
        return err(
          "MENU_ITEM_NOT_ALLOWED",
          `Menu item '${args.menuItem}' is not available in this project configuration.`,
          { source: ctx.bridge.source },
          { menuItem: args.menuItem, allowed }
        );
      }
    }
    return bridgeCall(ctx.bridge, BRIDGE_METHODS.editorExecuteMenuItem, { menuItem: args.menuItem });
  },
};
