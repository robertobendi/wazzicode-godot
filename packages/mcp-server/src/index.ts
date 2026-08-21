import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, ZodRawShape } from "zod";
import { PRODUCT_VERSION, ToolEnvelope, err } from "@gvibe/core";
import { BridgeClient, createHttpBridgeClient, HttpBridgeOptions, timeoutForMethod } from "@gvibe/bridge-client";
import { ensureBrainCurrent, readKnowledgeBase, type KnowledgeBase } from "@gvibe/project-brain";
import { createMockBridgeClient } from "./mockBridge.js";
import { allTools } from "./tools/index.js";
import { AnyToolDef, ToolContext } from "./registry.js";
import { executeTool } from "./execute.js";
import { ToolGroupController, defaultActiveGroups } from "./groups.js";
import { toolAnnotations, toolMeta } from "./annotations.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { composeInstructions } from "./instructions.js";
import { createProgressReporter } from "./progress.js";
import { createWriteConfirmer } from "./confirm.js";

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ImageFrame {
  index?: unknown;
  label?: unknown;
  base64?: unknown;
  mimeType?: unknown;
}

/**
 * If the envelope carries a base64 PNG (screenshot tools), surface it as a multimodal
 * `image` content block so Claude can SEE it. The text envelope replaces the bulky base64
 * with a placeholder so the JSON view stays readable. A `frames` array (godot_capture_frames)
 * becomes one labelled text block plus one image block per returned frame, in capture order.
 */
function shapeContent(env: ToolEnvelope<unknown>): McpContent[] {
  const content: McpContent[] = [];
  let textEnv: unknown = env;
  if (env.ok && typeof env.data === "object" && env.data !== null) {
    const data = env.data as { pngBase64?: unknown; mimeType?: unknown; frames?: unknown };
    if (typeof data.pngBase64 === "string" && data.pngBase64.length > 0) {
      const mime = typeof data.mimeType === "string" ? data.mimeType : "image/png";
      content.push({ type: "image", data: data.pngBase64, mimeType: mime });
      const placeholder = `<base64 ${mime}, ${data.pngBase64.length} chars>`;
      textEnv = {
        ...env,
        data: { ...(data as object), pngBase64: placeholder },
      };
    } else if (Array.isArray(data.frames)) {
      const frames = data.frames as ImageFrame[];
      for (const frame of frames) {
        if (typeof frame?.base64 !== "string" || frame.base64.length === 0) continue;
        const mime = typeof frame.mimeType === "string" ? frame.mimeType : "image/jpeg";
        if (typeof frame.label === "string") content.push({ type: "text", text: frame.label });
        content.push({ type: "image", data: frame.base64, mimeType: mime });
      }
      textEnv = {
        ...env,
        data: {
          ...(data as object),
          frames: frames.map((frame) =>
            typeof frame?.base64 === "string"
              ? { ...frame, base64: `<base64 ${String(frame.mimeType ?? "image/jpeg")}, ${frame.base64.length} chars>` }
              : frame,
          ),
        },
      };
    }
  }
  content.push({ type: "text", text: JSON.stringify(textEnv, null, 2) });
  return content;
}

export interface ServeOptions {
  mock?: boolean;
  projectPath?: string;
  bridge?: HttpBridgeOptions;
  /** If provided, the server uses this bridge instead of creating one. */
  bridgeOverride?: BridgeClient;
}

export function buildContext(opts: ServeOptions = {}): ToolContext {
  const projectPath = opts.projectPath ?? process.env.GVIBE_PROJECT ?? process.cwd();
  const bridge =
    opts.bridgeOverride ??
    (opts.mock || process.env.GVIBE_MOCK === "1"
      ? createMockBridgeClient()
      : createHttpBridgeClient({ projectPath, ...(opts.bridge ?? {}) }));
  return {
    bridge,
    projectPath,
    configMockMode: opts.mock === true || process.env.GVIBE_MOCK === "1",
    tools: allTools,
  };
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: "godot-vibe-os",
      version: PRODUCT_VERSION,
    },
    {
      // Delivered to Claude Code on connect — teaches the toolset + workflows in the user's project.
      instructions: composeInstructions(ctx.projectKnowledgePrimer),
    }
  );

  // Register handles so future clients can expose a smaller group subset if desired.
  const controller = ctx.toolGroups ?? new ToolGroupController(defaultActiveGroups());
  ctx.toolGroups = controller;

  for (const tool of allTools) {
    const meta = toolMeta(tool);
    const registered = server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: toolAnnotations(tool),
        ...(meta ? { _meta: meta } : {}),
      },
      async (rawArgs: unknown, extra) => {
        // Progress and elicitation belong to one in-flight call, so they never live on the
        // shared server context.
        const callCtx: ToolContext = {
          ...ctx,
          progress: createProgressReporter(extra),
          confirmWrite: createWriteConfirmer(server.server, extra),
        };
        try {
          const parsed = z.object(tool.inputShape).parse(rawArgs ?? {});
          const env = await executeTool(tool, parsed, callCtx);
          return {
            content: shapeContent(env),
            isError: env.ok ? false : true,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const env = err("INVALID_ARGUMENT", `Tool ${tool.name} input invalid or threw: ${msg}`, {
            source: ctx.bridge.source,
          });
          return {
            content: shapeContent(env),
            isError: true,
          };
        }
      }
    );
    controller.register(tool.name, registered);
  }

  // MCP clients surface these as /mcp__godot-vibe-os__<name> slash commands.
  registerPrompts(server);
  // Clients can @-mention godot:// resources.
  registerResources(server, ctx);

  return server;
}

export async function startMcpServer(opts: ServeOptions = {}): Promise<void> {
  const ctx = buildContext(opts);
  try {
    await ensureBrainCurrent(ctx.projectPath);
    const knowledge = await readKnowledgeBase(ctx.projectPath);
    if (knowledge) ctx.projectKnowledgePrimer = renderKnowledgePrimer(knowledge);
  } catch {
    // Orientation/query tools surface knowledge errors without preventing MCP startup.
  }
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function renderKnowledgePrimer(knowledge: KnowledgeBase): string {
  const { manifest, entities } = knowledge;
  const modules = entities
    .filter((entity) => entity.kind === "module" && entity.scope === "first-party")
    .map((entity) => entity.name)
    .slice(0, 12);
  const coverage = manifest.coverage.complete
    ? "complete"
    : `partial (${manifest.coverage.scanned}/${manifest.coverage.discovered} files)`;
  return [
    "CURRENT PROJECT MAP (generated, bounded primer)",
    `Project: ${manifest.project.name}. Coverage: ${coverage}. Project scripts: ${manifest.coverage.counts.firstPartyScripts}.`,
    modules.length ? `Modules: ${modules.join(", ")}.` : "Modules: none detected.",
    "Use godot_query_project_brain for source-backed details; do not infer facts from this compact primer.",
  ].join("\n");
}

export {
  createHttpBridgeClient,
  createMockBridgeClient,
  timeoutForMethod,
  type BridgeClient,
  type HttpBridgeOptions,
};
export { allTools } from "./tools/index.js";
export type { ToolContext, ToolDef } from "./registry.js";
export { ToolGroupController, defaultActiveGroups, groupOf, isKnownGroup, TOOL_GROUPS } from "./groups.js";
export { toolAnnotations, toolMeta, LARGE_RESULT_TOOLS, type ToolAnnotations } from "./annotations.js";
export { GODOT_PROMPTS, registerPrompts } from "./prompts.js";
export {
  registerResources,
  readSceneTreeResource,
  readActionLogResource,
  readConventionsResource,
  readProjectBrainResource,
} from "./resources.js";
export { SERVER_INSTRUCTIONS, MAX_INSTRUCTION_BYTES, composeInstructions } from "./instructions.js";
export { createProgressReporter, reportProgress } from "./progress.js";
export { createWriteConfirmer } from "./confirm.js";
export { resolveGodotBinary } from "./godotBinary.js";
