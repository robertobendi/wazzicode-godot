import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_METHODS } from "@gvibe/core";
import {
  MAX_INSTRUCTION_BYTES,
  SERVER_INSTRUCTIONS,
  allTools,
  buildContext,
  composeInstructions,
  createServer,
} from "@gvibe/mcp-server";
import { GVibeConfigSchema, readActions, writeConfig } from "@gvibe/safety";

const PROTOCOL_VERSION = "2025-06-18";
const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gvibe-protocol-test-"));
  temporaryProjects.push(root);
  return root;
}

interface JsonRpcMessage { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

/**
 * A minimal JSON-RPC peer wired straight into the real McpServer, so these assertions exercise
 * the wire messages a client actually sees rather than internal helpers.
 */
class TestClient {
  private nextId = 1;
  private pending = new Map<number | string, (message: JsonRpcMessage) => void>();
  readonly notifications: JsonRpcMessage[] = [];
  readonly serverRequests: JsonRpcMessage[] = [];
  /** Answers a server->client request; return null to leave it unanswered. */
  onServerRequest: (message: JsonRpcMessage) => Record<string, unknown> | null = () => null;
  private send!: (message: JsonRpcMessage) => void;

  transport(): {
    start(): Promise<void>;
    close(): Promise<void>;
    send(message: JsonRpcMessage): Promise<void>;
    onmessage?: (message: JsonRpcMessage) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
  } {
    const client = this;
    const transport = {
      async start() {},
      async close() { transport.onclose?.(); },
      async send(message: JsonRpcMessage) { client.receive(message); },
      onmessage: undefined as ((message: JsonRpcMessage) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
    };
    this.send = (message) => transport.onmessage?.(message);
    return transport;
  }

  private receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method !== undefined) {
      this.serverRequests.push(message);
      const result = this.onServerRequest(message);
      if (result) this.send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (message.method !== undefined) {
      this.notifications.push(message);
      return;
    }
    const resolve = message.id === undefined ? undefined : this.pending.get(message.id);
    if (resolve && message.id !== undefined) {
      this.pending.delete(message.id);
      resolve(message);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }
}

async function connect(options: { projectPath: string; elicitation?: boolean; projectKnowledgePrimer?: string }) {
  const ctx = buildContext({ mock: true, projectPath: options.projectPath });
  if (options.projectKnowledgePrimer) ctx.projectKnowledgePrimer = options.projectKnowledgePrimer;
  const server = createServer(ctx);
  const client = new TestClient();
  await server.connect(client.transport() as never);
  const initialize = await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: options.elicitation ? { elicitation: {} } : {},
    clientInfo: { name: "gvibe-protocol-test", version: "0.0.0" },
  });
  client.notify("notifications/initialized");
  return { ctx, server, client, initialize };
}

describe("MCP server instructions", () => {
  it("fits the 2KB instruction budget with and without a project map", async () => {
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(MAX_INSTRUCTION_BYTES);
    const primer = [
      "CURRENT PROJECT MAP (generated, bounded primer)",
      `Project: ${"Long".repeat(120)}.`,
      `Modules: ${Array.from({ length: 60 }, (_, index) => `module_${index}`).join(", ")}.`,
      "Use godot_query_project_brain for source-backed details; do not infer facts from this compact primer.",
    ].join("\n");
    const composed = composeInstructions(primer);
    expect(Buffer.byteLength(composed, "utf8")).toBeLessThanOrEqual(MAX_INSTRUCTION_BYTES);
    expect(composed.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
  });

  it("delivers instructions under the budget over the real handshake", async () => {
    const { initialize } = await connect({
      projectPath: await project(),
      projectKnowledgePrimer: "CURRENT PROJECT MAP (generated, bounded primer)\nProject: Mock. Coverage: complete.",
    });
    const result = initialize.result as { instructions: string };
    expect(Buffer.byteLength(result.instructions, "utf8")).toBeLessThanOrEqual(MAX_INSTRUCTION_BYTES);
    expect(result.instructions).toContain("godot_orient");
    expect(result.instructions).toContain("CURRENT PROJECT MAP");
  });
});

describe("tools/list", () => {
  it("lists tools in a stable registry order on every call", async () => {
    const { client } = await connect({ projectPath: await project() });
    const first = (await client.request("tools/list")).result as { tools: Array<{ name: string }> };
    const second = (await client.request("tools/list")).result as { tools: Array<{ name: string }> };
    const expected = allTools.map((tool) => tool.name);

    expect(first.tools.map((tool) => tool.name)).toEqual(expected);
    expect(second.tools.map((tool) => tool.name)).toEqual(expected);
  });

  it("publishes a larger result budget only for the tools that need one", async () => {
    const { client } = await connect({ projectPath: await project() });
    const listed = (await client.request("tools/list")).result as {
      tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
    };
    const withBudget = listed.tools
      .filter((tool) => tool._meta?.["anthropic/maxResultSizeChars"] !== undefined)
      .map((tool) => tool.name);

    expect(withBudget).toEqual([
      "godot_query_project_brain",
      "godot_get_scene_tree",
      "godot_reflect",
      "godot_debug_run",
      "godot_capture_frames",
    ]);
    for (const name of withBudget) {
      expect(listed.tools.find((tool) => tool.name === name)?._meta).toEqual({ "anthropic/maxResultSizeChars": 200_000 });
    }
    expect(listed.tools.find((tool) => tool.name === "godot_get_play_status")?._meta).toBeUndefined();
  });
});

describe("tools/call progress", () => {
  it("streams progress notifications only when the client sends a progressToken", async () => {
    const { ctx, client } = await connect({ projectPath: await project() });
    await ctx.bridge.call(BRIDGE_METHODS.playRun, { mode: "main" });

    await client.request("tools/call", {
      name: "godot_capture_frames",
      arguments: { frames: 4, returnImages: "none", save: false },
    });
    expect(client.notifications.filter((message) => message.method === "notifications/progress")).toEqual([]);

    await client.request("tools/call", {
      name: "godot_capture_frames",
      arguments: { frames: 4, returnImages: "none", save: false },
      _meta: { progressToken: "frames-token" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const progress = client.notifications.filter((message) => message.method === "notifications/progress");
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((message) => message.params?.progressToken === "frames-token")).toBe(true);
    expect(progress.at(-1)?.params).toMatchObject({ progress: 4, total: 4, message: "Captured frame 4/4" });
  });
});

describe("tools/call content", () => {
  it("interleaves one label and one image per returned frame, then the JSON envelope", async () => {
    const { ctx, client } = await connect({ projectPath: await project() });
    await ctx.bridge.call(BRIDGE_METHODS.playRun, { mode: "main" });

    const called = await client.request("tools/call", {
      name: "godot_capture_frames",
      arguments: { frames: 4, returnImages: "changed", save: false },
    });
    const result = called.result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError: boolean };

    expect(result.isError).toBe(false);
    expect(result.content.map((block) => block.type)).toEqual(["text", "image", "text", "image", "text"]);
    expect(result.content[0].text).toBe("Frame 1/4 — t=+0ms");
    expect(result.content[2].text).toBe("Frame 3/4 — t=+800ms");
    expect(result.content[1].mimeType).toBe("image/png");
    const envelope = JSON.parse(result.content[4].text ?? "{}") as { data: { dedup: unknown; frames: Array<{ base64?: string }> } };
    expect(envelope.data.dedup).toEqual({ captured: 4, returned: 2, skippedUnchanged: 2 });
    // The bulky base64 never appears twice: the JSON view keeps only a placeholder.
    expect(envelope.data.frames.filter((frame) => frame.base64).map((frame) => frame.base64)).toEqual([
      expect.stringMatching(/^<base64 image\/png, \d+ chars>$/),
      expect.stringMatching(/^<base64 image\/png, \d+ chars>$/),
    ]);
  });
});

describe("confirm-mode elicitation", () => {
  it("runs a blocked write after the project owner accepts the elicitation", async () => {
    const root = await project();
    await writeConfig(root, GVibeConfigSchema.parse({ safetyMode: "confirm" }));
    const { client } = await connect({ projectPath: root, elicitation: true });
    client.onServerRequest = () => ({ action: "accept", content: {} });

    const called = await client.request("tools/call", {
      name: "godot_open_scene",
      arguments: { path: "res://scenes/main.tscn" },
    });
    const result = called.result as { isError: boolean; content: Array<{ text?: string }> };

    expect(result.isError).toBe(false);
    expect(client.serverRequests.map((message) => message.method)).toEqual(["elicitation/create"]);
    expect(client.serverRequests[0].params?.message).toContain("godot_open_scene");
    expect(await readActions(root)).toEqual([
      expect.objectContaining({ tool: "godot_open_scene", result: "ok", notes: "Approved interactively in confirm mode." }),
    ]);
  });

  it("keeps the refusal when the owner declines", async () => {
    const root = await project();
    await writeConfig(root, GVibeConfigSchema.parse({ safetyMode: "confirm" }));
    const { client } = await connect({ projectPath: root, elicitation: true });
    client.onServerRequest = () => ({ action: "decline" });

    const called = await client.request("tools/call", {
      name: "godot_open_scene",
      arguments: { path: "res://scenes/main.tscn" },
    });
    const result = called.result as { isError: boolean; content: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SAFETY_MODE_BLOCKED");
    expect(await readActions(root)).toEqual([
      expect.objectContaining({ tool: "godot_open_scene", result: "blocked", errorCode: "SAFETY_MODE_BLOCKED" }),
    ]);
  });

  it("never asks a client that cannot elicit, and keeps the existing refusal", async () => {
    const root = await project();
    await writeConfig(root, GVibeConfigSchema.parse({ safetyMode: "confirm" }));
    const { client } = await connect({ projectPath: root, elicitation: false });

    const called = await client.request("tools/call", {
      name: "godot_open_scene",
      arguments: { path: "res://scenes/main.tscn" },
    });
    const result = called.result as { isError: boolean; content: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SAFETY_MODE_BLOCKED");
    expect(client.serverRequests).toEqual([]);
  });

  it("does not offer an elicitation escape from read-only mode", async () => {
    const root = await project();
    await writeConfig(root, GVibeConfigSchema.parse({ safetyMode: "read_only" }));
    const { client } = await connect({ projectPath: root, elicitation: true });
    client.onServerRequest = () => ({ action: "accept", content: {} });

    const called = await client.request("tools/call", {
      name: "godot_open_scene",
      arguments: { path: "res://scenes/main.tscn" },
    });
    const result = called.result as { isError: boolean; content: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SAFETY_MODE_BLOCKED");
    expect(client.serverRequests).toEqual([]);
  });
});
