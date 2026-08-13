import { promises as fs } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureBrainCurrent } from "@gvibe/project-brain";
import { readActions, resolveProjectPath } from "@gvibe/safety";
import type { ToolContext } from "./registry.js";

export interface ResourceContents { contents: Array<{ uri: string; mimeType?: string; text: string }>; [key: string]: unknown }
async function textFile(ctx: ToolContext, relative: string, uri: string, mimeType: string): Promise<ResourceContents> { try { const file = await resolveProjectPath(ctx.projectPath, relative); return { contents: [{ uri, mimeType, text: await fs.readFile(file.absolute, "utf8") }] }; } catch { return { contents: [{ uri, mimeType: "text/plain", text: `(${relative} not found)` }] }; } }
export async function readActionLogResource(ctx: ToolContext, uri = "godot://action-log"): Promise<ResourceContents> { const entries = await readActions(ctx.projectPath, 50); return { contents: [{ uri, mimeType: "application/x-ndjson", text: entries.length ? entries.map((entry) => JSON.stringify(entry)).join("\n") : "(no actions logged yet)" }] }; }
export async function readProjectBrainResource(ctx: ToolContext, uri = "godot://project-brain"): Promise<ResourceContents> { try { await ensureBrainCurrent(ctx.projectPath); } catch (error) { return { contents: [{ uri, mimeType: "text/plain", text: `(project map refresh failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error)})` }] }; } return textFile(ctx, ".godot-vibe/brain/index.md", uri, "text/markdown"); }
export async function readConventionsResource(ctx: ToolContext, uri = "godot://conventions"): Promise<ResourceContents> { return textFile(ctx, ".godot-vibe/conventions.md", uri, "text/markdown"); }
export async function readSceneTreeResource(ctx: ToolContext, uri = "godot://scene-tree"): Promise<ResourceContents> { const result = await ctx.bridge.call("scene.getTree", { maxDepth: 32, maxNodes: 2_000, includeProperties: false }); return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result.ok ? result.result : { error: result.error }, null, 2) }] }; }
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource("project-brain", "godot://project-brain", { title: "Godot project map", description: "Source-backed map of settings, addons, scenes, resources, scripts, classes, shaders, and relationships.", mimeType: "text/markdown" }, (uri) => readProjectBrainResource(ctx, uri.href));
  server.registerResource("conventions", "godot://conventions", { title: "Project conventions", description: "Team-specific project guidance.", mimeType: "text/markdown" }, (uri) => readConventionsResource(ctx, uri.href));
  server.registerResource("action-log", "godot://action-log", { title: "Godot Vibe action log", description: "Last 50 MCP write operations.", mimeType: "application/x-ndjson" }, (uri) => readActionLogResource(ctx, uri.href));
  server.registerResource("scene-tree", "godot://scene-tree", { title: "Edited scene tree", description: "Live bounded Node tree for the edited scene.", mimeType: "application/json" }, (uri) => readSceneTreeResource(ctx, uri.href));
}
