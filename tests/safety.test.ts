import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_PATH_REL,
  DEFAULT_CONFIG,
  FAIL_CLOSED_CONFIG,
  GVibeConfigSchema,
  appendAction,
  createSnapshot,
  gateTool,
  isWriteTool,
  listSnapshots,
  loadConfig,
  readActions,
  restoreSnapshot,
  writeConfig,
  writeConfigIfMissing,
  writeTargetOf,
} from "@gvibe/safety";

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gvibe-safety-test-"));
  temporaryProjects.push(root);
  return root;
}

describe("Godot safety configuration", () => {
  it("defaults to usable scene/resource/script access but locks project settings", () => {
    expect(DEFAULT_CONFIG).toEqual({
      safetyMode: "autopilot",
      allowSceneWrites: true,
      allowResourceWrites: true,
      allowScriptWrites: true,
      allowProjectSettingsWrites: false,
      allowEditorControl: true,
      autoSnapshot: true,
      godotProjectPath: ".",
      mcpPort: 38587,
      bridgePort: 38588,
      mockMode: false,
    });
    expect(CONFIG_PATH_REL).toBe(".godot-vibe/config.json");
  });

  it("writes config once, preserves it, and loads explicit values", async () => {
    const root = await project();
    const first = await writeConfigIfMissing(root);
    const second = await writeConfigIfMissing(root);
    expect(first).toEqual({ written: true, path: path.join(root, ".godot-vibe", "config.json") });
    expect(second.written).toBe(false);

    const configured = GVibeConfigSchema.parse({
      safetyMode: "confirm",
      allowSceneWrites: false,
      allowScriptWrites: false,
      godotProjectPath: root,
    });
    await writeConfig(root, configured);
    expect(await loadConfig(root)).toEqual(configured);
  });

  it("uses defaults only when config is absent and fails closed when it is malformed or unreadable", async () => {
    const root = await project();
    expect(await loadConfig(root)).toEqual(DEFAULT_CONFIG);
    const result = await writeConfigIfMissing(root);
    await writeFile(result.path, "{ broken", "utf8");
    expect(await loadConfig(root)).toEqual(FAIL_CLOSED_CONFIG);

    await rm(result.path);
    await mkdir(result.path);
    expect(await loadConfig(root)).toEqual(FAIL_CLOSED_CONFIG);
  });

  it("does not replace a config path that cannot be accessed safely", async () => {
    const root = await project();
    await writeFile(path.join(root, ".godot-vibe"), "not a directory", "utf8");
    await expect(writeConfigIfMissing(root)).rejects.toThrow();
  });
});

describe("Godot tool gating", () => {
  const config = (values: Record<string, unknown> = {}) => GVibeConfigSchema.parse(values);

  it("uses an exact Godot write-tool table", () => {
    expect(writeTargetOf("godot_set_property")).toBe("scene");
    expect(writeTargetOf("godot_instantiate_scene")).toBe("scene");
    expect(writeTargetOf("godot_open_scene")).toBe("editor");
    expect(writeTargetOf("godot_create_script")).toBe("script");
    expect(writeTargetOf("godot_refresh_filesystem")).toBe("editor");
    expect(writeTargetOf("godot_run_project")).toBe("editor");
    expect(writeTargetOf("godot_get_scene_tree")).toBeUndefined();
    expect(writeTargetOf("some_scene_word")).toBeUndefined();
    expect(isWriteTool("godot_save_scene")).toBe(true);
    expect(isWriteTool("godot_get_open_scenes")).toBe(false);
  });

  it("blocks all mutations in read-only and suggest modes", () => {
    for (const safetyMode of ["read_only", "suggest"] as const) {
      for (const tool of ["godot_save_scene", "godot_create_script", "godot_open_scene", "godot_refresh_filesystem"]) {
        const decision = gateTool(config({ safetyMode }), tool);
        expect(decision.allowed, `${safetyMode}:${tool}`).toBe(false);
        expect(decision.errorCode).toBe("SAFETY_MODE_BLOCKED");
        expect(decision.reason).toContain(tool);
      }
    }
  });

  it("requires a trusted approval channel in confirm mode and honors target locks in autopilot", () => {
    expect(gateTool(config({ safetyMode: "autopilot", allowSceneWrites: false }), "godot_create_node").allowed).toBe(false);
    expect(gateTool(config({ safetyMode: "autopilot", allowSceneWrites: true }), "godot_create_node").allowed).toBe(true);
    expect(gateTool(config({ safetyMode: "confirm", allowScriptWrites: false }), "godot_apply_text_edits").allowed).toBe(false);
    const confirm = gateTool(config({ safetyMode: "confirm", allowScriptWrites: true }), "godot_apply_text_edits");
    expect(confirm.allowed).toBe(false);
    expect(confirm.reason).toContain("no trusted approval signal");
    expect(gateTool(config({ safetyMode: "autopilot", allowEditorControl: false }), "godot_run_project").allowed).toBe(false);
    expect(gateTool(config({ safetyMode: "autopilot", allowEditorControl: true }), "godot_run_project").allowed).toBe(true);
    expect(gateTool(config({ safetyMode: "autopilot", allowResourceWrites: false }), "custom", "resource").allowed).toBe(false);
    expect(gateTool(config({ safetyMode: "autopilot", allowProjectSettingsWrites: false }), "custom", "project_settings").allowed).toBe(false);
  });

  it("never gates read-only inspection tools", () => {
    const locked = config({ safetyMode: "read_only" });
    for (const tool of ["godot_orient", "godot_reflect", "godot_capture_2d_view", "godot_read_script"]) {
      expect(gateTool(locked, tool).allowed, tool).toBe(true);
    }
  });
});

describe("snapshots and action history", () => {
  it("stores and restores nested project files under .godot-vibe/snapshots", async () => {
    const root = await project();
    const scene = path.join(root, "scenes", "main.tscn");
    await writeFileWithParents(scene, "[node name=\"Before\" type=\"Node2D\"]\n");

    const snapshot = await createSnapshot(root, ["scenes/main.tscn", "scripts/not-created-yet.gd"]);
    expect(snapshot.rootDir).toContain(path.join(root, ".godot-vibe", "snapshots"));
    expect(snapshot.files).toEqual(["scenes/main.tscn"]);
    expect(snapshot.absent).toEqual(["scripts/not-created-yet.gd"]);
    await access(path.join(snapshot.rootDir, "manifest.json"));
    await access(path.join(snapshot.rootDir, "scenes", "main.tscn"));

    await writeFile(scene, "[node name=\"After\" type=\"Node2D\"]\n", "utf8");
    await writeFileWithParents(path.join(root, "scripts", "not-created-yet.gd"), "extends Node\n");
    expect(await listSnapshots(root)).toEqual([snapshot]);
    const restored = await restoreSnapshot(root, snapshot.id);
    expect(restored.restored).toEqual(["scenes/main.tscn"]);
    expect(restored.removed).toEqual(["scripts/not-created-yet.gd"]);
    expect(restored.undoSnapshotId).not.toBe(snapshot.id);
    expect(await readFile(scene, "utf8")).toContain("Before");
    await expect(access(path.join(root, "scripts", "not-created-yet.gd"))).rejects.toThrow();

    const undone = await restoreSnapshot(root, restored.undoSnapshotId);
    expect(undone.restored).toEqual(["scenes/main.tscn", "scripts/not-created-yet.gd"]);
    expect(undone.removed).toEqual([]);
    expect(await readFile(scene, "utf8")).toContain("After");
    expect(await readFile(path.join(root, "scripts", "not-created-yet.gd"), "utf8"))
      .toBe("extends Node\n");
  });

  it("rejects snapshot reads and restores through symlinks that leave the project", async () => {
    const root = await project();
    const outside = await project();
    await writeFile(path.join(outside, "outside.gd"), "extends Node\n", "utf8");
    await symlink(outside, path.join(root, "escape"));
    await expect(createSnapshot(root, ["res://escape/outside.gd"])).rejects.toThrow("outside the Godot project");

    const scene = path.join(root, "scenes", "main.tscn");
    await writeFileWithParents(scene, "[node name=\"Safe\" type=\"Node\"]\n");
    const snapshot = await createSnapshot(root, ["scenes/main.tscn"]);
    await rm(path.join(root, "scenes"), { recursive: true });
    await symlink(outside, path.join(root, "scenes"));
    await expect(restoreSnapshot(root, snapshot.id)).rejects.toThrow("outside the Godot project");
    expect(await readFile(path.join(outside, "outside.gd"), "utf8")).toBe("extends Node\n");
  });

  it("publishes distinct complete snapshots when many are created in the same millisecond", async () => {
    const root = await project();
    await writeFileWithParents(path.join(root, "scripts", "player.gd"), "extends Node\n");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_723_456_789_000);
    let snapshots: Awaited<ReturnType<typeof createSnapshot>>[] = [];
    try {
      snapshots = await Promise.all(
        Array.from({ length: 24 }, () => createSnapshot(root, ["scripts/player.gd"]))
      );
    } finally {
      clock.mockRestore();
    }

    expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(snapshots.length);
    const listed = await listSnapshots(root);
    expect(new Set(listed.map((snapshot) => snapshot.id))).toEqual(
      new Set(snapshots.map((snapshot) => snapshot.id))
    );
    for (const snapshot of snapshots) {
      const entries = await readdir(snapshot.rootDir);
      expect(entries).toContain("manifest.json");
      expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
      const manifest = JSON.parse(await readFile(path.join(snapshot.rootDir, "manifest.json"), "utf8")) as { id: string };
      expect(manifest.id).toBe(snapshot.id);
    }
  });

  it("preflights every snapshot entry before changing project files", async () => {
    const root = await project();
    const first = path.join(root, "scripts", "first.gd");
    const second = path.join(root, "scripts", "second.gd");
    await writeFileWithParents(first, "first before\n");
    await writeFileWithParents(second, "second before\n");
    const snapshot = await createSnapshot(root, ["scripts/first.gd", "scripts/second.gd"]);
    await writeFile(first, "first after\n", "utf8");
    await writeFile(second, "second after\n", "utf8");
    await rm(path.join(snapshot.rootDir, "scripts", "second.gd"));
    await mkdir(path.join(snapshot.rootDir, "scripts", "second.gd"));

    await expect(restoreSnapshot(root, snapshot.id)).rejects.toThrow("not a regular file");
    expect(await readFile(first, "utf8")).toBe("first after\n");
    expect(await readFile(second, "utf8")).toBe("second after\n");
    expect(await listSnapshots(root)).toHaveLength(1);
  });

  it("rejects manifests that target generated state or claim a different id", async () => {
    const root = await project();
    await writeFileWithParents(path.join(root, "scripts", "player.gd"), "extends Node\n");
    const snapshot = await createSnapshot(root, ["scripts/player.gd"]);
    const manifestPath = path.join(snapshot.rootDir, "manifest.json");
    const original = JSON.parse(await readFile(manifestPath, "utf8"));

    await writeFile(manifestPath, JSON.stringify({ ...original, id: "different" }), "utf8");
    await expect(restoreSnapshot(root, snapshot.id)).rejects.toThrow("id does not match");

    await writeFile(manifestPath, JSON.stringify({
      ...original,
      files: [".godot-vibe/config.json"],
      absent: [],
    }), "utf8");
    await expect(restoreSnapshot(root, snapshot.id)).rejects.toThrow("invalid project path");

    await writeFile(manifestPath, JSON.stringify({
      ...original,
      files: ["scripts/../scripts/player.gd"],
      absent: [],
    }), "utf8");
    await expect(restoreSnapshot(root, snapshot.id)).rejects.toThrow("invalid project path");
  });

  it("appends JSONL actions and returns the newest bounded tail", async () => {
    const root = await project();
    await appendAction(root, { timestamp: 1, tool: "godot_create_node", result: "ok" });
    await appendAction(root, { timestamp: 2, tool: "godot_save_scene", result: "blocked", errorCode: "SAFETY_MODE_BLOCKED" });
    await appendAction(root, { timestamp: 3, tool: "godot_apply_text_edits", result: "ok", snapshotId: "snapshot-1" });

    expect(await readActions(root, 2)).toEqual([
      { timestamp: 2, tool: "godot_save_scene", result: "blocked", errorCode: "SAFETY_MODE_BLOCKED" },
      { timestamp: 3, tool: "godot_apply_text_edits", result: "ok", snapshotId: "snapshot-1" },
    ]);
    const raw = await readFile(path.join(root, ".godot-vibe", "action_log.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3);
  });

  it("returns empty history when no Godot Vibe state exists", async () => {
    const root = await project();
    expect(await listSnapshots(root)).toEqual([]);
    expect(await readActions(root)).toEqual([]);
  });
});

async function writeFileWithParents(file: string, contents: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}
