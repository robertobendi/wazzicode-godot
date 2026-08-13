import { z, ZodRawShape } from "zod";
import { ToolEnvelope, WriteTarget } from "@uvibe/core";
import { BridgeClient } from "@uvibe/bridge-client";
import type { ToolGroupController } from "./groups.js";

export type { WriteTarget };

export interface ToolContext {
  bridge: BridgeClient;
  projectPath: string;
  configMockMode: boolean;
  /** The full tool registry, so composite tools (e.g. unity_batch) can resolve tools by name. */
  tools?: AnyToolDef[];
  /** Live tool-group toggle controller; set by createServer (absent in direct/test contexts). */
  toolGroups?: ToolGroupController;
  /** Compact generated project-map context appended to the MCP server primer. */
  projectKnowledgePrimer?: string;
}

export interface ToolDef<TShape extends ZodRawShape = ZodRawShape, TOutput = unknown> {
  name: string;
  description: string;
  inputShape: TShape;
  /** Stable hint of what this tool needs. Used by docs and `uvibe doctor`. */
  requires: Array<"unity_bridge" | "filesystem" | "git" | "project_brain">;
  /** Mutates project state. The server gates these behind safetyMode and logs them. */
  write?: boolean;
  /** What kind of state a write tool touches; drives per-target safety flags. */
  writeTarget?: WriteTarget;
  run: (
    args: z.infer<z.ZodObject<TShape>>,
    ctx: ToolContext
  ) => Promise<ToolEnvelope<TOutput>>;
}

/** What a tool declares it needs to run. Used by docs and `uvibe doctor`. */
export type ToolRequirement = "unity_bridge" | "filesystem" | "git" | "project_brain";

/**
 * Registry-side view of a tool with its generics erased. `ToolDef<Shape, Out>` is NOT
 * assignable to `ToolDef<ZodRawShape, unknown>` under strictFunctionTypes (a required-prop
 * args object rejects the index-signature type in the contravariant `run` slot), which is
 * why the registry used to double-cast every tool. `args: never` is the variance-safe
 * bottom type for "the registry never fabricates args itself": every concrete ToolDef
 * assigns cleanly, and the two execution call sites in execute.ts pass `args as never`
 * after zod-parsing against the tool's own inputShape.
 */
export interface AnyToolDef {
  name: string;
  description: string;
  inputShape: ZodRawShape;
  requires: ToolRequirement[];
  write?: boolean;
  writeTarget?: WriteTarget;
  run: (args: never, ctx: ToolContext) => Promise<ToolEnvelope<unknown>>;
}
