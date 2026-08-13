import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit, runBrain, runDoctor, runVerify, runMcpConfig, runInstallUnityPackage, runSetup, runAutonomy } from "@uvibe/cli";
import type { GlobalOptions } from "../apps/cli/src/options.js";

const FIXTURE = path.resolve("tests/fixtures/sample-unity-project");
let workDir: string;

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-cli-test-"));
  await copyDir(FIXTURE, workDir);
});

afterAll(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

function g(extra: Partial<GlobalOptions> = {}): GlobalOptions {
  return { project: workDir, mock: true, json: false, ...extra };
}

describe("cli/init", () => {
  it("creates config.json, conventions.md, CLAUDE.md, and AGENTS.md", async () => {
    const r = await runInit(g());
    expect(r.exitCode).toBe(0);
    await fs.access(path.join(workDir, ".unity-vibe", "config.json"));
    await fs.access(path.join(workDir, ".unity-vibe", "conventions.md"));
    await fs.access(path.join(workDir, "CLAUDE.md"));
    const agents = await fs.readFile(path.join(workDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- BEGIN unity-vibe-os -->");
    expect(agents).toContain("unity_inspect_selected");
  });
});

describe("cli/brain", () => {
  it("writes brain files", async () => {
    const r = await runBrain(g());
    expect(r.exitCode).toBe(0);
    await fs.access(path.join(workDir, ".unity-vibe", "project_brain.md"));
    await fs.access(path.join(workDir, ".unity-vibe", "project_brain.json"));
    await fs.access(path.join(workDir, ".unity-vibe", "claude_context.md"));
    expect(r.stdout).toContain("scenes:");
  });

  it("reconciles freshness without rebuilding an unchanged map", async () => {
    const r = await runBrain(g(), {
      command: "brain",
      positional: [],
      flags: { ensure: true },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("freshness:current");
    expect(r.stdout).toContain("refreshed:no");
  });
});

describe("cli/doctor", () => {
  it("does not crash without Unity bridge", async () => {
    const r = await runDoctor(g());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Doctor");
    expect(r.stdout).toContain("Unity bridge:");
  });

  it("emits JSON when requested", async () => {
    const r = await runDoctor(g({ json: true }));
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout!);
    expect(obj.product?.name).toBeDefined();
    expect(obj.bridge?.reachable).toBe(false);
  });

  it("honors bridge.json port discovery (reachable on a non-default port)", async () => {
    const { project, server, close } = await startFakeBridge((projectDir) => projectDir);
    try {
      const r = await runDoctor({ project, mock: false, json: true });
      const obj = JSON.parse(r.stdout!);
      expect(obj.bridge.reachable).toBe(true);
      expect(obj.bridge.port).toBe((server.address() as { port: number }).port);
      expect(obj.bridge.port).not.toBe(38578);
    } finally {
      await close();
    }
  });

  it("rejects an Editor serving a different project (identity mismatch)", async () => {
    const { project, close } = await startFakeBridge(() => "/somewhere/else");
    try {
      const r = await runDoctor({ project, mock: false, json: true });
      const obj = JSON.parse(r.stdout!);
      expect(obj.bridge.reachable).toBe(false);
      expect(String(obj.bridge.error)).toContain("PROJECT_IDENTITY_MISMATCH");
    } finally {
      await close();
    }
  });
});

/**
 * Boot an ephemeral HTTP server acting as the Unity bridge on a random port and
 * write a matching Library/UnityVibeOS/bridge.json into a fresh temp project.
 * `answerAs` decides which projectPath the fake Editor claims to serve.
 */
async function startFakeBridge(answerAs: (projectDir: string) => string) {
  const http = await import("node:http");
  const { BRIDGE_DISCOVERY_REL } = await import("@uvibe/core");
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-doctor-bridge-"));
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({
      id: "doctor",
      ok: true,
      result: { status: "ok" },
      error: null,
      meta: { unityVersion: "6000.0.0f1", projectPath: answerAs(project), durationMs: 1 },
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const discoPath = path.join(project, BRIDGE_DISCOVERY_REL);
  await fs.mkdir(path.dirname(discoPath), { recursive: true });
  await fs.writeFile(
    discoPath,
    JSON.stringify({ port, host: "127.0.0.1", projectPath: project, unityVersion: "6000.0.0f1", pid: 1, protocolVersion: "1", startedAt: Date.now() }),
    "utf8"
  );
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(project, { recursive: true, force: true });
  };
  return { project, server, close };
}

describe("cli/verify", () => {
  it("passes all MVP acceptance checks against the mock bridge", async () => {
    const r = await runVerify(g({ json: true }));
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout!);
    expect(obj.failed).toBe(0);
    expect(obj.passed).toBe(obj.total);
    expect(obj.total).toBeGreaterThanOrEqual(10);
  });
});

describe("cli/mcp-config", () => {
  it("emits a valid MCP config snippet using absolute paths by default", async () => {
    const r = await runMcpConfig(g({ json: true }), { command: "mcp-config", positional: [], flags: {} });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout!);
    const entry = obj.mcpServers["unity-vibe-os"];
    // Default mode resolves absolute paths so PATH is irrelevant.
    expect(path.isAbsolute(entry.command)).toBe(true);
    expect(entry.args[1]).toBe("serve");
    expect(entry.env.UVIBE_PROJECT).toBe(workDir);
  });

  it("respects --bare for users who linked uvibe globally", async () => {
    const r = await runMcpConfig(g({ json: true }), {
      command: "mcp-config",
      positional: [],
      flags: { bare: true },
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout!);
    expect(obj.mcpServers["unity-vibe-os"].command).toBe("uvibe");
    expect(obj.mcpServers["unity-vibe-os"].args).toEqual(["serve"]);
  });

  it("emits a TOML block for --target=codex, quoted so Windows paths survive", async () => {
    const r = await runMcpConfig(g({ json: false }), {
      command: "mcp-config",
      positional: [],
      flags: { target: "codex" },
    });
    expect(r.exitCode).toBe(0);
    const out = r.stdout!;

    // Bare TOML key — Codex can't take the hyphenated `unity-vibe-os`.
    expect(out).toContain("[mcp_servers.unity_vibe_os]");
    expect(out).toContain("[mcp_servers.unity_vibe_os.env]");
    expect(out).toContain(`UVIBE_PROJECT = '${workDir}'`);
    // Unity calls are slow; the default per-tool timeout would cut them off.
    expect(out).toContain("tool_timeout_sec = 900");
    // The CLI one-liner that writes the user's config for them.
    expect(out).toContain("codex mcp add unity_vibe_os");

    // The whole point of literal strings: a backslash must NOT be escaped, and
    // must NOT appear inside a basic (double-quoted) string, where `\U` in
    // `C:\Users\…` is an invalid TOML escape and the config fails to parse.
    const commandLine = out.split("\n").find((l) => l.startsWith("command = "))!;
    expect(commandLine).toMatch(/^command = '.*'$/);
    expect(commandLine).not.toContain("\\\\");
  });
});

describe("cli/setup", () => {
  it("orchestrates init + install-unity-package + brain + .mcp.json + doctor in one call", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-setup-"));
    try {
      // Build a minimal Unity project shape.
      await fs.mkdir(path.join(tmp, "Assets", "Scenes"), { recursive: true });
      await fs.mkdir(path.join(tmp, "ProjectSettings"), { recursive: true });
      await fs.mkdir(path.join(tmp, "Packages"), { recursive: true });
      await fs.writeFile(
        path.join(tmp, "ProjectSettings", "ProjectVersion.txt"),
        "m_EditorVersion: 2022.3.42f1\n"
      );
      await fs.writeFile(
        path.join(tmp, "Packages", "manifest.json"),
        JSON.stringify({ dependencies: {} }, null, 2)
      );
      await fs.writeFile(path.join(tmp, "Assets", "Scenes", "Sample.unity"), "%YAML 1.1\n");

      const r = await runSetup(
        { project: tmp, mock: false, json: false },
        { command: "setup", positional: [], flags: {} }
      );
      expect(r.exitCode).toBe(0);

      // .unity-vibe scaffold exists
      for (const f of ["config.json", "conventions.md", "project_brain.md", "project_brain.json", "claude_context.md"]) {
        await fs.access(path.join(tmp, ".unity-vibe", f));
      }
      // Package embedded as a portable copy (auto-discovered; no machine-specific manifest entry)
      await fs.access(path.join(tmp, "Packages", "com.uvibe.os", "package.json"));
      const manifest = JSON.parse(await fs.readFile(path.join(tmp, "Packages", "manifest.json"), "utf8"));
      expect(manifest.dependencies["com.uvibe.os"]).toBeUndefined();
      // .mcp.json written with absolute paths
      const mcp = JSON.parse(await fs.readFile(path.join(tmp, ".mcp.json"), "utf8"));
      expect(mcp.mcpServers["unity-vibe-os"]).toBeDefined();
      const entry = mcp.mcpServers["unity-vibe-os"];
      expect(typeof entry.command).toBe("string");
      expect(entry.args[0]).toMatch(/uvibe$/);
      expect(entry.args[1]).toBe("serve");
      expect(entry.env.UVIBE_PROJECT).toBe(tmp);
      // CLAUDE.md written with marker block
      const cmd = await fs.readFile(path.join(tmp, "CLAUDE.md"), "utf8");
      expect(cmd).toContain("<!-- BEGIN unity-vibe-os -->");
      expect(cmd).toContain("<!-- END unity-vibe-os -->");
      expect(cmd).toContain("unity_inspect_selected");
      expect(cmd).toContain("unity_capture_game_view");
      // Codex automatically discovers AGENTS.md from the project root.
      const agents = await fs.readFile(path.join(tmp, "AGENTS.md"), "utf8");
      expect(agents).toContain("<!-- BEGIN unity-vibe-os -->");
      expect(agents).toContain("unity_inspect_selected");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-Unity project paths", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-setup-bad-"));
    try {
      const r = await runSetup(
        { project: tmp, mock: false, json: false },
        { command: "setup", positional: [], flags: {} }
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Not a Unity project");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("cli/init re-runs preserve user content in CLAUDE.md", () => {
  it("inserts and updates a marker-delimited block; appends if file existed", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-init-claude-"));
    try {
      await fs.mkdir(path.join(tmp, ".unity-vibe"), { recursive: true });
      const claudeMd = path.join(tmp, "CLAUDE.md");
      await fs.writeFile(claudeMd, "# CLAUDE.md\n\n## My existing rules\n\n- never delete code\n", "utf8");

      // First run: appends block.
      let r = await runInit({ project: tmp, mock: false, json: false });
      expect(r.exitCode).toBe(0);
      let after = await fs.readFile(claudeMd, "utf8");
      expect(after).toContain("never delete code"); // user content preserved
      expect(after).toContain("<!-- BEGIN unity-vibe-os -->");

      // Second run: updates the block in-place; user content still preserved.
      r = await runInit({ project: tmp, mock: false, json: false });
      expect(r.exitCode).toBe(0);
      after = await fs.readFile(claudeMd, "utf8");
      expect(after).toContain("never delete code");
      expect((after.match(/<!-- BEGIN unity-vibe-os -->/g) ?? []).length).toBe(1); // only one block
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("cli/init re-runs preserve user content in AGENTS.md", () => {
  it("appends once and updates only the managed Codex guidance", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-init-agents-"));
    try {
      await fs.mkdir(path.join(tmp, ".unity-vibe"), { recursive: true });
      const agentsMd = path.join(tmp, "AGENTS.md");
      await fs.writeFile(agentsMd, "# Team rules\n\n- keep commits focused\n", "utf8");

      await runInit({ project: tmp, mock: false, json: false });
      await runInit({ project: tmp, mock: false, json: false });

      const after = await fs.readFile(agentsMd, "utf8");
      expect(after).toContain("keep commits focused");
      expect(after).toContain("unity_capture_game_view");
      expect((after.match(/<!-- BEGIN unity-vibe-os -->/g) ?? []).length).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("cli/mcp-config --write", () => {
  it("writes .mcp.json with absolute uvibe path and merges with existing entries", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-mcpwrite-"));
    try {
      // Pre-existing .mcp.json with an unrelated server.
      await fs.writeFile(
        path.join(tmp, ".mcp.json"),
        JSON.stringify({ mcpServers: { other: { command: "x", args: [], env: {} } } }, null, 2)
      );
      const r = await runMcpConfig(
        { project: tmp, mock: false, json: true },
        { command: "mcp-config", positional: [], flags: { write: true } }
      );
      expect(r.exitCode).toBe(0);
      const cfg = JSON.parse(await fs.readFile(path.join(tmp, ".mcp.json"), "utf8"));
      expect(cfg.mcpServers.other.command).toBe("x"); // preserved
      const entry = cfg.mcpServers["unity-vibe-os"];
      expect(entry.args[1]).toBe("serve");
      expect(entry.env.UVIBE_PROJECT).toBe(tmp);
      // command must be an absolute path to a node binary (not bare "uvibe")
      expect(entry.command).not.toBe("uvibe");
      expect(path.isAbsolute(entry.command)).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("cli/install-unity-package", () => {
  it("appends com.uvibe.os to a Unity project's Packages/manifest.json", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-install-"));
    try {
      await fs.mkdir(path.join(tmp, "Assets"), { recursive: true });
      await fs.mkdir(path.join(tmp, "ProjectSettings"), { recursive: true });
      await fs.mkdir(path.join(tmp, "Packages"), { recursive: true });
      const manifestPath = path.join(tmp, "Packages", "manifest.json");
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ dependencies: { "com.unity.textmeshpro": "3.0.6" } }) + "\n"
      );
      const r = await runInstallUnityPackage(g({ project: tmp, json: true }), {
        command: "install-unity-package",
        positional: [],
        flags: { mode: "manifest" },
      });
      expect(r.exitCode).toBe(0);
      const afterRaw = await fs.readFile(manifestPath, "utf8");
      const after = JSON.parse(afterRaw);
      expect(after.dependencies["com.uvibe.os"]).toMatch(/^file:.*UnityVibeOS$/);
      expect(after.dependencies["com.unity.textmeshpro"]).toBe("3.0.6");
      expect(after.testables).toEqual(["com.uvibe.os"]);
      expect(afterRaw.split("\n")).toHaveLength(2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves manifest testables and formatting when re-run", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-install-testable-"));
    try {
      await fs.mkdir(path.join(tmp, "Assets"), { recursive: true });
      await fs.mkdir(path.join(tmp, "ProjectSettings"), { recursive: true });
      await fs.mkdir(path.join(tmp, "Packages"), { recursive: true });
      const manifestPath = path.join(tmp, "Packages", "manifest.json");
      await fs.writeFile(
        manifestPath,
        JSON.stringify(
          {
            dependencies: { "com.unity.textmeshpro": "3.0.6" },
            testables: ["com.example.tools"],
          },
          null,
          4
        ) + "\n"
      );

      const args = {
        command: "install-unity-package",
        positional: [],
        flags: { mode: "manifest" },
      };
      const first = await runInstallUnityPackage(g({ project: tmp, json: true }), args);
      expect(first.exitCode).toBe(0);
      const afterFirst = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(afterFirst);
      expect(manifest.dependencies["com.unity.textmeshpro"]).toBe("3.0.6");
      expect(manifest.testables).toEqual(["com.example.tools", "com.uvibe.os"]);
      expect(afterFirst).toContain('\n    "dependencies"');

      const second = await runInstallUnityPackage(g({ project: tmp, json: true }), args);
      expect(second.exitCode).toBe(0);
      expect(await fs.readFile(manifestPath, "utf8")).toBe(afterFirst);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves manifest paths from the canonical project location", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-install-canonical-"));
    const alias = `${tmp}-alias`;
    try {
      const realRoot = path.join(tmp, "nested", "real");
      const realProject = path.join(realRoot, "Project");
      const realSource = path.join(realRoot, "UnityVibeOS");
      await fs.mkdir(path.join(realProject, "Assets"), { recursive: true });
      await fs.mkdir(path.join(realProject, "ProjectSettings"), { recursive: true });
      await fs.mkdir(path.join(realProject, "Packages"), { recursive: true });
      await fs.mkdir(realSource, { recursive: true });
      await fs.writeFile(path.join(realSource, "package.json"), "{}\n");
      await fs.writeFile(path.join(realProject, "Packages", "manifest.json"), '{"dependencies":{}}\n');
      await fs.symlink(realRoot, alias, "dir");

      const projectThroughAlias = path.join(alias, "Project");
      const result = await runInstallUnityPackage(g({ project: projectThroughAlias, json: true }), {
        command: "install-unity-package",
        positional: [],
        flags: { mode: "manifest", source: realSource },
      });
      expect(result.exitCode).toBe(0);

      const manifestPath = path.join(projectThroughAlias, "Packages", "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const ref = manifest.dependencies["com.uvibe.os"] as string;
      expect(ref).toMatch(/^file:/);
      const canonicalPackages = await fs.realpath(path.join(projectThroughAlias, "Packages"));
      const resolvedSource = path.resolve(canonicalPackages, ref.slice("file:".length));
      expect(await fs.realpath(resolvedSource)).toBe(await fs.realpath(realSource));
    } finally {
      await fs.rm(alias, { force: true });
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("default copy mode embeds a portable copy and strips a stale absolute manifest entry", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-install-embed-"));
    try {
      await fs.mkdir(path.join(tmp, "Assets"), { recursive: true });
      await fs.mkdir(path.join(tmp, "ProjectSettings"), { recursive: true });
      await fs.mkdir(path.join(tmp, "Packages"), { recursive: true });
      // Simulate the bug: an absolute file: path pointing at someone else's machine.
      await fs.writeFile(
        path.join(tmp, "Packages", "manifest.json"),
        JSON.stringify(
          {
            dependencies: {
              "com.uvibe.os": "file:C:/Users/someoneelse/wazzicode-unity/unity/UnityVibeOS",
              "com.unity.textmeshpro": "3.0.6",
            },
          },
          null,
          2
        )
      );
      // No mode flag → default (copy/embed).
      const r = await runInstallUnityPackage(g({ project: tmp, json: false }), {
        command: "install-unity-package",
        positional: [],
        flags: {},
      });
      expect(r.exitCode).toBe(0);
      // Embedded copy present, auto-discovered by Unity.
      await fs.access(path.join(tmp, "Packages", "com.uvibe.os", "package.json"));
      const after = JSON.parse(await fs.readFile(path.join(tmp, "Packages", "manifest.json"), "utf8"));
      // The broken absolute entry is gone; unrelated deps are preserved.
      expect(after.dependencies["com.uvibe.os"]).toBeUndefined();
      expect(after.dependencies["com.unity.textmeshpro"]).toBe("3.0.6");
      expect(r.stdout).toContain("Removed stale");
      // Re-running is idempotent (overwrites the embedded copy, no error).
      const r2 = await runInstallUnityPackage(g({ project: tmp, json: false }), {
        command: "install-unity-package",
        positional: [],
        flags: {},
      });
      expect(r2.exitCode).toBe(0);
      await fs.access(path.join(tmp, "Packages", "com.uvibe.os", "package.json"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects targets that are not Unity projects", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-install-bad-"));
    try {
      const r = await runInstallUnityPackage(g({ project: tmp }), {
        command: "install-unity-package",
        positional: [],
        flags: { mode: "manifest" },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Not a Unity project");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("cli/autonomy", () => {
  it("on enables writes under autopilot; off restores read_only; status doesn't mutate", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-autonomy-"));
    try {
      const cfgPath = path.join(tmp, ".unity-vibe", "config.json");

      // status on a fresh project → write-enabled by default (autopilot), writes nothing.
      let r = await runAutonomy({ project: tmp, mock: false, json: true }, { command: "autonomy", positional: ["status"], flags: {} });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout!).safetyMode).toBe("autopilot");
      await expect(fs.access(cfgPath)).rejects.toBeTruthy(); // status did not write a config

      // on → autopilot + scene/prefab writes + autoSnapshot.
      r = await runAutonomy({ project: tmp, mock: false, json: true }, { command: "autonomy", positional: ["on"], flags: {} });
      expect(r.exitCode).toBe(0);
      const onCfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
      expect(onCfg.safetyMode).toBe("autopilot");
      expect(onCfg.allowSceneWrites).toBe(true);
      expect(onCfg.allowPrefabWrites).toBe(true);
      expect(onCfg.autoSnapshot).toBe(true);
      expect(onCfg.allowMenuItems).toBe(true);
      expect(onCfg.allowCodeExecution).toBe(true);
      expect(onCfg.allowedMenuItems).toEqual(["*"]);

      // off → read_only again.
      r = await runAutonomy({ project: tmp, mock: false, json: false }, { command: "autonomy", positional: ["off"], flags: {} });
      expect(r.exitCode).toBe(0);
      const offCfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
      expect(offCfg.safetyMode).toBe("read_only");

      // unknown mode → exit 2.
      r = await runAutonomy({ project: tmp, mock: false, json: false }, { command: "autonomy", positional: ["bogus"], flags: {} });
      expect(r.exitCode).toBe(2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}
