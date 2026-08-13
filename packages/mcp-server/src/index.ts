import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, ZodRawShape } from "zod";
import { PRODUCT_VERSION, ToolEnvelope, err } from "@uvibe/core";
import { BridgeClient, createHttpBridgeClient, HttpBridgeOptions, timeoutForMethod } from "@uvibe/bridge-client";
import { ensureBrainCurrent, readKnowledgeBase, type KnowledgeBase } from "@uvibe/project-brain";
import { createMockBridgeClient } from "./mockBridge.js";
import { allTools } from "./tools/index.js";
import { AnyToolDef, ToolContext } from "./registry.js";
import { executeTool } from "./execute.js";
import { ToolGroupController, defaultActiveGroups } from "./groups.js";
import { toolAnnotations } from "./annotations.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * If the envelope carries a base64 PNG (screenshot tools), surface it as a multimodal
 * `image` content block so Claude can SEE it. The text envelope replaces the bulky base64
 * with a placeholder so the JSON view stays readable.
 */
function shapeContent(env: ToolEnvelope<unknown>): McpContent[] {
  const content: McpContent[] = [];
  let textEnv: unknown = env;
  if (env.ok && typeof env.data === "object" && env.data !== null) {
    const data = env.data as { pngBase64?: unknown; mimeType?: unknown };
    if (typeof data.pngBase64 === "string" && data.pngBase64.length > 0) {
      const mime = typeof data.mimeType === "string" ? data.mimeType : "image/png";
      content.push({ type: "image", data: data.pngBase64, mimeType: mime });
      const placeholder = `<base64 ${mime}, ${data.pngBase64.length} chars>`;
      textEnv = {
        ...env,
        data: { ...(data as object), pngBase64: placeholder },
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
  const projectPath = opts.projectPath ?? process.env.UVIBE_PROJECT ?? process.cwd();
  const bridge =
    opts.bridgeOverride ??
    (opts.mock || process.env.UVIBE_MOCK === "1"
      ? createMockBridgeClient()
      : createHttpBridgeClient({ projectPath, ...(opts.bridge ?? {}) }));
  return {
    bridge,
    projectPath,
    configMockMode: opts.mock === true || process.env.UVIBE_MOCK === "1",
    tools: allTools,
  };
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: "unity-vibe-os",
      version: PRODUCT_VERSION,
    },
    {
      // Delivered to Claude Code on connect — teaches the toolset + workflows in the user's project.
      instructions: ctx.projectKnowledgePrimer
        ? `${SERVER_INSTRUCTIONS}\n\n${ctx.projectKnowledgePrimer}`
        : SERVER_INSTRUCTIONS,
    }
  );

  // Tool-group controller: registers each tool's handle and disables the ones whose group is not
  // active at startup (e.g. codegen). unity_manage_tools drives it live via the context.
  const controller = ctx.toolGroups ?? new ToolGroupController(defaultActiveGroups());
  ctx.toolGroups = controller;

  for (const tool of allTools) {
    const registered = server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: toolAnnotations(tool),
      },
      async (rawArgs: unknown) => {
        try {
          const parsed = z.object(tool.inputShape).parse(rawArgs ?? {});
          const env = await executeTool(tool, parsed, ctx);
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

  // Claude Code surfaces these as /mcp__unity-vibe-os__<name> slash commands.
  registerPrompts(server);
  // Claude Code lets the user @-mention these unity:// resources.
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
    `Project: ${manifest.project.name}. Coverage: ${coverage}. First-party scripts: ${manifest.coverage.counts.firstPartyScripts}.`,
    modules.length ? `Modules: ${modules.join(", ")}.` : "Modules: none detected.",
    "Use unity_query_project_brain for source-backed details; do not infer facts from this compact primer.",
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
export { toolAnnotations, type ToolAnnotations } from "./annotations.js";
export { UNITY_PROMPTS, registerPrompts } from "./prompts.js";
export {
  registerResources,
  readSceneHierarchyResource,
  readConsoleResource,
  readActionLogResource,
  readProjectBrainResource,
} from "./resources.js";
export { SERVER_INSTRUCTIONS } from "./instructions.js";
