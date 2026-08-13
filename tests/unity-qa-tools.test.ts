import { describe, expect, it } from "vitest";
import type { BridgeClient } from "@uvibe/bridge-client";
import type { BridgeMethod, BridgeResponse } from "@uvibe/core";
import { unityQa } from "../packages/mcp-server/src/tools/unityQa.js";
import { unitySmokeTest } from "../packages/mcp-server/src/tools/unitySmokeTest.js";

const meta = {
  unityVersion: "6000.3.8f1",
  projectPath: "/mock/project",
  durationMs: 1,
};

function bridgeWith(
  handler: (method: BridgeMethod, params: Record<string, unknown>) => unknown
): { bridge: BridgeClient; calls: BridgeMethod[] } {
  const calls: BridgeMethod[] = [];
  return {
    calls,
    bridge: {
      source: "mock",
      async call<T>(method: BridgeMethod, params: Record<string, unknown> = {}): Promise<BridgeResponse<T>> {
        calls.push(method);
        return {
          id: "qa-test",
          ok: true,
          result: handler(method, params) as T,
          error: null,
          meta,
        };
      },
      async isConnected() {
        return true;
      },
    },
  };
}

function performanceSample() {
  return {
    isPlaying: true,
    warmingUp: false,
    estimatedFps: 120,
    mainThreadMs: 8.3,
    counters: [
      {
        name: "GC Allocated In Frame",
        category: "Memory",
        average: 128,
        unit: "bytes",
        sampleCount: 30,
      },
    ],
  };
}

describe("unity_smoke_test", () => {
  it("reports runtime errors, strips image bytes, and restores edit mode", async () => {
    let playing = false;
    const { bridge, calls } = bridgeWith((method) => {
      if (method === "playmode.status") {
        return { isPlaying: playing, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "playmode.enter") {
        playing = true;
        return { isPlaying: true, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "console.getLogs") {
        return {
          logs: [{ type: "Exception", message: "Boom", stackTrace: "at Game.Update()", timestamp: Date.now() }],
          truncated: false,
          bufferSize: 1,
        };
      }
      if (method === "perf.sample") return performanceSample();
      if (method === "screenshot.gameView") {
        return {
          source: "game_view",
          width: 640,
          height: 360,
          mimeType: "image/jpeg",
          pngBase64: "aW1hZ2U=",
          cameraName: "Main Camera",
        };
      }
      if (method === "playmode.exit") {
        playing = false;
        return { isPlaying: false, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const env = await unitySmokeTest.run(
      { settleMs: 0, saveScreenshot: false },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.pass).toBe(false);
    expect(env.data.enteredPlayMode).toBe(true);
    expect(env.data.restoredPlayState).toBe(true);
    expect(env.data.reasons.join(" ")).toContain("runtime error");
    expect(env.data.screenshot).toMatchObject({ width: 640, height: 360, mimeType: "image/jpeg" });
    expect(env.data.screenshot).not.toHaveProperty("pngBase64");
    expect(calls).toContain("playmode.exit");
    expect(calls.indexOf("perf.sample")).toBeLessThan(calls.indexOf("screenshot.gameView"));
    expect(calls.indexOf("screenshot.gameView")).toBeLessThan(calls.indexOf("console.getLogs"));
    expect(calls.lastIndexOf("console.getLogs")).toBeGreaterThan(calls.indexOf("playmode.exit"));
    expect(playing).toBe(false);
  });

  it("preserves a play-mode session that was already running", async () => {
    const { bridge, calls } = bridgeWith((method) => {
      if (method === "playmode.status") {
        return { isPlaying: true, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "console.getLogs") return { logs: [], truncated: false, bufferSize: 0 };
      if (method === "perf.sample") return performanceSample();
      throw new Error(`Unexpected method ${method}`);
    });

    const env = await unitySmokeTest.run(
      { settleMs: 0, captureGameView: false, minFps: 60 },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.pass).toBe(true);
    expect(env.data.enteredPlayMode).toBe(false);
    expect(env.data.restoredPlayState).toBe(true);
    expect(calls).not.toContain("playmode.enter");
    expect(calls).not.toContain("playmode.exit");
  });

  it.each([
    { state: "paused", isPaused: true, timeScale: 1 },
    { state: "zero-time-scale", isPaused: false, timeScale: 0 },
  ])("leaves an existing $state session untouched and fails closed", async ({ isPaused, timeScale }) => {
    const { bridge, calls } = bridgeWith((method) => {
      if (method === "playmode.status") {
        return { isPlaying: true, isPaused, isTransitioning: false, timeScale };
      }
      if (method === "console.getLogs") return { logs: [], truncated: false, bufferSize: 0 };
      throw new Error(`Unexpected method ${method}`);
    });

    const env = await unitySmokeTest.run(
      { settleMs: 0, captureGameView: false },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.pass).toBe(false);
    expect(env.data.restoredPlayState).toBe(true);
    expect(env.data.checks.find((check) => check.name === "play_mode_observable")).toMatchObject({
      pass: false,
    });
    expect(env.data.checks.find((check) => check.name === "runtime_observations")).toMatchObject({
      pass: false,
      skipped: true,
    });
    expect(env.data.reasons.join(" ")).toContain("irreversibly advance game state");
    expect(calls).not.toContain("playmode.configure");
    expect(calls).not.toContain("perf.sample");
    expect(calls).not.toContain("screenshot.gameView");
  });

  it("fails closed when the runtime console result is truncated", async () => {
    const { bridge } = bridgeWith((method) => {
      if (method === "playmode.status") {
        return { isPlaying: true, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "perf.sample") return performanceSample();
      if (method === "console.getLogs") {
        return { logs: [], truncated: true, bufferSize: 2000 };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const env = await unitySmokeTest.run(
      { settleMs: 0, captureGameView: false },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.pass).toBe(false);
    expect(env.data.checks.find((check) => check.name === "console_errors")).toMatchObject({
      pass: false,
    });
    expect(env.data.reasons.join(" ")).toContain("truncated");
  });

  it("detects errors emitted only while exiting play mode", async () => {
    let playing = false;
    let exited = false;
    const { bridge } = bridgeWith((method) => {
      if (method === "playmode.status") {
        return { isPlaying: playing, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "playmode.enter") {
        playing = true;
        return { isPlaying: true, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "playmode.exit") {
        playing = false;
        exited = true;
        return { isPlaying: false, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "perf.sample") return performanceSample();
      if (method === "console.getLogs") {
        const logs = exited
          ? [{ type: "Exception", message: "OnDestroy failed", timestamp: Date.now() }]
          : [];
        return { logs, truncated: false, bufferSize: logs.length };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const env = await unitySmokeTest.run(
      { settleMs: 0, captureGameView: false },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.pass).toBe(false);
    expect(
      env.data.checks.find((check) => check.name === "post_cleanup_console_errors")
    ).toMatchObject({ pass: false, actual: 1 });
    expect(env.data.console?.logs[0]?.message).toBe("OnDestroy failed");
  });
});

describe("unity_qa", () => {
  it("aggregates asset failures into one truthful verdict", async () => {
    const { bridge } = bridgeWith((method) => {
      if (method === "asset.refresh" || method === "compile.await") {
        return {
          isCompiling: false,
          hasErrors: false,
          errorCount: 0,
          warningCount: 0,
          errors: [],
          settled: true,
        };
      }
      if (method === "console.getLogs") return { logs: [], truncated: false, bufferSize: 0 };
      if (method === "build.getSettings") {
        return {
          valid: true,
          activeBuildTarget: "StandaloneOSX",
          buildTargetGroup: "Standalone",
          targetSupported: true,
          developmentBuild: false,
          enabledSceneCount: 1,
          scenes: [{ path: "Assets/Main.unity", enabled: true, guid: "main", exists: true }],
          issues: [],
        };
      }
      if (method === "asset.findMissingScripts") {
        return {
          scanned: 4,
          hits: [{ assetPath: "Assets/Broken.prefab", objectPath: "/Broken", missingCount: 1 }],
          truncated: false,
        };
      }
      if (method === "asset.findMissingReferences") {
        return { scanned: 4, hits: [], truncated: false };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const env = await unityQa.run(
      { runTests: false, runSmokeTest: false },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.pass).toBe(false);
    expect(env.data.checks.find((check) => check.name === "verify")?.pass).toBe(true);
    expect(env.data.checks.find((check) => check.name === "missing_scripts")?.pass).toBe(false);
    expect(env.data.reasons.join(" ")).toContain("missing scripts");
  });

  it("reports a missing Test Framework as skipped instead of passed", async () => {
    const bridge: BridgeClient = {
      source: "mock",
      async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
        if (method === "test.run") {
          return {
            id: "qa-test",
            ok: false,
            result: null,
            error: {
              code: "TEST_FRAMEWORK_MISSING",
              message: "Install com.unity.test-framework.",
            },
            meta,
          };
        }
        let result: unknown;
        if (method === "asset.refresh" || method === "compile.await") {
          result = {
            isCompiling: false,
            hasErrors: false,
            errorCount: 0,
            warningCount: 0,
            errors: [],
            settled: true,
          };
        } else if (method === "console.getLogs") {
          result = { logs: [], truncated: false, bufferSize: 0 };
        } else if (method === "build.getSettings") {
          result = {
            valid: true,
            activeBuildTarget: "StandaloneOSX",
            buildTargetGroup: "Standalone",
            targetSupported: true,
            developmentBuild: false,
            enabledSceneCount: 1,
            scenes: [{ path: "Assets/Main.unity", enabled: true, guid: "main", exists: true }],
            issues: [],
          };
        } else {
          throw new Error(`Unexpected method ${method}`);
        }
        return { id: "qa-test", ok: true, result: result as T, error: null, meta };
      },
      async isConnected() {
        return true;
      },
    };

    const env = await unityQa.run(
      { checkAssets: false, runSmokeTest: false },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.pass).toBe(true);
    expect(env.data.checks.find((check) => check.name === "tests")).toMatchObject({
      pass: true,
      skipped: true,
    });
    expect(env.data.checks.find((check) => check.name === "verify")?.summary).toContain(
      "tests were skipped"
    );
    expect(env.data.verify?.tests).toMatchObject({
      error: "TEST_FRAMEWORK_MISSING",
      skipped: true,
    });
  });

  it("bounds nested verification, scan, and build details", async () => {
    let consoleReads = 0;
    const testResults = Array.from({ length: 80 }, (_, index) => ({
      name: `Passes_${index}`,
      fullName: `Example.Passes_${index}`,
      status: "Passed",
    }));
    const scriptHits = Array.from({ length: 100 }, (_, index) => ({
      assetPath: `Assets/Prefabs/Broken_${index}.prefab`,
      objectPath: `/Broken_${index}`,
      missingCount: 1,
    }));
    const referenceHits = Array.from({ length: 90 }, (_, index) => ({
      assetPath: `Assets/Prefabs/Broken_${index}.prefab`,
      objectPath: `/Broken_${index}`,
      component: "BrokenComponent",
      field: `reference_${index}`,
    }));
    const buildScenes = Array.from({ length: 100 }, (_, index) => ({
      path: `Assets/Scenes/Scene_${index}.unity`,
      enabled: index === 0,
      guid: `scene-${index}`,
      exists: true,
    }));
    const { bridge } = bridgeWith((method) => {
      if (method === "asset.refresh" || method === "compile.await") {
        return {
          isCompiling: false,
          hasErrors: false,
          errorCount: 0,
          warningCount: 60,
          errors: [],
          settled: true,
        };
      }
      if (method === "console.getLogs") {
        consoleReads += 1;
        return {
          logs:
            consoleReads === 1
              ? Array.from({ length: 60 }, (_, index) => ({
                  type: "Warning",
                  message: `Warning ${index}`,
                  timestamp: index,
                }))
              : [],
          truncated: false,
          bufferSize: 60,
        };
      }
      if (method === "test.run") return { runId: "qa-run", state: "running", mode: "EditMode" };
      if (method === "test.status") {
        return {
          runId: "qa-run",
          state: "completed",
          mode: "EditMode",
          total: testResults.length,
          passed: testResults.length,
          failed: 0,
          skipped: 0,
          results: testResults,
        };
      }
      if (method === "build.getSettings") {
        return {
          valid: true,
          activeBuildTarget: "StandaloneOSX",
          buildTargetGroup: "Standalone",
          targetSupported: true,
          developmentBuild: false,
          enabledSceneCount: 1,
          scenes: buildScenes,
          issues: [],
        };
      }
      if (method === "asset.findMissingScripts") {
        return { scanned: 100, hits: scriptHits, truncated: false };
      }
      if (method === "asset.findMissingReferences") {
        return { scanned: 100, hits: referenceHits, truncated: false };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const env = await unityQa.run(
      { runSmokeTest: false },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.verify).toMatchObject({ problemCount: 60, problemsTruncated: true });
    expect(env.data.verify?.problems).toHaveLength(20);
    const tests = env.data.verify?.tests as { resultCount: number; results: unknown[]; resultsTruncated: boolean };
    expect(tests.resultCount).toBe(80);
    expect(tests.results).toHaveLength(20);
    expect(tests.resultsTruncated).toBe(true);
    expect(env.data.missingScripts).toMatchObject({
      hitCount: 100,
      truncated: false,
      responseTruncated: true,
    });
    expect(env.data.missingScripts?.hits).toHaveLength(25);
    expect(env.data.missingReferences?.hits).toHaveLength(25);
    expect(env.data.buildSettings).toMatchObject({ sceneCount: 100, scenesTruncated: true });
    expect(env.data.buildSettings?.scenes).toHaveLength(50);
  });

  it("bounds runtime logs nested inside the QA smoke-test result", async () => {
    let consoleReads = 0;
    let playing = false;
    const runtimeLogs = Array.from({ length: 75 }, (_, index) => ({
      type: "Exception",
      message: `Runtime failure ${index}`,
      timestamp: Date.now() + index,
    }));
    const { bridge } = bridgeWith((method) => {
      if (method === "asset.refresh" || method === "compile.await") {
        return {
          isCompiling: false,
          hasErrors: false,
          errorCount: 0,
          warningCount: 0,
          errors: [],
          settled: true,
        };
      }
      if (method === "console.getLogs") {
        consoleReads += 1;
        const logs = consoleReads === 1 ? [] : runtimeLogs;
        return { logs, truncated: false, bufferSize: logs.length };
      }
      if (method === "build.getSettings") {
        return {
          valid: true,
          activeBuildTarget: "StandaloneOSX",
          buildTargetGroup: "Standalone",
          targetSupported: true,
          developmentBuild: false,
          enabledSceneCount: 1,
          scenes: [{ path: "Assets/Main.unity", enabled: true, guid: "main", exists: true }],
          issues: [],
        };
      }
      if (method === "playmode.status") {
        return { isPlaying: playing, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "playmode.enter") {
        playing = true;
        return { isPlaying: true, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "playmode.exit") {
        playing = false;
        return { isPlaying: false, isPaused: false, isTransitioning: false, timeScale: 1 };
      }
      if (method === "perf.sample") return performanceSample();
      throw new Error(`Unexpected method ${method}`);
    });

    const env = await unityQa.run(
      {
        runTests: false,
        checkAssets: false,
        smokeSettleMs: 0,
        captureGameView: false,
      },
      { bridge, projectPath: "/mock/project", configMockMode: true }
    );

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.smokeTest?.console).toMatchObject({
      logCount: 75,
      logsTruncated: true,
    });
    expect(env.data.smokeTest?.console?.logs).toHaveLength(20);
  });
});
