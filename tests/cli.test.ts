import { access, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_DISCOVERY_REL, PROTOCOL_VERSION } from "@gvibe/core";
import {
  dispatch,
  runBrain,
  runDoctor,
  runInit,
  runInstallAddon,
  runMcpConfig,
  runRestore,
  runSetup,
} from "@gvibe/cli";
import { markBrainDirty } from "@gvibe/project-brain";
import { createSnapshot, readActions } from "@gvibe/safety";
import { asGlobal, parseArgs, type GlobalOptions, type ParsedArgs } from "../apps/cli/src/options.js";
import { enableAddonInProjectFile, isAddonEnabledInProjectFile } from "../apps/cli/src/commands/installAddon.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix = "gvibe-cli-test-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function godotProject(): Promise<string> {
  const project = await temporaryDirectory();
  await writeFile(path.join(project, "project.godot"), [
    "; Engine configuration file.",
    "config_version=5",
    "",
    "[application]",
    'config/name="Test Platformer"',
    'run/main_scene="res://scenes/main.tscn"',
    'config/features=PackedStringArray("4.7", "GL Compatibility")',
    "",
    "[rendering]",
    'renderer/rendering_method="gl_compatibility"',
    "",
  ].join("\n"), "utf8");
  await mkdir(path.join(project, "scenes"), { recursive: true });
  await writeFile(path.join(project, "scenes", "main.tscn"), '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n', "utf8");
  await mkdir(path.join(project, "scripts"), { recursive: true });
  await writeFile(path.join(project, "scripts", "player.gd"), "class_name Player\nextends CharacterBody2D\n", "utf8");
  return project;
}

function options(project: string, extra: Partial<GlobalOptions> = {}): GlobalOptions {
  return { project, mock: true, json: false, ...extra };
}

function parsed(command: string, flags: ParsedArgs["flags"] = {}): ParsedArgs {
  return { command, positional: [], flags };
}

async function addonSource(): Promise<string> {
  const source = await temporaryDirectory("gvibe-addon-source-");
  await writeFile(path.join(source, "plugin.cfg"), [
    "[plugin]",
    'name="Godot Vibe OS"',
    'description="Local editor bridge"',
    'author="Foundry"',
    'version="0.1.0"',
    'script="plugin.gd"',
  ].join("\n") + "\n", "utf8");
  await writeFile(path.join(source, "plugin.gd"), "@tool\nextends EditorPlugin\n", "utf8");
  return source;
}

describe("CLI argument handling", () => {
  it("parses equals, separated values, booleans, and positional arguments", () => {
    expect(parseArgs([
      "doctor",
      "--project=/games/first",
      "--mock",
      "--format",
      "compact",
      "extra",
    ])).toEqual({
      command: "doctor",
      positional: ["extra"],
      flags: { project: "/games/first", mock: true, format: "compact" },
    });
    expect(parseArgs([])).toEqual({ command: "help", positional: [], flags: {} });
  });

  it("resolves global project and mock flags without mutating parsed args", () => {
    const input = parsed("doctor", { project: "/games/test", mock: "true", json: true });
    expect(asGlobal(input)).toEqual({ project: "/games/test", mock: true, json: true });
    expect(input.flags).toEqual({ project: "/games/test", mock: "true", json: true });
  });

  it("serves Godot-specific help and a useful unknown-command failure", async () => {
    const help = await dispatch(["help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Godot Vibe OS");
    expect(help.stdout).toContain("install-addon [--source]");
    expect(help.stdout).toContain("restore [snapshot-id]");
    expect(help.stdout).toContain("--project=<path>");
    expect(help.stdout).not.toContain("install-unity-package");

    const unknown = await dispatch(["make-magic"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("Unknown command: make-magic");
  });
});

describe("gvibe restore", () => {
  it("lists snapshots, restores one, and exposes a working undo snapshot", async () => {
    const project = await godotProject();
    const script = path.join(project, "scripts", "player.gd");
    const created = path.join(project, "scripts", "created.gd");
    const snapshot = await createSnapshot(project, ["scripts/player.gd", "scripts/created.gd"]);
    await writeFile(script, "extends Node\n# changed\n", "utf8");
    await writeFile(created, "extends Node\n", "utf8");

    const listed = await runRestore(options(project, { json: true }), parsed("restore"));
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout!).snapshots).toEqual([
      expect.objectContaining({ id: snapshot.id, files: ["scripts/player.gd"], absent: ["scripts/created.gd"] }),
    ]);

    const restored = await runRestore(
      options(project, { json: true }),
      { command: "restore", positional: [snapshot.id], flags: {} },
    );
    expect(restored.exitCode).toBe(0);
    const result = JSON.parse(restored.stdout!);
    expect(result).toMatchObject({
      id: snapshot.id,
      restored: ["scripts/player.gd"],
      removed: ["scripts/created.gd"],
      undoSnapshotId: expect.any(String),
    });
    expect(await readFile(script, "utf8")).toContain("class_name Player");
    await expect(access(created)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readActions(project)).toContainEqual(expect.objectContaining({
      tool: "gvibe_restore",
      args: { id: snapshot.id },
      result: "ok",
      snapshotId: result.undoSnapshotId,
    }));

    const undone = await runRestore(
      options(project, { json: true }),
      { command: "restore", positional: [result.undoSnapshotId], flags: {} },
    );
    expect(undone.exitCode).toBe(0);
    expect(await readFile(script, "utf8")).toContain("# changed");
    expect(await readFile(created, "utf8")).toBe("extends Node\n");
  });

  it("reports empty, invalid, missing, and extra-id requests without changing files", async () => {
    const project = await godotProject();
    expect(await runRestore(options(project), parsed("restore")))
      .toEqual({ exitCode: 0, stdout: "No snapshots found.\n" });

    const script = path.join(project, "scripts", "player.gd");
    const before = await readFile(script, "utf8");
    for (const id of ["../escape", "missing-snapshot"]) {
      const result = await runRestore(
        options(project),
        { command: "restore", positional: [id], flags: {} },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBeTruthy();
      expect(await readFile(script, "utf8")).toBe(before);
    }

    const extra = await runRestore(
      options(project),
      { command: "restore", positional: ["one", "two"], flags: {} },
    );
    expect(extra).toEqual({ exitCode: 2, stderr: "Usage: gvibe restore [snapshot-id]\n" });
  });
});

describe("gvibe init", () => {
  it("rejects directories that do not contain project.godot", async () => {
    const directory = await temporaryDirectory();
    const result = await runInit(options(directory));
    expect(result).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("Not a Godot project") });
  });

  it("creates .godot-vibe state and managed agent guidance", async () => {
    const project = await godotProject();
    const result = await runInit(options(project));
    expect(result.exitCode).toBe(0);
    await access(path.join(project, ".godot-vibe", "config.json"));
    await access(path.join(project, ".godot-vibe", "conventions.md"));
    const ignored = await readFile(path.join(project, ".gitignore"), "utf8");
    for (const entry of [".godot/", ".godot-vibe/action_log.jsonl", ".godot-vibe/brain/", ".godot-vibe/snapshots/", ".godot-vibe/write.lock*/"]) {
      expect(ignored).toContain(entry);
    }

    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const contents = await readFile(path.join(project, name), "utf8");
      expect(contents).toContain("<!-- BEGIN godot-vibe-os -->");
      expect(contents).toContain("godot_orient");
      expect(contents).toContain("godot_reflect");
      expect(contents).toContain("godot_verify");
      expect(contents).toContain("<!-- END godot-vibe-os -->");
    }
  });

  it("preserves user guidance and keeps one managed block across reruns", async () => {
    const project = await godotProject();
    await writeFile(path.join(project, "AGENTS.md"), "# Team rules\n\n- keep changes focused\n", "utf8");
    await writeFile(path.join(project, ".gitignore"), "build/\n", "utf8");
    await runInit(options(project));
    await runInit(options(project));
    const contents = await readFile(path.join(project, "AGENTS.md"), "utf8");
    expect(contents).toContain("keep changes focused");
    expect(contents.match(/<!-- BEGIN godot-vibe-os -->/g)).toHaveLength(1);
    expect(contents.match(/<!-- END godot-vibe-os -->/g)).toHaveLength(1);
    const ignored = await readFile(path.join(project, ".gitignore"), "utf8");
    expect(ignored).toContain("build/\n");
    expect(ignored.match(/^\.godot\/$/gm)).toHaveLength(1);
  });

  it("rejects a managed-file symlink without changing its external target", async () => {
    const project = await godotProject();
    const outside = await temporaryDirectory("gvibe-init-outside-");
    const target = path.join(outside, "AGENTS.md");
    await writeFile(target, "outside guidance\n", "utf8");
    await symlink(target, path.join(project, "AGENTS.md"));

    const result = await runInit(options(project));
    expect(result).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("resolves outside") });
    expect(await readFile(target, "utf8")).toBe("outside guidance\n");
    await expect(access(path.join(project, ".godot-vibe"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("gvibe install-addon", () => {
  it("copies the addon and enables it in project.godot idempotently", async () => {
    const project = await godotProject();
    const source = await addonSource();
    const args = parsed("install-addon", { source });

    const first = await runInstallAddon(options(project, { json: true }), args);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout!)).toMatchObject({
      source,
      destination: path.join(project, "addons", "godot_vibe_os"),
      enabled: true,
      projectFileChanged: true,
    });
    await access(path.join(project, "addons", "godot_vibe_os", "plugin.cfg"));
    await access(path.join(project, "addons", "godot_vibe_os", "plugin.gd"));
    let projectFile = await readFile(path.join(project, "project.godot"), "utf8");
    expect(projectFile).toContain("[editor_plugins]");
    expect(projectFile).toContain('enabled=PackedStringArray("res://addons/godot_vibe_os/plugin.cfg")');

    const second = await runInstallAddon(options(project, { json: true }), args);
    expect(JSON.parse(second.stdout!)).toMatchObject({ enabled: true, projectFileChanged: false });
    projectFile = await readFile(path.join(project, "project.godot"), "utf8");
    expect(projectFile.match(/res:\/\/addons\/godot_vibe_os\/plugin\.cfg/g)).toHaveLength(1);
  });

  it("adds itself to an existing plugin list without removing other addons", () => {
    const before = [
      "config_version=5",
      "",
      "[editor_plugins]",
      "",
      'enabled=PackedStringArray("res://addons/navigation_tools/plugin.cfg")',
      "",
      "[rendering]",
      'renderer/rendering_method="gl_compatibility"',
      "",
    ].join("\n");
    const plugin = "res://addons/godot_vibe_os/plugin.cfg";
    const after = enableAddonInProjectFile(before, plugin);
    expect(after).toContain("res://addons/navigation_tools/plugin.cfg");
    expect(after).toContain(plugin);
    expect(enableAddonInProjectFile(after, plugin)).toBe(after);
  });

  it("ignores plugin paths in comments and outside editor_plugins", () => {
    const plugin = "res://addons/godot_vibe_os/plugin.cfg";
    const before = [
      "[application]",
      `; ${plugin}`,
      "",
      "[editor_plugins]",
      `; enabled=PackedStringArray(${JSON.stringify(plugin)})`,
      'enabled=PackedStringArray("res://addons/other/plugin.cfg")',
      "",
    ].join("\n");
    expect(isAddonEnabledInProjectFile(before, plugin)).toBe(false);
    const after = enableAddonInProjectFile(before, plugin);
    expect(isAddonEnabledInProjectFile(after, plugin)).toBe(true);
    expect(after.match(/res:\/\/addons\/godot_vibe_os\/plugin\.cfg/g)).toHaveLength(3);
  });

  it("rejects a missing source without modifying the project", async () => {
    const project = await godotProject();
    const before = await readFile(path.join(project, "project.godot"), "utf8");
    const result = await runInstallAddon(options(project), parsed("install-addon", { source: path.join(project, "missing") }));
    expect(result).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("Could not locate") });
    expect(await readFile(path.join(project, "project.godot"), "utf8")).toBe(before);
  });

  it("rejects an addon parent symlink without writing outside the project", async () => {
    const project = await godotProject();
    const source = await addonSource();
    const outside = await temporaryDirectory("gvibe-addon-outside-");
    await symlink(outside, path.join(project, "addons"));

    const result = await runInstallAddon(options(project), parsed("install-addon", { source }));
    expect(result).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("resolves outside") });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("gvibe mcp-config", () => {
  it("prints a portable Godot MCP entry with absolute local paths", async () => {
    const project = await godotProject();
    const result = await runMcpConfig(options(project, { mock: false }), parsed("mcp-config"));
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(result.stdout!);
    const entry = config.mcpServers["godot-vibe-os"];
    expect(path.isAbsolute(entry.command)).toBe(true);
    expect(entry.args[0]).toMatch(/apps\/cli\/bin\/gvibe$/);
    expect(entry.args[1]).toBe("serve");
    expect(entry.env).toEqual({ GVIBE_PROJECT: project });
  });

  it("supports bare global installs, mock state, and Codex TOML", async () => {
    const project = await godotProject();
    const bare = await runMcpConfig(options(project, { mock: true }), parsed("mcp-config", { bare: true }));
    const entry = JSON.parse(bare.stdout!).mcpServers["godot-vibe-os"];
    expect(entry).toEqual({ command: "gvibe", args: ["serve"], env: { GVIBE_PROJECT: project, GVIBE_MOCK: "1" } });

    const codex = await runMcpConfig(options(project), parsed("mcp-config", { target: "codex" }));
    expect(codex.stdout).toContain("[mcp_servers.godot_vibe_os]");
    expect(codex.stdout).toContain("tool_timeout_sec = 300");
    expect(codex.stdout).toContain("[mcp_servers.godot_vibe_os.env]");
    expect(codex.stdout).toContain(`GVIBE_PROJECT = ${JSON.stringify(project)}`);
  });

  it("merges .mcp.json without deleting unrelated servers", async () => {
    const project = await godotProject();
    const file = path.join(project, ".mcp.json");
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: "other", args: [], env: {} } } }), "utf8");
    const result = await runMcpConfig(options(project, { json: true }), parsed("mcp-config", { write: true }));
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(await readFile(file, "utf8"));
    expect(config.mcpServers.other.command).toBe("other");
    expect(config.mcpServers["godot-vibe-os"].env.GVIBE_PROJECT).toBe(project);
    expect((await readdir(project)).some((name) => name.startsWith(".mcp.json.") && name.endsWith(".tmp"))).toBe(false);
  });

  it("creates a missing file but never overwrites malformed or unreadable state", async () => {
    const project = await godotProject();
    const file = path.join(project, ".mcp.json");
    const created = await runMcpConfig(options(project), parsed("mcp-config", { write: true }));
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty("mcpServers.godot-vibe-os");

    const malformed = "{ not-json\n";
    await writeFile(file, malformed, "utf8");
    const rejected = await runMcpConfig(options(project), parsed("mcp-config", { write: true }));
    expect(rejected).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("not valid JSON") });
    expect(await readFile(file, "utf8")).toBe(malformed);

    await rm(file);
    await mkdir(file);
    const unreadable = await runMcpConfig(options(project), parsed("mcp-config", { write: true }));
    expect(unreadable).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("could not be read") });
    expect((await stat(file)).isDirectory()).toBe(true);
  });

  it("rejects a config symlink without reading or replacing its external target", async () => {
    const project = await godotProject();
    const outside = await temporaryDirectory("gvibe-mcp-outside-");
    const target = path.join(outside, "config.json");
    const original = JSON.stringify({ mcpServers: { external: { command: "leave-me" } } }) + "\n";
    await writeFile(target, original, "utf8");
    await symlink(target, path.join(project, ".mcp.json"));

    const result = await runMcpConfig(options(project), parsed("mcp-config", { write: true }));
    expect(result).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("resolves outside") });
    expect(await readFile(target, "utf8")).toBe(original);
    expect((await lstat(path.join(project, ".mcp.json"))).isSymbolicLink()).toBe(true);
  });
});

describe("gvibe setup", () => {
  it("stops before writing when generated state would traverse a parent symlink", async () => {
    const project = await godotProject();
    const source = await addonSource();
    const outside = await temporaryDirectory("gvibe-setup-outside-");
    await symlink(outside, path.join(project, ".godot-vibe"));

    const result = await runSetup(options(project), parsed("setup", { source }));
    expect(result).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("resolves outside") });
    expect(await readdir(outside)).toEqual([]);
    await expect(access(path.join(project, "addons"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("gvibe doctor mock", () => {
  it("does not read project.godot through a symlink outside the project", async () => {
    const project = await temporaryDirectory();
    const outside = await temporaryDirectory("gvibe-doctor-project-outside-");
    const secret = "External Doctor Project Must Not Leak";
    const external = path.join(outside, "project.godot");
    await writeFile(external, `config_version=5\n[application]\nconfig/name="${secret}"\n`, "utf8");
    await symlink(external, path.join(project, "project.godot"));

    const result = await runDoctor(options(project, { mock: true, json: true }));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain(secret);
    expect(JSON.parse(result.stdout!)).toMatchObject({ project: { valid: false }, ok: false });
  });

  it("never prints the live bridge token in JSON diagnostics", async () => {
    const project = await godotProject();
    const token = "doctor-token-that-must-never-leak-123456789012345";
    const discovery = path.join(project, BRIDGE_DISCOVERY_REL);
    await mkdir(path.dirname(discovery), { recursive: true });
    await writeFile(discovery, JSON.stringify({
      host: "127.0.0.1",
      port: 65534,
      projectPath: project,
      godotVersion: "4.7.1.stable.official",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: Date.now(),
      token,
    }), "utf8");

    const result = await runDoctor(options(project, { mock: false, json: true }));

    expect(result.stdout).not.toContain(token);
    const report = JSON.parse(result.stdout!);
    expect(report.bridge.discovery).toMatchObject({ host: "127.0.0.1", port: 65534, projectPath: await realpath(project) });
    expect(report.bridge.discovery).not.toHaveProperty("token");
  });

  it("observes a fully initialized Godot project without claiming a live editor", async () => {
    const project = await godotProject();
    const source = await addonSource();
    await runInit(options(project));
    await runInstallAddon(options(project), parsed("install-addon", { source }));
    const brain = await runBrain(options(project), parsed("brain"));
    expect(brain.exitCode).toBe(0);

    const result = await runDoctor(options(project, { mock: true, json: true }));
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout!);
    expect(report).toMatchObject({
      project: { path: project, valid: true, name: "Test Platformer" },
      config: { exists: true },
      godotAddon: { detected: true, enabled: true },
      bridge: { reachable: false, state: "mock", host: "127.0.0.1", port: 38588 },
      brain: { exists: true, stale: false },
      ok: true,
      suggestions: [],
    });
  });

  it("reports concrete repairs for an uninitialized project", async () => {
    const project = await godotProject();
    const result = await runDoctor(options(project, { mock: true, json: true }));
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout!);
    expect(report.ok).toBe(false);
    expect(report.suggestions).toEqual([
      "Run `gvibe init`.",
      "Run `gvibe install-addon`.",
      "Run `gvibe brain`.",
    ]);
  });

  it("returns a failing status in human-readable mode when the project is not ready", async () => {
    const project = await godotProject();
    const result = await runDoctor(options(project, { mock: true }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Next:");
  });

  it("does not accept a stale project brain as ready", async () => {
    const project = await godotProject();
    const source = await addonSource();
    await runInit(options(project));
    await runInstallAddon(options(project), parsed("install-addon", { source }));
    await runBrain(options(project), parsed("brain"));
    await markBrainDirty(project, "res://scripts/player.gd changed");

    const result = await runDoctor(options(project, { mock: true, json: true }));
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout!);
    expect(report).toMatchObject({ brain: { exists: true, stale: true }, ok: false });
    expect(report.suggestions).toContain("Run `gvibe brain --ensure`.");
  });

  it("detects an external project edit without regenerating the brain", async () => {
    const project = await godotProject();
    const source = await addonSource();
    await runInit(options(project));
    await runInstallAddon(options(project), parsed("install-addon", { source }));
    await runBrain(options(project), parsed("brain"));
    const manifestPath = path.join(project, ".godot-vibe", "brain", "manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");
    await writeFile(path.join(project, "scripts", "player.gd"), "class_name Player\nextends CharacterBody2D\n# external edit\n", "utf8");

    const result = await runDoctor(options(project, { mock: true, json: true }));

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout!);
    expect(report).toMatchObject({ brain: { exists: true, stale: true, reason: "changed" }, ok: false });
    expect(report.suggestions).toContain("Run `gvibe brain --ensure`.");
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
  });

  it("does not treat a commented plugin path as enabled", async () => {
    const project = await godotProject();
    const source = await addonSource();
    await runInstallAddon(options(project), parsed("install-addon", { source }));
    const projectFile = path.join(project, "project.godot");
    const contents = await readFile(projectFile, "utf8");
    await writeFile(projectFile, contents.replace(/^enabled=/m, "; enabled="), "utf8");

    const result = await runDoctor(options(project, { mock: true, json: true }));
    const report = JSON.parse(result.stdout!);
    expect(report.godotAddon).toMatchObject({ detected: true, enabled: false });
    expect(report.suggestions).toContain("Enable Godot Vibe OS in Project > Project Settings > Plugins.");
  });
});
