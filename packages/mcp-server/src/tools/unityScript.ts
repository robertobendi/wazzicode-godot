import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { ScriptReadResult, ScriptShaResult, ScriptFindResult, ScriptEditResult } from "@uvibe/core";

/**
 * C# script editing. These are what let Claude author and surgically edit your game code rather
 * than guessing from serialized YAML. Reads are ungated; the create/edit tools are write tools
 * with the 'script' target (require confirm/autopilot + allowScriptWrites). Every write hits disk
 * and triggers a Unity import → recompile, so follow them with unity_verify.
 *
 * Editing strategies, from most to least structured:
 *   - unity_script_edit       — method/anchor-aware ops (replace_method, insert_method, anchors).
 *   - unity_apply_text_edits  — deterministic line/column range replacements.
 *   - unity_create_script     — write a whole new file.
 * Prefer reading first (unity_read_script) and passing back its sha256 as preconditionSha256 so a
 * concurrent change can't be silently clobbered.
 */

const ReadShape = {
  path: z.string().describe("Project-relative path, e.g. 'Assets/Scripts/Player.cs'."),
  startLine: z.number().int().optional().describe("1-based first line to return (windowed read). Omit for whole file."),
  endLine: z.number().int().optional().describe("1-based last line to return; defaults to end of file."),
};

export const unityReadScript: ToolDef<typeof ReadShape, ScriptReadResult> = {
  name: "unity_read_script",
  description:
    "Reads a C# (or other text) file under Assets/ (or Packages/) and returns its contents, line count, and sha256. Pass that sha256 back as preconditionSha256 on a later edit to guard against clobbering concurrent changes. Optionally window the read with startLine/endLine.",
  requires: ["unity_bridge"],
  inputShape: ReadShape,
  async run(args, ctx) {
    return bridgeCall<ScriptReadResult>(ctx.bridge, BRIDGE_METHODS.scriptRead, {
      path: args.path,
      startLine: args.startLine ?? 0,
      endLine: args.endLine ?? 0,
    });
  },
};

const ShaShape = {
  path: z.string().describe("Project-relative path to a file under Assets/ (or Packages/)."),
};

export const unityGetScriptSha: ToolDef<typeof ShaShape, ScriptShaResult> = {
  name: "unity_get_script_sha",
  description:
    "Returns sha256, byte size, and line count of a file without transferring its contents — a cheap way to detect whether a file changed, or to obtain a precondition hash before editing.",
  requires: ["unity_bridge"],
  inputShape: ShaShape,
  async run(args, ctx) {
    return bridgeCall<ScriptShaResult>(ctx.bridge, BRIDGE_METHODS.scriptGetSha, { path: args.path });
  },
};

const FindShape = {
  path: z.string().describe("File to search, under Assets/ (or Packages/)."),
  pattern: z.string().describe("Regex (per-line, .NET syntax) to search for."),
  ignoreCase: z.boolean().optional().describe("Case-insensitive match."),
  maxResults: z.number().int().optional().describe("Cap on matches returned (default 100)."),
};

export const unityFindInFile: ToolDef<typeof FindShape, ScriptFindResult> = {
  name: "unity_find_in_file",
  description:
    "Regex-searches a single source file and returns line/column for each match plus the matching line text. Use it to locate a method, field, or anchor before editing — cheaper and more precise than reading the whole file.",
  requires: ["unity_bridge"],
  inputShape: FindShape,
  async run(args, ctx) {
    return bridgeCall<ScriptFindResult>(ctx.bridge, BRIDGE_METHODS.scriptFindInFile, {
      path: args.path,
      pattern: args.pattern,
      ignoreCase: args.ignoreCase ?? false,
      maxResults: args.maxResults ?? 100,
    });
  },
};

const CreateShape = {
  path: z.string().describe("New file path under Assets/, ending in .cs, e.g. 'Assets/Scripts/Enemy.cs'."),
  contents: z.string().describe("Full file contents to write."),
  overwrite: z.boolean().optional().describe("Replace the file if it already exists (default false → errors)."),
};

export const unityCreateScript: ToolDef<typeof CreateShape, ScriptEditResult> = {
  name: "unity_create_script",
  description:
    "Creates a new C# script file under Assets/ with the given contents and triggers a Unity import/recompile. Gated by safetyMode (confirm/autopilot + allowScriptWrites). Follow with unity_verify to confirm it compiles. To change an existing file, use unity_apply_text_edits or unity_script_edit instead.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "script",
  inputShape: CreateShape,
  async run(args, ctx) {
    return bridgeCall<ScriptEditResult>(ctx.bridge, BRIDGE_METHODS.scriptCreate, {
      path: args.path,
      contents: args.contents,
      overwrite: args.overwrite ?? false,
    });
  },
};

const RangeEditSchema = z.object({
  startLine: z.number().int().describe("1-based start line."),
  startCol: z.number().int().optional().describe("1-based start column (1 = before first char). Default 1."),
  endLine: z.number().int().optional().describe("1-based end line (exclusive of newline). Defaults to startLine."),
  endCol: z.number().int().optional().describe("1-based end column. Defaults to startCol (pure insertion)."),
  newText: z.string().describe("Replacement text for the [start,end) span."),
});

const ApplyEditsShape = {
  path: z.string().describe("File to edit, under Assets/."),
  edits: z.array(RangeEditSchema).describe("Disjoint line/column range replacements, applied atomically."),
  preconditionSha256: z.string().optional().describe("If set, the edit only applies when the file's current sha256 matches (from unity_read_script)."),
  preview: z.boolean().optional().describe("Return a unified diff without writing."),
};

export const unityApplyTextEdits: ToolDef<typeof ApplyEditsShape, ScriptEditResult> = {
  name: "unity_apply_text_edits",
  description:
    "Applies one or more deterministic line/column range edits to a source file (1-based line & column; end is exclusive). Ranges must be disjoint; they are applied atomically and the file is re-imported. This is the precise, always-correct editing path — get exact positions from unity_read_script / unity_find_in_file. Gated by safetyMode (confirm/autopilot + allowScriptWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "script",
  inputShape: ApplyEditsShape,
  async run(args, ctx) {
    return bridgeCall<ScriptEditResult>(ctx.bridge, BRIDGE_METHODS.scriptApplyEdits, {
      path: args.path,
      edits: args.edits,
      preconditionSha256: args.preconditionSha256,
      preview: args.preview ?? false,
    });
  },
};

const StructuredEditSchema = z.object({
  op: z
    .enum([
      "replace_method",
      "insert_method",
      "delete_method",
      "anchor_insert",
      "anchor_replace",
      "anchor_delete",
      "prepend",
      "append",
    ])
    .describe("The structured operation to perform."),
  name: z.string().optional().describe("Method name (replace_method/insert_method/delete_method)."),
  className: z.string().optional().describe("Scope the method/insertion to this class/struct/interface."),
  index: z.number().int().optional().describe("1-based pick among overloads when a name is ambiguous."),
  position: z.string().optional().describe("insert_method: 'end_of_class' (default) | 'after' | 'before'. anchor_insert: 'after' (default) | 'before'."),
  anchor: z.string().optional().describe("Regex (anchor_* ops) locating where to insert/replace/delete."),
  ignoreCase: z.boolean().optional().describe("Case-insensitive anchor match."),
  newText: z.string().optional().describe("Code to insert or replace with (not needed for delete ops)."),
});

const ScriptEditShape = {
  path: z.string().describe("File to edit, under Assets/."),
  edits: z.array(StructuredEditSchema).describe("Structured ops applied in order; the file is re-scanned after each."),
  preconditionSha256: z.string().optional().describe("Only apply when the file's current sha256 matches."),
  preview: z.boolean().optional().describe("Return a unified diff without writing."),
};

export const unityScriptEdit: ToolDef<typeof ScriptEditShape, ScriptEditResult> = {
  name: "unity_script_edit",
  description:
    "Structured C# editing: replace/insert/delete a whole method by name, or insert/replace/delete at a regex anchor, plus prepend/append. Brace matching ignores braces inside strings & comments. Use this for 'rewrite this method' / 'add a method to this class' without computing exact offsets; fall back to unity_apply_text_edits when you need byte precision. Gated by safetyMode (confirm/autopilot + allowScriptWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "script",
  inputShape: ScriptEditShape,
  async run(args, ctx) {
    return bridgeCall<ScriptEditResult>(ctx.bridge, BRIDGE_METHODS.scriptApplyStructuredEdits, {
      path: args.path,
      edits: args.edits,
      preconditionSha256: args.preconditionSha256,
      preview: args.preview ?? false,
    });
  },
};
