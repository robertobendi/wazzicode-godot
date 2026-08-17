import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixture");
const discoveryPath = path.join(fixture, ".godot", "godot-vibe-os", "bridge.json");
const editorLogPath = path.join(fixture, ".godot", "godot-vibe-os-integration.log");
const projectFilePath = path.join(fixture, "project.godot");
const mainScenePath = path.join(fixture, "main.tscn");
const importedMarkerPath = path.join(fixture, "template.tscn.import");
const inheritedScenePath = path.join(fixture, ".godot", "godot-vibe-os", "integration-inherited.tscn");
const captureSymlinkPath = path.join(fixture, ".godot", "godot-vibe-os", "captures", "integration-symlink.png");
const addonSource = path.join(here, "../../godot/addons/godot_vibe_os");
const originalProjectFile = readFileSync(projectFilePath);
const originalMainScene = readFileSync(mainScenePath);
const godot = process.env.GODOT_BIN
  ?? (existsSync("/opt/homebrew/bin/godot") ? "/opt/homebrew/bin/godot" : "godot");

let editor;
let editorOutput = "";
let discovery;
let portBlocker;
let blockedPort;
let captureOutsideDirectory = "";
let captureSymlinkCreated = false;
let frameEvidence = "no frame evidence";
const capturePaths = [];

try {
  rejectRunningFixtureEditor();
  const bufferTest = spawnSync(godot, ["--headless", "--editor", "--path", fixture, "--script", "res://debug_buffer_test.gd", "--no-header"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(bufferTest.status, 0, `debug buffer accounting failed:\n${bufferTest.stdout ?? ""}${bufferTest.stderr ?? ""}`);
  if (existsSync(discoveryPath)) unlinkSync(discoveryPath);
  if (existsSync(editorLogPath)) unlinkSync(editorLogPath);
  ({ server: portBlocker, port: blockedPort } = await blockPreferredPort());

  editor = spawn(godot, [
    "--headless",
    "--editor",
    "--path", fixture,
    "--no-header",
    "--log-file", editorLogPath,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GODOT_VIBE_OS_PORT: String(blockedPort) },
  });
  editor.stdout.on("data", (chunk) => { editorOutput += chunk; });
  editor.stderr.on("data", (chunk) => { editorOutput += chunk; });

  discovery = await waitForDiscovery(editor, 20_000);
  assert.equal(discovery.host, "127.0.0.1");
  assert.ok(discovery.port > blockedPort && discovery.port < blockedPort + 32, "bridge must fall back when its preferred port is occupied");
  assert.equal(discovery.projectPath, fixture);
  assert.equal(discovery.protocolVersion, "1.1");
  assert.equal(typeof discovery.token, "string");
  assert.ok(discovery.token.length >= 24);
  if (process.platform !== "win32") {
    assert.equal(statSync(discoveryPath).mode & 0o777, 0o600, "bridge discovery must be readable only by its owner");
  }
  assert.deepEqual(readdirSync(path.dirname(discoveryPath)).filter((name) => name.startsWith(".bridge-")), [], "discovery publication must not leave temporary files");

  const unauthorized = await request("GET", "/health", undefined, "");
  assert.equal(unauthorized.status, 401);

  const health = await request("GET", "/health", undefined, discovery.token);
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal(health.body.projectPath, fixture);

  const rpc = async (method, params = {}) => {
    const response = await request("POST", "/rpc", {
      id: `integration-${method}-${Date.now()}`,
      version: "1.1",
      method,
      params,
    }, discovery.token);
    assert.equal(response.status, 200, `${method}: HTTP ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.ok, true, `${method}: ${JSON.stringify(response.body.error)}`);
    assert.equal(response.body.meta.projectPath, fixture);
    assert.equal(typeof response.body.meta.godotVersion, "string");
    return response.body.result;
  };

  const rpcError = async (method, params, code) => {
    const response = await request("POST", "/rpc", {
      id: `integration-error-${Date.now()}`,
      version: "1.1",
      method,
      params,
    }, discovery.token);
    assert.equal(response.status, 400);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, code);
  };

  const systemHealth = await rpc("system.health");
  assert.equal(systemHealth.status, "ok");
  const summary = await rpc("system.summary");
  assert.equal(summary.engine, "godot");
  assert.equal(summary.projectName, "Godot Vibe OS Integration Fixture");

  const opened = await rpc("scene.open", { path: "res://main.tscn" });
  assert.equal(opened.opened, true);
  const openScenes = await rpc("scene.getOpenScenes");
  assert.ok(openScenes.scenes.some((scene) => scene.path === "res://main.tscn" && scene.active));

  const inherited = await rpc("scene.open", { path: "res://template.tscn", inherited: true });
  assert.equal(inherited.opened, true);
  const inheritedTree = await rpc("scene.getTree");
  assert.equal(inheritedTree.scenePath, "");
  assert.ok(findNode(inheritedTree.root, "."));
  await rpcError("play.run", { mode: "current" }, "FEATURE_UNAVAILABLE");
  assert.equal((await rpc("play.status")).playing, false);
  const inheritedSaved = await rpc("scene.save", { path: "res://.godot/godot-vibe-os/integration-inherited.tscn", withPreview: false });
  assert.equal(inheritedSaved.saved, true);
  await rpc("scene.open", { path: "res://main.tscn" });

  let tree = await rpc("scene.getTree", { includeProperties: true });
  assert.equal(tree.scenePath, "res://main.tscn");
  assert.ok(findNode(tree.root, "Anchor"));
  assert.ok(findNode(tree.root, "ExistingTemplate"));

  const selection = await rpc("selection.inspect", { includeProperties: true });
  assert.ok(Array.isArray(selection.nodes));

  const fsStatus = await rpc("filesystem.status");
  assert.equal(typeof fsStatus.indexedFiles, "number");
  const scan = await rpc("filesystem.scan");
  assert.equal(scan.requested, true);
  await waitUntil(async () => !(await rpc("filesystem.status")).scanning, 20_000, "filesystem scan to finish");

  const dependencies = await rpc("resource.getDependencies", { path: "res://main.tscn" });
  assert.ok(dependencies.dependencies.some((dependency) => dependency.path === "res://template.tscn"));
  const reflection = await rpc("reflect.query", { className: "Node2D", limit: 80 });
  assert.equal(reflection.classes[0].name, "Node2D");
  assert.ok(reflection.classes[0].properties.some((property) => property.name === "position"));
  await rpcError("reflect.query", { className: "DefinitelyNotAGodotClass" }, "CLASS_NOT_FOUND");

  const propertyWrite = await rpc("edit.setProperty", {
    nodePath: "Anchor",
    property: "position",
    value: { x: 42, y: 24 },
  });
  assert.deepEqual(propertyWrite.value, { type: "Vector2", x: 42, y: 24 });
  tree = await rpc("scene.getTree", { nodePath: "Anchor", includeProperties: true });
  assert.equal(findProperty(tree.root, "position").type, 5);
  assert.deepEqual(findProperty(tree.root, "position").value, { type: "Vector2", x: 42, y: 24 });

  const created = await rpc("edit.createNode", {
    parentPath: ".",
    className: "Node2D",
    name: "BridgeNode",
    properties: { editor_description: "created by integration" },
  });
  assert.equal(created.path, "BridgeNode");
  const reparented = await rpc("edit.reparentNode", {
    nodePath: "BridgeNode",
    newParentPath: "Anchor",
  });
  assert.equal(reparented.nodePath, "Anchor/BridgeNode");
  const restoredParent = await rpc("edit.reparentNode", {
    nodePath: "Anchor/BridgeNode",
    newParentPath: ".",
  });
  assert.equal(restoredParent.nodePath, "BridgeNode");
  const deleted = await rpc("edit.deleteNode", { nodePath: "BridgeNode" });
  assert.equal(deleted.deleted, true);

  const instantiated = await rpc("edit.instantiateScene", {
    scenePath: "res://template.tscn",
    parentPath: ".",
    name: "InstancedByBridge",
  });
  assert.equal(instantiated.sourceScene, "res://template.tscn");
  tree = await rpc("scene.getTree");
  assert.ok(findNode(tree.root, "InstancedByBridge"));
  await rpc("edit.deleteNode", { nodePath: "InstancedByBridge" });

  await rpc("edit.setProperty", {
    nodePath: "Anchor",
    property: "position",
    value: { x: 10, y: 20 },
  });
  tree = await rpc("scene.getTree", { nodePath: "Anchor", includeProperties: true });
  assert.deepEqual(findProperty(tree.root, "position").value, { type: "Vector2", x: 10, y: 20 });
  const saved = await rpc("scene.save");
  assert.equal(saved.saved, true);
  await rpcError("scene.save", { path: "res://scenes/invalid.nope", withPreview: false }, "SCENE_SAVE_FAILED");
  const resaved = await rpc("scene.save", { path: "res://main.tscn", withPreview: false });
  assert.equal(resaved.saved, true);
  await rpcError("viewport.capture2D", { outputPath: ".godot/../escaped.png" }, "INVALID_ARGUMENT");
  await rpcError("viewport.capture2D", { outputPath: "res://scenes/main.tscn" }, "INVALID_ARGUMENT");
  await rpcError("viewport.capture2D", { outputPath: "user://capture.png" }, "INVALID_ARGUMENT");
  await rpcError("viewport.capture2D", { outputPath: ".godot/godot-vibe-os/captures/nested/capture.png" }, "INVALID_ARGUMENT");
  if (process.platform !== "win32") {
    mkdirSync(path.dirname(captureSymlinkPath), { recursive: true });
    captureOutsideDirectory = mkdtempSync(path.join(tmpdir(), "godot-vibe-capture-"));
    const outsideCapture = path.join(captureOutsideDirectory, "outside.png");
    writeFileSync(outsideCapture, "outside capture target");
    symlinkSync(outsideCapture, captureSymlinkPath, "file");
    captureSymlinkCreated = true;
    await rpcError("viewport.capture2D", {
      outputPath: ".godot/godot-vibe-os/captures/integration-symlink.png",
    }, "INVALID_ARGUMENT");
    unlinkSync(captureSymlinkPath);
    captureSymlinkCreated = false;
    rmSync(captureOutsideDirectory, { recursive: true, force: true });
    captureOutsideDirectory = "";
  }

  for (const [method, outputPath] of [
    ["viewport.capture2D", ".godot/godot-vibe-os/captures/integration-2d.png"],
    ["viewport.capture3D", ".godot/godot-vibe-os/captures/integration-3d.png"],
  ]) {
    const response = await request("POST", "/rpc", {
      id: `integration-${method}`,
      version: "1.1",
      method,
      params: { outputPath, width: 320, height: 180 },
    }, discovery.token);
    if (response.body.ok) {
      const png = Buffer.from(response.body.result.pngBase64, "base64");
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(response.body.result.width, 320);
      assert.equal(response.body.result.height, 180);
      assert.ok(existsSync(response.body.result.absolutePath));
      capturePaths.push(response.body.result.absolutePath);
    } else {
      assert.equal(response.body.error.code, "CAPTURE_UNAVAILABLE");
    }
  }

  const startupDebug = await rpc("debug.snapshot", {
    maxEvents: 200,
    maxSamples: 1,
    includeScreenshot: false,
  });
  for (const event of startupDebug.events) {
    assert.doesNotMatch(event.message, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, "debug event text must remain valid JSON");
  }
  const debugBaseline = await rpc("debug.snapshot", {
    maxEvents: 1,
    maxSamples: 1,
    includeScreenshot: false,
  });
  assert.equal(debugBaseline.runId, "");
  assert.equal(debugBaseline.runtimeConnected, false);
  await rpcError("debug.captureFrames", { frames: 4, intervalMs: 100 }, "PLAY_MODE_REQUIRED");
  const debugRun = await rpc("play.run", { mode: "current" });
  assert.equal(debugRun.started, true);
  let debugSnapshot;
  await waitUntil(async () => {
    debugSnapshot = await rpc("debug.snapshot", {
      sinceEventCursor: debugBaseline.eventCursor,
      sinceSampleCursor: debugBaseline.sampleCursor,
      maxEvents: 100,
      maxSamples: 40,
      includeScreenshot: false,
    });
    return debugSnapshot.runtimeConnected
      && debugSnapshot.samples.length > 0
      && debugSnapshot.events.some((event) => event.message.includes("FOUNDRY_DEBUG_FIXTURE_WARNING"));
  }, 15_000, "runtime debug evidence");
  assert.equal(debugSnapshot.playing, true);
  assert.ok(debugSnapshot.runId.length > 0);
  assert.equal(debugSnapshot.runtime.rootName, "FixtureRoot");
  assert.ok(debugSnapshot.runtime.nodeCount > 0);
  assert.equal(debugSnapshot.missedEvents, 0);
  const captureRequested = await rpc("debug.snapshot", {
    sinceEventCursor: debugBaseline.eventCursor,
    sinceSampleCursor: debugBaseline.sampleCursor,
    requestScreenshot: true,
    includeScreenshot: true,
  });
  assert.ok(captureRequested.screenshotId.length > 0);
  let debugCapture = captureRequested;
  if (debugCapture.capturePending) {
    await waitUntil(async () => {
      debugCapture = await rpc("debug.snapshot", {
        sinceEventCursor: debugBaseline.eventCursor,
        sinceSampleCursor: debugBaseline.sampleCursor,
        includeScreenshot: true,
      });
      return !debugCapture.capturePending;
    }, 10_000, "runtime screenshot result");
  }
  if (debugCapture.screenshot) {
    const png = Buffer.from(debugCapture.screenshot.pngBase64, "base64");
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  } else {
    assert.match(debugCapture.captureError, /display server|viewport|stopped/i);
  }

  const frameRequest = await rpc("debug.captureFrames", {
    frames: 4,
    intervalMs: 100,
    width: 240,
    format: "jpg",
    quality: 60,
    maxFrames: 4,
  });
  assert.deepEqual(frameRequest.requested, { frames: 4, intervalMs: 100, width: 240, format: "jpg", quality: 60 });
  assert.ok(
    ["pending", "complete", "error", "not_running"].includes(frameRequest.state),
    `unexpected frame capture state '${frameRequest.state}'`,
  );
  const collectedFrames = [...frameRequest.frames];
  let frameCapture = frameRequest;
  if (frameRequest.state === "pending") {
    assert.ok(frameRequest.captureId.length > 0, "a started frame sequence must be addressable");
    await waitUntil(async () => {
      frameCapture = await rpc("debug.captureFrames", {
        captureId: frameRequest.captureId,
        sinceIndex: collectedFrames.length > 0 ? collectedFrames[collectedFrames.length - 1].index : 0,
        maxFrames: 4,
      });
      collectedFrames.push(...frameCapture.frames);
      return frameCapture.state !== "pending" && collectedFrames.length >= frameCapture.capturedCount;
    }, 15_000, "runtime frame sequence");
  }
  if (collectedFrames.length > 0) {
    frameEvidence = `${collectedFrames.length} rendered game frames`;
    assert.deepEqual(collectedFrames.map((frame) => frame.index), collectedFrames.map((_, index) => index + 1));
    let previousOffset = -1;
    for (const frame of collectedFrames) {
      assert.match(frame.hash, /^[0-9a-f]{16}$/, "each frame must carry an average hash for dedup");
      assert.equal(frame.mimeType, "image/jpeg");
      assert.ok(frame.width > 0 && frame.width <= 240, `frame width ${frame.width} must respect the request`);
      assert.ok(frame.height > 0);
      assert.ok(frame.tMs > previousOffset, "frame offsets must increase across the sequence");
      previousOffset = frame.tMs;
      const bytes = Buffer.from(frame.base64, "base64");
      assert.equal(bytes.length, frame.bytes);
      assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], "jpg frames must start with a JPEG SOI marker");
    }
  } else {
    // Headless Godot cannot render, so the honest refusal is the verified behaviour here.
    frameEvidence = `honest '${frameCapture.error}' refusal`;
    assert.ok(["error", "not_running"].includes(frameCapture.state), `expected an honest refusal, got '${frameCapture.state}'`);
    assert.match(frameCapture.error, /display server|viewport|stopped|not connected|in progress/i);
  }
  const staleFramePoll = await rpc("debug.captureFrames", { captureId: "no-such-capture" });
  assert.equal(staleFramePoll.state, "error");
  assert.equal(staleFramePoll.frames.length, 0);

  const debugStopped = await rpc("play.stop");
  assert.equal(debugStopped.stopped, true);
  let retainedDebug;
  await waitUntil(async () => {
    retainedDebug = await rpc("debug.snapshot", {
      sinceEventCursor: debugBaseline.eventCursor,
      sinceSampleCursor: debugBaseline.sampleCursor,
      maxEvents: 100,
      maxSamples: 40,
      includeScreenshot: false,
    });
    return retainedDebug.stoppedAtMs !== null;
  }, 10_000, "retained stopped debug evidence");
  assert.equal(retainedDebug.runId, debugSnapshot.runId);
  assert.equal(retainedDebug.playing, false);
  assert.equal(retainedDebug.runtimeConnected, false, "a stopped runtime must not remain connected into the next launch");
  assert.ok(retainedDebug.events.some((event) => event.message.includes("FOUNDRY_DEBUG_FIXTURE_WARNING")));

  await rpc("play.run", { mode: "current" });
  const sequentialSnapshots = [];
  let guardedRun;
  await waitUntil(async () => {
    guardedRun = await rpc("debug.snapshot", { maxEvents: 1, maxSamples: 1 });
    sequentialSnapshots.push(guardedRun);
    return guardedRun.playing && guardedRun.runId && guardedRun.runId !== retainedDebug.runId;
  }, 10_000, "first guarded run identity");
  assert.equal(
    sequentialSnapshots.some((snapshot) => snapshot.runId === retainedDebug.runId && snapshot.runtimeConnected),
    false,
    "retained prior-run evidence must not appear connected while the next debugger session starts",
  );
  await rpc("play.stop", { expectedRunId: guardedRun.runId });
  await rpc("play.run", { mode: "main" });
  let replacementRun;
  await waitUntil(async () => {
    replacementRun = await rpc("debug.snapshot", { maxEvents: 1, maxSamples: 1 });
    return replacementRun.playing && replacementRun.runId && replacementRun.runId !== guardedRun.runId;
  }, 10_000, "replacement run identity");
  await rpcError("play.stop", { expectedRunId: guardedRun.runId }, "RUN_CHANGED");
  assert.equal((await rpc("play.status")).playing, true, "a replaced run must remain active");
  await rpc("play.stop", { expectedRunId: replacementRun.runId });
  await waitUntil(async () => {
    const stoppedRun = await rpc("debug.snapshot", { maxEvents: 1, maxSamples: 1 });
    return !stoppedRun.playing && stoppedRun.runId === replacementRun.runId && stoppedRun.stoppedAtMs !== null;
  }, 10_000, "replacement runtime process stop");

  for (const [params, expectedPath] of [
    [{ mode: "current" }, "res://main.tscn"],
    [{ mode: "main" }, "res://main.tscn"],
    [{ mode: "custom", path: "res://template.tscn" }, "res://template.tscn"],
  ]) {
    const run = await rpc("play.run", params);
    assert.equal(run.started, true);
    assert.equal(run.playing, true);
    assert.equal(run.scenePath, expectedPath);
    assert.equal(run.requestedMode, params.mode);
    const status = await rpc("play.status");
    assert.equal(status.playing, true);
    assert.equal(status.scenePath, expectedPath);
    const stopped = await rpc("play.stop");
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.playing, false);
    await waitUntil(async () => {
      const stoppedRun = await rpc("debug.snapshot", { maxEvents: 1, maxSamples: 1 });
      return !stoppedRun.playing && stoppedRun.stoppedAtMs !== null;
    }, 10_000, `${params.mode} runtime process stop`);
  }
  const alreadyStopped = await rpc("play.stop");
  assert.equal(alreadyStopped.stopped, false);
  assert.equal(alreadyStopped.playing, false);

  unlinkSync(projectFilePath);
  await rpcError("play.run", { mode: "current" }, "FEATURE_UNAVAILABLE");
  assert.equal((await rpc("play.status")).playing, false);
  writeFileSync(projectFilePath, originalProjectFile);

  writeFileSync(importedMarkerPath, "");
  await rpcError("scene.open", { path: "res://template.tscn" }, "FEATURE_UNAVAILABLE");
  const importedInherited = await rpc("scene.open", { path: "res://template.tscn", inherited: true });
  assert.equal(importedInherited.opened, true);
  assert.equal((await rpc("scene.getTree")).scenePath, "");
  unlinkSync(importedMarkerPath);

  await stopEditor();
  removeExitedEditorDiscovery();
  assert.equal(existsSync(discoveryPath), false);
  await testDiscoveryDirectorySymlinkContainment();
  await testDiscoveryFileSymlinkContainment();
  await testOwnershipSafeCleanup();
  await testPrimaryDiscoveryRecovery();
  await testRandomTokenFailure();
  console.log(`Godot addon integration passed: auth, 23 RPC methods, inherited imports, undoable edits, runtime debug evidence, game frame capture (${frameEvidence}), save, capture containment, play, and multi-editor discovery lifecycle.`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  if (editorOutput) process.stderr.write(`\nGodot output (tail):\n${editorOutput.slice(-8000)}\n`);
  process.exitCode = 1;
} finally {
  await stopEditor();
  if (!existsSync(projectFilePath) || !readFileSync(projectFilePath).equals(originalProjectFile)) writeFileSync(projectFilePath, originalProjectFile);
  if (!readFileSync(mainScenePath).equals(originalMainScene)) writeFileSync(mainScenePath, originalMainScene);
  if (existsSync(importedMarkerPath)) unlinkSync(importedMarkerPath);
  if (existsSync(inheritedScenePath)) unlinkSync(inheritedScenePath);
  if (captureSymlinkCreated) {
    try {
      unlinkSync(captureSymlinkPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (captureOutsideDirectory) rmSync(captureOutsideDirectory, { recursive: true, force: true });
  for (const capturePath of capturePaths) {
    if (existsSync(capturePath)) unlinkSync(capturePath);
  }
  removeExitedEditorDiscovery();
  if (portBlocker?.listening) portBlocker.close();
}


function request(method, requestPath, payload, token, target = discovery) {
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.host,
      port: target.port,
      path: requestPath,
      method,
      timeout: 30_000,
      headers: {
        ...(token ? { "X-Godot-Vibe-Token": token } : {}),
        ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(new Error(`Non-JSON bridge response: ${text}`, { cause: error }));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out: ${method} ${requestPath}`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}


async function blockPreferredPort() {
  while (true) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    if (port <= 65504) return { server, port };
    await new Promise((resolve) => server.close(resolve));
  }
}


async function waitForDiscovery(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Godot exited before discovery (code ${child.exitCode}).`);
    if (existsSync(discoveryPath)) {
      try {
        const value = JSON.parse(readFileSync(discoveryPath, "utf8"));
        if (value.port > 0 && value.token) return value;
      } catch {
        // The addon writes a tiny file; retry if observed between open and flush.
      }
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for bridge discovery.");
}


async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}


function findNode(node, targetPath) {
  if (node.path === targetPath) return node;
  for (const child of node.children ?? []) {
    const match = findNode(child, targetPath);
    if (match) return match;
  }
  return undefined;
}


function findProperty(node, name) {
  const property = node.properties?.find((item) => item.name === name);
  assert.ok(property, `Missing property '${name}' on ${node.path}`);
  return property;
}


function rejectRunningFixtureEditor() {
  if (!existsSync(discoveryPath)) return;
  try {
    const stale = JSON.parse(readFileSync(discoveryPath, "utf8"));
    if (typeof stale.pid === "number" && stale.pid > 0) {
      process.kill(stale.pid, 0);
      throw new Error(`Fixture editor PID ${stale.pid} is already running.`);
    }
  } catch (error) {
    if (error.code !== "ESRCH" && !error.message?.includes("Unexpected")) throw error;
  }
}


function removeExitedEditorDiscovery() {
  if (!editor || !existsSync(discoveryPath)) return;
  const stale = JSON.parse(readFileSync(discoveryPath, "utf8"));
  assert.equal(stale.pid, editor.pid, "refusing to remove discovery owned by another process");
  assert.throws(() => process.kill(stale.pid, 0), (error) => error.code === "ESRCH");
  unlinkSync(discoveryPath);
}


async function stopEditor() {
  if (!editor || editor.exitCode !== null || editor.signalCode !== null) return;
  editor.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => editor.once("exit", () => resolve(true))),
    delay(10_000).then(() => false),
  ]);
  if (exited) {
    return;
  }
  editor.kill("SIGKILL");
  await new Promise((resolve) => editor.once("exit", resolve));
}


async function testDiscoveryDirectorySymlinkContainment() {
  if (process.platform === "win32") return;
  const scenario = createProjectScenario("directory-link");
  const outside = mkdtempSync(path.join(tmpdir(), "godot-vibe-discovery-outside-"));
  const godotDirectory = path.join(scenario.project, ".godot");
  rmSync(godotDirectory, { recursive: true, force: true });
  symlinkSync(outside, godotDirectory, "dir");
  let run;
  try {
    run = spawnScenarioEditor(scenario.project);
    await waitForOutput(run, "Bridge discovery path cannot contain symbolic links or reparse points.", 20_000);
    assert.equal(existsSync(path.join(outside, "godot-vibe-os")), false, "startup must not create a discovery directory through a link");
  } finally {
    await terminateChild(run?.child);
    rmSync(scenario.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}


async function testDiscoveryFileSymlinkContainment() {
  if (process.platform === "win32") return;
  const scenario = createProjectScenario("file-link");
  const directory = path.join(scenario.project, ".godot", "godot-vibe-os");
  mkdirSync(directory, { recursive: true });
  const outside = path.join(scenario.root, "outside.txt");
  const original = "outside discovery target";
  writeFileSync(outside, original);
  symlinkSync(outside, path.join(directory, "bridge.json"), "file");
  let run;
  try {
    run = spawnScenarioEditor(scenario.project);
    await waitForOutput(run, "Bridge discovery path cannot contain symbolic links or reparse points.", 20_000);
    assert.equal(readFileSync(outside, "utf8"), original, "startup must not overwrite a linked discovery target");
  } finally {
    await terminateChild(run?.child);
    rmSync(scenario.root, { recursive: true, force: true });
  }
}


async function testOwnershipSafeCleanup() {
  const scenario = createProjectScenario("ownership");
  const scenarioDiscovery = path.join(scenario.project, ".godot", "godot-vibe-os", "bridge.json");
  let run;
  try {
    run = spawnScenarioEditor(scenario.project, ["--quit-after", "20", "--max-fps", "5"]);
    const owned = await waitForDiscoveryPath(run.child, scenarioDiscovery, 20_000);
    const replacement = { ...owned, pid: process.pid, token: "replacement-owner-token-00000000000000000000" };
    writeFileSync(scenarioDiscovery, JSON.stringify(replacement));
    await waitForExit(run.child, 15_000);
    assert.deepEqual(JSON.parse(readFileSync(scenarioDiscovery, "utf8")), replacement, "an exiting editor must preserve another owner's discovery");
  } finally {
    await terminateChild(run?.child);
    rmSync(scenario.root, { recursive: true, force: true });
  }
}


async function testPrimaryDiscoveryRecovery() {
  const scenario = createProjectScenario("multi-editor-recovery");
  const scenarioDiscovery = path.join(scenario.project, ".godot", "godot-vibe-os", "bridge.json");
  let primary;
  let secondary;
  try {
    primary = spawnScenarioEditor(scenario.project);
    const original = await waitForDiscoveryOwner(primary.child, scenarioDiscovery, primary.child.pid, 20_000);
    secondary = spawnScenarioEditor(scenario.project, ["--quit-after", "20", "--max-fps", "5"]);
    const temporary = await waitForDiscoveryOwner(secondary.child, scenarioDiscovery, secondary.child.pid, 20_000);
    assert.equal(temporary.port !== original.port, true, "the secondary editor must own a distinct bridge");
    assert.equal(temporary.token !== original.token, true, "each editor must use an independent bridge token");
    await waitForExit(secondary.child, 15_000);
    const restored = await waitForDiscoveryOwner(primary.child, scenarioDiscovery, primary.child.pid, 5_000);
    assert.equal(restored.port === original.port, true, "the surviving primary bridge port must be restored");
    assert.equal(restored.token === original.token, true, "the surviving primary bridge token must be restored");
    if (process.platform !== "win32") {
      assert.equal(statSync(scenarioDiscovery).mode & 0o777, 0o600, "recovered discovery must remain owner-only");
    }
    const health = await request("GET", "/health", undefined, original.token, restored);
    assert.equal(health.status, 200, "the recovered primary bridge must remain reachable");
    assert.equal(primary.output().includes(original.token), false, "the primary token must not appear in editor output");
    assert.equal(secondary.output().includes(temporary.token), false, "the secondary token must not appear in editor output");
  } finally {
    await terminateChild(secondary?.child);
    await terminateChild(primary?.child);
    rmSync(scenario.root, { recursive: true, force: true });
  }
}


async function testRandomTokenFailure() {
  const scenario = createProjectScenario("rng-failure");
  const serverPath = path.join(scenario.project, "addons", "godot_vibe_os", "bridge_server.gd");
  const source = readFileSync(serverPath, "utf8");
  const injected = source.replace("Crypto.new().generate_random_bytes(TOKEN_BYTES)", "PackedByteArray()");
  assert.notEqual(injected, source, "RNG failure scenario must replace the token source");
  writeFileSync(serverPath, injected);
  let run;
  try {
    run = spawnScenarioEditor(scenario.project);
    await waitForOutput(run, "Could not generate a secure bridge token.", 20_000);
    assert.equal(existsSync(path.join(scenario.project, ".godot", "godot-vibe-os", "bridge.json")), false, "RNG failure must not publish discovery");
  } finally {
    await terminateChild(run?.child);
    rmSync(scenario.root, { recursive: true, force: true });
  }
}


function createProjectScenario(name) {
  const root = mkdtempSync(path.join(tmpdir(), `godot-vibe-${name}-`));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "addons"), { recursive: true });
  cpSync(addonSource, path.join(project, "addons", "godot_vibe_os"), { recursive: true });
  cpSync(projectFilePath, path.join(project, "project.godot"));
  cpSync(mainScenePath, path.join(project, "main.tscn"));
  cpSync(path.join(fixture, "debug_runtime.gd"), path.join(project, "debug_runtime.gd"));
  cpSync(path.join(fixture, "template.tscn"), path.join(project, "template.tscn"));
  return { root, project };
}


function spawnScenarioEditor(project, extraArgs = []) {
  const child = spawn(godot, ["--headless", "--editor", "--path", project, "--no-header", ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}


async function waitForOutput(run, needle, timeoutMs) {
  await waitUntil(() => {
    if (run.child.exitCode !== null) throw new Error(`Scenario editor exited before '${needle}': ${run.output()}`);
    return run.output().includes(needle);
  }, timeoutMs, needle);
}


async function waitForDiscoveryPath(child, file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Scenario editor exited before discovery (code ${child.exitCode}).`);
    if (existsSync(file)) {
      try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        if (value.port > 0 && value.token) return value;
      } catch {}
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for scenario discovery.");
}


async function waitForDiscoveryOwner(child, file, ownerPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Godot editor ${ownerPid} exited before owning discovery (code ${child.exitCode}).`);
    if (existsSync(file)) {
      try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        if (value.pid === ownerPid && value.port > 0 && value.token) return value;
      } catch {}
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for editor ${ownerPid} to own discovery.`);
}


async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child, 10_000);
}


async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    throw new Error("Scenario editor did not exit in time.");
  }
}


function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
