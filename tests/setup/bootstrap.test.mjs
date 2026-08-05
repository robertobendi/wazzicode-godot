import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADDON_RESOURCE_PATH,
  GUIDANCE_BEGIN,
  GUIDANCE_END,
  IGNORE_BEGIN,
  SERVER_NAME,
  SetupError,
  buildMcpEntry,
  enablePluginInProjectGodot,
  mergeMcpConfig,
  parseArgs,
  resolveGodotProject,
  runBootstrap,
  upsertMarkedBlock,
} from "../../bootstrap.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = path.resolve(THIS_DIR, "..", "..", "bootstrap.mjs");

async function makeFixture(t, { mcp = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wazzicode-godot-setup-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const repo = path.join(root, "server");
  const project = path.join(root, "game");
  const addon = path.join(repo, "plugin", "addons", "godot_ai");
  await mkdir(addon, { recursive: true });
  await mkdir(path.join(repo, "src", "godot_ai"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(addon, "plugin.cfg"),
    '[plugin]\nname="Godot AI"\nscript="plugin.gd"\n',
    "utf8",
  );
  await writeFile(path.join(addon, "plugin.gd"), "@tool\nextends EditorPlugin\n", "utf8");
  await writeFile(
    path.join(project, "project.godot"),
    '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Fixture Game"\n',
    "utf8",
  );
  if (mcp !== null) {
    await writeFile(path.join(project, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
  }
  return { root, repo, project, addon };
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

test("parseArgs supports project, copy, dry-run, and rejects ambiguous input", () => {
  assert.deepEqual(parseArgs(["/game", "--copy", "--dry-run"], {}), {
    project: "/game",
    mode: "copy",
    dryRun: true,
    help: false,
  });
  assert.equal(parseArgs([], { WAZZICODE_GODOT_PROJECT: "/from-env" }).project, "/from-env");
  assert.throws(() => parseArgs(["one", "two"], {}), SetupError);
  assert.throws(() => parseArgs(["one", "--project", "two"], {}), SetupError);
  assert.throws(() => parseArgs(["--unknown"], {}), /Unknown option/);
});

test("resolveGodotProject accepts project.godot and auto-detects from a nested directory", async (t) => {
  const { project } = await makeFixture(t);
  const nested = path.join(project, "scenes", "levels");
  await mkdir(nested, { recursive: true });
  assert.equal(await resolveGodotProject(null, nested), await realpath(project));
  assert.equal(await resolveGodotProject(path.join(project, "project.godot")), await realpath(project));
});

test("enablePluginInProjectGodot preserves existing settings and plugins", () => {
  const original = [
    "; user comment",
    "config_version=5",
    "",
    "[editor_plugins]",
    'enabled = PackedStringArray("res://addons/other/plugin.cfg") ; keep this comment',
    "",
    "[rendering]",
    'renderer/rendering_method="gl_compatibility"',
    "",
  ].join("\r\n");
  const updated = enablePluginInProjectGodot(original);
  assert.match(updated, /res:\/\/addons\/other\/plugin\.cfg/);
  assert.match(updated, /res:\/\/addons\/godot_ai\/plugin\.cfg/);
  assert.match(updated, /; keep this comment/);
  assert.match(updated, /renderer\/rendering_method="gl_compatibility"/);
  assert.ok(updated.includes("\r\n"));
  assert.equal(enablePluginInProjectGodot(updated), updated);
});

test("enablePluginInProjectGodot refuses an enabled value it cannot safely merge", () => {
  assert.throws(
    () => enablePluginInProjectGodot("[editor_plugins]\nenabled=Array[PluginConfig]()\n"),
    /Refusing to replace/,
  );
});

test("marked blocks preserve user bytes outside the managed section", () => {
  const begin = "<!-- BEGIN demo -->";
  const end = "<!-- END demo -->";
  const block1 = `${begin}\nmanaged one\n${end}`;
  const block2 = `${begin}\nmanaged two\n${end}`;
  const userPrefix = "# User rules  \r\n\r\nKeep this.\r\n";
  const inserted = upsertMarkedBlock(userPrefix, begin, end, block1);
  assert.ok(inserted.startsWith(userPrefix));
  assert.ok(inserted.includes("managed one"));
  const updated = upsertMarkedBlock(inserted, begin, end, block2);
  assert.ok(updated.startsWith(userPrefix));
  assert.ok(updated.includes("managed two"));
  assert.ok(!updated.includes("managed one"));
  assert.equal(occurrences(updated, begin), 1);
  assert.throws(
    () => upsertMarkedBlock(`${begin}\nmissing end`, begin, end, block1),
    /incomplete or duplicated/,
  );
});

test("mergeMcpConfig preserves unrelated entries and user-owned fields", () => {
  const existing = {
    customTopLevel: true,
    mcpServers: {
      unrelated: { command: "other" },
      [SERVER_NAME]: {
        command: "stale",
        url: "http://stale.invalid",
        type: "http",
        env: { KEEP_ME: "yes", GODOT_AI_DISABLE_TELEMETRY: "false" },
        disabled: true,
      },
    },
  };
  const entry = buildMcpEntry("/server", "/server/.venv/bin/python");
  const merged = mergeMcpConfig(existing, entry);
  assert.equal(merged.customTopLevel, true);
  assert.deepEqual(merged.mcpServers.unrelated, { command: "other" });
  assert.equal(merged.mcpServers[SERVER_NAME].disabled, true);
  assert.equal(merged.mcpServers[SERVER_NAME].env.KEEP_ME, "yes");
  assert.equal(merged.mcpServers[SERVER_NAME].env.GODOT_AI_DISABLE_TELEMETRY, "true");
  assert.ok(!("url" in merged.mcpServers[SERVER_NAME]));
  assert.ok(!("type" in merged.mcpServers[SERVER_NAME]));
  assert.deepEqual(existing.mcpServers[SERVER_NAME].env, {
    KEEP_ME: "yes",
    GODOT_AI_DISABLE_TELEMETRY: "false",
  });
});

test("copy-mode bootstrap is idempotent and preserves project content", async (t) => {
  const fixture = await makeFixture(t, {
    mcp: { mcpServers: { existing: { command: "existing-server" } }, userSetting: 7 },
  });
  await writeFile(path.join(fixture.project, "AGENTS.md"), "# Existing agent rules\n\nDo not remove.\n", "utf8");
  await writeFile(path.join(fixture.project, "CLAUDE.md"), "# Existing Claude rules\n", "utf8");
  await writeFile(path.join(fixture.project, ".gitignore"), "/user-cache/\n", "utf8");

  const options = {
    repoRoot: fixture.repo,
    projectPath: fixture.project,
    mode: "copy",
    skipDependencies: true,
  };
  await runBootstrap(options);

  const projectGodot = await readFile(path.join(fixture.project, "project.godot"), "utf8");
  assert.equal(occurrences(projectGodot, ADDON_RESOURCE_PATH), 1);
  assert.match(projectGodot, /config\/name="Fixture Game"/);
  assert.equal((await readFile(path.join(fixture.project, "addons", "godot_ai", "plugin.gd"), "utf8")), "@tool\nextends EditorPlugin\n");

  const mcp = JSON.parse(await readFile(path.join(fixture.project, ".mcp.json"), "utf8"));
  assert.equal(mcp.userSetting, 7);
  assert.equal(mcp.mcpServers.existing.command, "existing-server");
  assert.equal(
    mcp.mcpServers[SERVER_NAME].command,
    process.platform === "win32"
      ? path.join(fixture.repo, ".venv", "Scripts", "python.exe")
      : path.join(fixture.repo, ".venv", "bin", "python"),
  );
  assert.deepEqual(mcp.mcpServers[SERVER_NAME].args, [
    "-m",
    "godot_ai",
    "attach",
    "--disable-telemetry",
  ]);
  assert.equal(mcp.mcpServers[SERVER_NAME].env.GODOT_AI_DISABLE_TELEMETRY, "true");
  assert.equal(mcp.mcpServers[SERVER_NAME].env.PYTHONPATH, path.join(fixture.repo, "src"));

  const agents = await readFile(path.join(fixture.project, "AGENTS.md"), "utf8");
  const claude = await readFile(path.join(fixture.project, "CLAUDE.md"), "utf8");
  assert.ok(agents.startsWith("# Existing agent rules\n\nDo not remove.\n"));
  assert.ok(claude.startsWith("# Existing Claude rules\n"));
  assert.equal(occurrences(agents, GUIDANCE_BEGIN), 1);
  assert.equal(occurrences(agents, GUIDANCE_END), 1);

  const gitignore = await readFile(path.join(fixture.project, ".gitignore"), "utf8");
  assert.ok(gitignore.startsWith("/user-cache/\n"));
  assert.equal(occurrences(gitignore, IGNORE_BEGIN), 1);
  assert.match(gitignore, /\/\.wazzicode-godot\/runtime\//);
  assert.match(gitignore, /\/addons\/godot_ai\//);

  const config = JSON.parse(
    await readFile(path.join(fixture.project, ".wazzicode-godot", "config.json"), "utf8"),
  );
  assert.equal(config.addon.mode, "copy");
  assert.equal(config.serverName, SERVER_NAME);
  assert.equal(config.telemetryEnabled, false);

  const before = {
    projectGodot,
    mcp: await readFile(path.join(fixture.project, ".mcp.json"), "utf8"),
    agents,
    claude,
    gitignore,
    config: await readFile(path.join(fixture.project, ".wazzicode-godot", "config.json"), "utf8"),
  };
  await runBootstrap(options);
  await assert.rejects(
    stat(path.join(fixture.project, "addons", "godot_ai", "godot_ai")),
    /ENOENT/,
  );
  assert.deepEqual(
    {
      projectGodot: await readFile(path.join(fixture.project, "project.godot"), "utf8"),
      mcp: await readFile(path.join(fixture.project, ".mcp.json"), "utf8"),
      agents: await readFile(path.join(fixture.project, "AGENTS.md"), "utf8"),
      claude: await readFile(path.join(fixture.project, "CLAUDE.md"), "utf8"),
      gitignore: await readFile(path.join(fixture.project, ".gitignore"), "utf8"),
      config: await readFile(path.join(fixture.project, ".wazzicode-godot", "config.json"), "utf8"),
    },
    before,
  );
});

test("default link mode creates a working directory link and reruns safely", async (t) => {
  const fixture = await makeFixture(t);
  const options = {
    repoRoot: fixture.repo,
    projectPath: fixture.project,
    mode: "link",
    skipDependencies: true,
  };
  await runBootstrap(options);
  const linkedPlugin = path.join(fixture.project, "addons", "godot_ai", "plugin.gd");
  assert.equal(await readFile(linkedPlugin, "utf8"), "@tool\nextends EditorPlugin\n");
  await runBootstrap(options);
  assert.equal(await readFile(linkedPlugin, "utf8"), "@tool\nextends EditorPlugin\n");
});

test("dry-run validates but leaves the project byte-for-byte untouched", async (t) => {
  const fixture = await makeFixture(t);
  const projectFile = path.join(fixture.project, "project.godot");
  const before = await readFile(projectFile, "utf8");
  await runBootstrap({
    repoRoot: fixture.repo,
    projectPath: fixture.project,
    mode: "copy",
    dryRun: true,
    skipDependencies: true,
  });
  assert.equal(await readFile(projectFile, "utf8"), before);
  await assert.rejects(readFile(path.join(fixture.project, ".mcp.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(fixture.project, "AGENTS.md"), "utf8"), /ENOENT/);
  await assert.rejects(stat(path.join(fixture.project, "addons", "godot_ai")), /ENOENT/);
});

test("invalid user MCP JSON and unmanaged addon content are never overwritten", async (t) => {
  const invalidJson = await makeFixture(t);
  await writeFile(path.join(invalidJson.project, ".mcp.json"), "{not-json", "utf8");
  await assert.rejects(
    runBootstrap({
      repoRoot: invalidJson.repo,
      projectPath: invalidJson.project,
      mode: "copy",
      skipDependencies: true,
    }),
    /Refusing to overwrite invalid/,
  );
  assert.equal(await readFile(path.join(invalidJson.project, ".mcp.json"), "utf8"), "{not-json");

  const unmanaged = await makeFixture(t);
  const destination = path.join(unmanaged.project, "addons", "godot_ai");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "user-file.gd"), "# user content\n", "utf8");
  await assert.rejects(
    runBootstrap({
      repoRoot: unmanaged.repo,
      projectPath: unmanaged.project,
      mode: "link",
      skipDependencies: true,
    }),
    /unmanaged content/,
  );
  assert.equal(await readFile(path.join(destination, "user-file.gd"), "utf8"), "# user content\n");
});

test("setup refuses to target its own server repository", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.repo, "project.godot"), "config_version=5\n", "utf8");
  await assert.rejects(
    runBootstrap({
      repoRoot: fixture.repo,
      projectPath: fixture.repo,
      skipDependencies: true,
    }),
    /Refusing to use the WazziCode server repository/,
  );
});

test("setup rejects a managed-directory link that escapes the project", async (t) => {
  const fixture = await makeFixture(t);
  const outside = path.join(fixture.root, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    path.join(fixture.project, ".wazzicode-godot"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    runBootstrap({
      repoRoot: fixture.repo,
      projectPath: fixture.project,
      mode: "copy",
      skipDependencies: true,
    }),
    /directory link outside/,
  );
});

test("CLI help exits successfully without requiring a project", () => {
  const result = spawnSync(process.execPath, [BOOTSTRAP, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--copy/);
});
