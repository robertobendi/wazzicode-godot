import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHttpBridgeClient, timeoutForMethod } from "@uvibe/mcp-server";
import { BRIDGE_DISCOVERY_REL } from "@uvibe/core";

function makeProject(disco: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), "uvibe-"));
  const file = path.join(root, BRIDGE_DISCOVERY_REL);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(disco), "utf8");
  return root;
}

describe("reliability/bridge discovery + reload survival", () => {
  let projectKnown: string;
  let projectUnknown: string;

  beforeAll(() => {
    // Discovery file present but pointing at a dead port → bridge "known" but socket down.
    projectKnown = makeProject({
      port: 1,
      host: "127.0.0.1",
      projectPath: "/whatever",
      pid: process.pid,
    });
    // No discovery file at all.
    projectUnknown = mkdtempSync(path.join(tmpdir(), "uvibe-none-"));
  });

  afterAll(() => {
    rmSync(projectKnown, { recursive: true, force: true });
    rmSync(projectUnknown, { recursive: true, force: true });
  });

  it("treats connection-refused as UNITY_RELOADING when a discovery file exists", async () => {
    const client = createHttpBridgeClient({ projectPath: projectKnown, timeoutMs: 800 });
    const res = await client.call("system.health");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(["UNITY_RELOADING", "BRIDGE_TIMEOUT"]).toContain(res.error.code);
    }
  });

  it("reports UNITY_NOT_CONNECTED when no bridge was ever discovered", async () => {
    const client = createHttpBridgeClient({ projectPath: projectUnknown, port: 1, timeoutMs: 800 });
    const res = await client.call("system.health");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(["UNITY_NOT_CONNECTED", "BRIDGE_TIMEOUT"]).toContain(res.error.code);
    }
  });
});

describe("reliability/per-method timeouts", () => {
  it("gives slow methods a budget that exceeds the Unity-side main-thread budget", () => {
    // Asset-graph scans get 120s on the Unity side; the client must wait longer, not abort at 5s.
    expect(timeoutForMethod("asset.findReferences")).toBeGreaterThan(120_000);
    expect(timeoutForMethod("asset.findDependencies")).toBeGreaterThan(120_000);
    expect(timeoutForMethod("asset.refresh")).toBeGreaterThan(120_000);
    // Play-mode transitions get 60s on the Unity side.
    expect(timeoutForMethod("playmode.enter")).toBeGreaterThan(60_000);
    // In-Editor code execution can compile.
    expect(timeoutForMethod("code.execute")).toBeGreaterThanOrEqual(60_000);
    // Long-poll awaits hold the request open server-side for up to 25s per round.
    expect(timeoutForMethod("compile.await")).toBeGreaterThan(25_000);
    expect(timeoutForMethod("playmode.await")).toBeGreaterThan(25_000);
    expect(timeoutForMethod("test.await")).toBeGreaterThan(25_000);
    expect(timeoutForMethod("playmode.step")).toBeGreaterThan(25_000);
  });

  it("uses a safe default for ordinary fast reads", () => {
    const fast = timeoutForMethod("scene.getHierarchy");
    expect(fast).toBeGreaterThanOrEqual(15_000);
    expect(fast).toBeLessThan(60_000);
  });
});
