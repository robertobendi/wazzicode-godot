import { createHash } from "node:crypto";
import { access, chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ok } from "@gvibe/core";
import { buildContext } from "@gvibe/mcp-server";
import { listSnapshots, readActions, restoreSnapshot } from "@gvibe/safety";
import { executeTool } from "../packages/mcp-server/src/execute.js";
import type { AnyToolDef } from "../packages/mcp-server/src/registry.js";
import {
  godotApplyTextEdits,
  godotCreateScript,
  godotFindInFile,
  godotGetScriptSha,
  godotReadScript,
  godotVerify,
} from "../packages/mcp-server/src/tools/godotFiles.js";

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gvibe-files-test-"));
  temporaryProjects.push(root);
  await mkdir(path.join(root, "scripts"), { recursive: true });
  return root;
}

function sha(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

describe("Godot text inspection tools", () => {
  it("reads bounded GDScript with a full-file content hash", async () => {
    const root = await project();
    const contents = "extends Node\n@export var speed := 10\nfunc move():\n    pass\n";
    await writeFile(path.join(root, "scripts", "player.gd"), contents, "utf8");
    const ctx = buildContext({ mock: true, projectPath: root });

    const envelope = await godotReadScript.run({ path: "res://scripts/player.gd", startLine: 2, endLine: 3 }, ctx);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data).toMatchObject({
        path: "res://scripts/player.gd",
        contents: "@export var speed := 10\nfunc move():",
        sha256: sha(contents),
        lineCount: 5,
        sizeBytes: Buffer.byteLength(contents),
        truncated: true,
      });
    }
  });

  it("returns hashes without content and reports missing scripts explicitly", async () => {
    const root = await project();
    const contents = "class_name SaveManager\nextends Node\n";
    await writeFile(path.join(root, "scripts", "save_manager.gd"), contents, "utf8");
    const ctx = buildContext({ mock: true, projectPath: root });

    const found = await godotGetScriptSha.run({ path: "scripts/save_manager.gd" }, ctx);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.data).toEqual({
      path: "res://scripts/save_manager.gd",
      exists: true,
      sha256: sha(contents),
      sizeBytes: Buffer.byteLength(contents),
      lineCount: 3,
    });

    const missing = await godotGetScriptSha.run({ path: "res://scripts/missing.gd" }, ctx);
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.data).toEqual({
      path: "res://scripts/missing.gd",
      exists: false,
      sha256: "",
      sizeBytes: 0,
      lineCount: 0,
    });
  });

  it("regex-searches exact lines with case and result bounds", async () => {
    const root = await project();
    await writeFile(path.join(root, "scripts", "enemy.gd"), [
      "class_name Enemy",
      "signal Hit(amount: int)",
      "func hit(amount: int):",
      "    Hit.emit(amount)",
    ].join("\n"), "utf8");
    const ctx = buildContext({ mock: true, projectPath: root });

    const envelope = await godotFindInFile.run({
      path: "res://scripts/enemy.gd",
      pattern: "hit",
      ignoreCase: true,
      maxResults: 2,
    }, ctx);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.matchCount).toBe(2);
      expect(envelope.data.truncated).toBe(true);
      expect(envelope.data.matches).toEqual([
        { line: 2, column: 8, match: "Hit", lineText: "signal Hit(amount: int)" },
        { line: 3, column: 6, match: "hit", lineText: "func hit(amount: int):" },
      ]);
    }
  });
});

describe("Godot text mutation tools", () => {
  it("previews creation, creates nested scripts, and refuses silent overwrite", async () => {
    const root = await project();
    const ctx = buildContext({ mock: true, projectPath: root });
    const file = path.join(root, "actors", "player.gd");
    const contents = "class_name Player\nextends CharacterBody2D\n";

    const preview = await godotCreateScript.run({ path: "res://actors/player.gd", contents, preview: true }, ctx);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.data).toMatchObject({ applied: false, changed: true, createdPath: "res://actors/player.gd" });
    await expect(access(file)).rejects.toThrow();

    const created = await godotCreateScript.run({ path: "res://actors/player.gd", contents }, ctx);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.data).toMatchObject({ applied: true, changed: true, sha256After: sha(contents) });
    expect(await readFile(file, "utf8")).toBe(contents);

    const refused = await godotCreateScript.run({ path: "res://actors/player.gd", contents: "extends Node\n" }, ctx);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("overwrite:true") });
    expect(await readFile(file, "utf8")).toBe(contents);

    await chmod(file, 0o744);
    const overwritten = await godotCreateScript.run({
      path: "res://actors/player.gd",
      contents: "extends Node\n",
      overwrite: true,
    }, ctx);
    expect(overwritten.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("extends Node\n");
    expect((await stat(file)).mode & 0o777).toBe(0o744);
    expect(await readdir(path.dirname(file))).toEqual(["player.gd"]);
  });

  it("applies ordered edits only when the sha256 precondition matches", async () => {
    const root = await project();
    const file = path.join(root, "scripts", "player.gd");
    const before = "extends Node\nvar speed := 10\nfunc move():\n    pass\n";
    await writeFile(file, before, "utf8");
    await chmod(file, 0o744);
    const ctx = buildContext({ mock: true, projectPath: root });

    const stale = await godotApplyTextEdits.run({
      path: "res://scripts/player.gd",
      preconditionSha256: "0".repeat(64),
      edits: [{ startLine: 2, startCol: 1, newText: "@export " }],
    }, ctx);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error).toMatchObject({
        code: "UNSAVED_CHANGES",
        details: { expected: "0".repeat(64), actual: sha(before) },
      });
    }
    expect(await readFile(file, "utf8")).toBe(before);

    const edited = await godotApplyTextEdits.run({
      path: "res://scripts/player.gd",
      preconditionSha256: sha(before),
      edits: [
        { startLine: 2, startCol: 1, newText: "@export " },
        { startLine: 4, startCol: 5, newText: "print(\"move\")\n    " },
      ],
    }, ctx);
    const after = "extends Node\n@export var speed := 10\nfunc move():\n    print(\"move\")\n    pass\n";
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.data).toMatchObject({
      applied: true,
      changed: true,
      path: "res://scripts/player.gd",
      sha256Before: sha(before),
      sha256After: sha(after),
      editCount: 2,
      undoable: false,
    });
    expect(await readFile(file, "utf8")).toBe(after);
    expect((await stat(file)).mode & 0o777).toBe(0o744);
    expect(await readdir(path.dirname(file))).toEqual(["player.gd"]);
  });

  it("leaves the original intact and no temp artifact when atomic publication cannot start", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await project();
    const directory = path.join(root, "scripts");
    const file = path.join(directory, "protected.gd");
    const before = "extends Node\nvar lives := 3\n";
    await writeFile(file, before, { encoding: "utf8", mode: 0o600 });
    const ctx = buildContext({ mock: true, projectPath: root });

    let result;
    await chmod(directory, 0o500);
    try {
      result = await godotApplyTextEdits.run({
        path: "res://scripts/protected.gd",
        edits: [{ startLine: 2, startCol: 14, endCol: 15, newText: "4" }],
      }, ctx);
    } finally {
      await chmod(directory, 0o700);
    }

    expect(result?.ok).toBe(false);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(directory)).toEqual(["protected.gd"]);
  });

  it("validates every edit range before writing, leaving the file untouched on failure", async () => {
    const root = await project();
    const file = path.join(root, "scripts", "atomic.gd");
    const before = "extends Node\nvar lives := 3\n";
    await writeFile(file, before, "utf8");
    const ctx = buildContext({ mock: true, projectPath: root });

    const result = await godotApplyTextEdits.run({
      path: "res://scripts/atomic.gd",
      edits: [
        { startLine: 1, startCol: 1, newText: "@tool\n" },
        { startLine: 999, startCol: 1, newText: "invalid" },
      ],
    }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("Line 999") });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects traversal, absolute paths, and unsupported binary extensions", async () => {
    const root = await project();
    const ctx = buildContext({ mock: true, projectPath: root });
    const attempts = [
      godotCreateScript.run({ path: `../${path.basename(root)}-escape.gd`, contents: "extends Node\n" }, ctx),
      godotReadScript.run({ path: path.join(root, "scripts", "player.gd") }, ctx),
      godotCreateScript.run({ path: "res://textures/player.png", contents: "not png" }, ctx),
    ];
    for (const pending of attempts) {
      const envelope = await pending;
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("rejects reads and writes through symlinks that resolve outside the project", async () => {
    const root = await project();
    const outside = await project();
    await writeFile(path.join(outside, "outside.gd"), "extends Node\n", "utf8");
    await symlink(outside, path.join(root, "linked"));
    const ctx = buildContext({ mock: true, projectPath: root });

    const read = await godotReadScript.run({ path: "res://linked/outside.gd" }, ctx);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.message).toContain("outside the Godot project");

    const create = await godotCreateScript.run({ path: "res://linked/created.gd", contents: "extends Node\n" }, ctx);
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.error.message).toContain("outside the Godot project");
    await expect(access(path.join(outside, "created.gd"))).rejects.toThrow();
  });

  it("applies gates, absence-aware snapshots, and logging to writes backed by the mock bridge", async () => {
    const root = await project();
    const ctx = buildContext({ mock: true, projectPath: root });
    const tool = ctx.tools?.find((candidate) => candidate.name === "godot_create_script");
    expect(tool).toBeDefined();

    const envelope = await executeTool(tool!, {
      path: "res://actors/mock_player.gd",
      contents: "extends Node\n",
    }, ctx);
    expect(envelope.ok).toBe(true);
    expect(await readFile(path.join(root, "actors", "mock_player.gd"), "utf8")).toBe("extends Node\n");

    const snapshots = await listSnapshots(root);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].absent).toEqual(["actors/mock_player.gd"]);
    expect(await readActions(root)).toEqual([
      expect.objectContaining({
        tool: "godot_create_script",
        result: "ok",
        snapshotId: snapshots[0].id,
      }),
    ]);

    await restoreSnapshot(root, snapshots[0].id);
    await expect(access(path.join(root, "actors", "mock_player.gd"))).rejects.toThrow();
  });

  it("blocks a write when its required snapshot cannot be contained", async () => {
    const root = await project();
    const outside = await project();
    await symlink(outside, path.join(root, "escape"));
    const ctx = buildContext({ mock: true, projectPath: root });
    const tool = ctx.tools?.find((candidate) => candidate.name === "godot_create_script");

    const envelope = await executeTool(tool!, {
      path: "res://escape/blocked.gd",
      contents: "extends Node\n",
    }, ctx);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("WRITE_REQUIRES_SNAPSHOT");
    await expect(access(path.join(outside, "blocked.gd"))).rejects.toThrow();
    expect(await readActions(root)).toEqual([
      expect.objectContaining({
        tool: "godot_create_script",
        result: "blocked",
        errorCode: "WRITE_REQUIRES_SNAPSHOT",
      }),
    ]);
  });

  it("serializes concurrent write transactions for one project", async () => {
    const root = await project();
    const file = path.join(root, "scripts", "counter.gd");
    await writeFile(file, "0", "utf8");
    const ctx = buildContext({ mock: true, projectPath: root });
    let running = 0;
    let maxRunning = 0;
    const tool: AnyToolDef = {
      name: "test_serialized_script_write",
      description: "Exercises the complete project write transaction lock.",
      inputShape: {},
      requires: ["filesystem"],
      write: true,
      writeTarget: "script",
      async run() {
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          const value = Number(await readFile(file, "utf8"));
          await new Promise((resolve) => setTimeout(resolve, 20));
          await writeFile(file, String(value + 1), "utf8");
          return ok({ summary: "incremented" }, { source: "filesystem" });
        } finally {
          running--;
        }
      },
    };

    const results = await Promise.all([
      executeTool(tool, { path: "res://scripts/counter.gd" }, ctx),
      executeTool(tool, { path: "res://scripts/counter.gd" }, ctx),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxRunning).toBe(1);
    expect(await readFile(file, "utf8")).toBe("2");
    const snapshots = await listSnapshots(root);
    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(2);
    const captured = await Promise.all(
      snapshots.map((snapshot) => readFile(path.join(snapshot.rootDir, "scripts", "counter.gd"), "utf8"))
    );
    expect(new Set(captured)).toEqual(new Set(["0", "1"]));
    const actions = await readActions(root);
    expect(actions).toHaveLength(2);
    expect(new Set(actions.map((action) => action.snapshotId))).toEqual(
      new Set(snapshots.map((snapshot) => snapshot.id))
    );
  });

  it("returns PROJECT_BUSY without running a write when another process owns the project lock", async () => {
    const root = await project();
    const lock = path.join(root, ".godot-vibe", "write.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: Date.now(),
      token: "busy-owner-token-0123456789abcdef",
      operation: "other-process-write",
    }) + "\n", "utf8");
    let calls = 0;
    const tool: AnyToolDef = {
      name: "test_busy_script_write",
      description: "Verifies that MCP write execution maps lock contention without running the tool.",
      inputShape: {},
      requires: ["filesystem"],
      write: true,
      writeTarget: "script",
      async run() {
        calls++;
        return ok({ summary: "should not run" }, { source: "filesystem" });
      },
    };

    const envelope = await executeTool(tool, { path: "res://scripts/busy.gd" }, buildContext({ mock: true, projectPath: root }), {
      writeLock: { timeoutMs: 40, staleMs: 100, pollMs: 5 },
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error).toMatchObject({
        code: "PROJECT_BUSY",
        recoverable: true,
        details: { holder: { operation: "other-process-write" } },
      });
    }
    expect(calls).toBe(0);
    expect(await readActions(root)).toEqual([]);
    await access(lock);
  });
});

describe("Godot verification", () => {
  it("resolves relative project paths and separates import/syntax from project tests", async () => {
    const fixtureSource = path.resolve("tests/godot/fixture");
    const fixture = await project();
    for (const name of ["project.godot", "main.tscn", "template.tscn"]) {
      await cp(path.join(fixtureSource, name), path.join(fixture, name));
    }
    await cp(
      path.resolve("godot/addons/godot_vibe_os"),
      path.join(fixture, "addons", "godot_vibe_os"),
      { recursive: true }
    );
    await writeFile(path.join(fixture, "Game.csproj"), "<Project Sdk=\"Godot.NET.Sdk\"></Project>\n", "utf8");
    await writeFile(path.join(fixture, "scripts", "Player.cs"), "this is intentionally invalid C#\n", "utf8");
    const relativeFixture = path.relative(process.cwd(), fixture);
    const ctx = buildContext({ mock: true, projectPath: relativeFixture });
    const envelope = await godotVerify.run({ godotBinary: "godot", timeoutMs: 120_000 }, ctx);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.verdict).toBe("unverified");
      expect(envelope.data.import).toMatchObject({ ok: true, exitCode: 0 });
      expect(envelope.data.scripts).toMatchObject({ checked: 3, failed: 0, failures: [] });
      expect(envelope.data.tests).toMatchObject({ status: "not_configured" });
      expect(envelope.data.tests.message).toContain("not unit tests");
      expect(envelope.data.csharp).toMatchObject({ status: "unverified", scripts: 1, projects: 1 });
      expect(envelope.data.warnings).toEqual([
        expect.stringContaining("C#/.NET verification was not performed"),
      ]);
      expect(envelope.data.warnings[0]).toContain("found 1 .cs file(s) and 1 .csproj file(s)");
      expect(envelope.warnings).toEqual(envelope.data.warnings);
      expect(envelope.meta.projectPath).toBe(path.resolve(relativeFixture));
    }
  }, 20_000);
});
