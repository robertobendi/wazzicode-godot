import { z } from "zod";
import { ToolDef } from "../registry.js";
import { ok, err } from "./_helpers.js";
import { TOOL_GROUPS, isKnownGroup } from "../groups.js";

/**
 * Controls which optional tool groups are exposed this session. Most groups are active by default;
 * use this to turn on an advanced group (e.g. codegen → unity_execute_code) or to trim groups you
 * aren't using so the tool list stays focused. Toggling sends tools/list_changed, so the client's
 * tool list updates without reconnecting.
 */
const ManageToolsShape = {
  action: z.enum(["list_groups", "activate", "deactivate"]).optional().describe("Default list_groups."),
  group: z.string().optional().describe("Group name for activate/deactivate (see list_groups)."),
};

interface ManageToolsResult {
  action: string;
  groups: Array<{ name: string; description: string; active: boolean; toolCount?: number }>;
  changed?: boolean;
  affected?: string[];
  note?: string;
}

export const unityManageTools: ToolDef<typeof ManageToolsShape, ManageToolsResult> = {
  name: "unity_manage_tools",
  description:
    "Lists tool groups and activates/deactivates them for this session. Groups: " +
    TOOL_GROUPS.map((g) => `${g.name}${g.defaultActive ? "" : " (off by default)"}`).join(", ") +
    ". 'core' is always on. Use action:'activate' group:'codegen' to enable unity_execute_code, or deactivate groups you don't need to shrink the tool list. Changes take effect immediately.",
  requires: [],
  inputShape: ManageToolsShape,
  async run(args, ctx) {
    const action = args.action ?? "list_groups";
    const meta = { source: ctx.bridge.source } as const;
    const controller = ctx.toolGroups;

    if (action === "list_groups") {
      const groups = controller
        ? controller.list()
        : TOOL_GROUPS.map((g) => ({ name: g.name, description: g.description, active: g.defaultActive }));
      return ok<ManageToolsResult>({ action, groups }, meta);
    }

    if (!args.group || !isKnownGroup(args.group)) {
      return err("INVALID_ARGUMENT", `'${args.group ?? ""}' is not a known group. Call action:'list_groups' to see them.`, meta);
    }
    if (args.group === "core") {
      return err("INVALID_ARGUMENT", "The 'core' group is always active and cannot be toggled.", meta);
    }
    if (!controller) {
      return ok<ManageToolsResult>(
        { action, groups: TOOL_GROUPS.map((g) => ({ name: g.name, description: g.description, active: g.defaultActive })), note: "Live toggling is only available when running inside the MCP server." },
        meta,
        ["No live tool-group controller in this context; nothing was changed."]
      );
    }

    const { changed, affected } = controller.setActive(args.group, action === "activate");
    return ok<ManageToolsResult>(
      { action, group: args.group, changed, affected, groups: controller.list() } as ManageToolsResult & { group: string },
      meta
    );
  },
};
