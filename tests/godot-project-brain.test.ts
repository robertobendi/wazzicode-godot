import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectGodotProject,
  ensureBrainCurrent,
  generateBrain,
  parseGDScript,
  parseGodotResourceDependencies,
  queryBrain,
  readKnowledgeBase,
  scanProject,
} from "@gvibe/project-brain";

describe("Godot project detection and scanning", () => {
  it("reads Godot-native project settings without requiring a running editor", async () => {
    await withGodotProject(async (projectPath) => {
      const detected = await detectGodotProject(projectPath);
      expect(detected).toMatchObject({
        isGodotProject: true,
        configVersion: 5,
        projectName: "Signal & Steel",
        mainScene: "res://scenes/main.tscn",
        renderer: "gl_compatibility",
        viewport: { width: 1280, height: 720 },
        usesDotnet: false,
      });
      expect(detected.features).toEqual(["4.7", "GL Compatibility"]);
      expect(detected.autoloads).toEqual([
        { name: "SaveManager", path: "res://scripts/save_manager.gd", singleton: true },
      ]);
      expect(detected.inputActions).toEqual(["jump"]);
    });
  });

  it("indexes supported res:// assets, separates addons, excludes import state, and reports caps", async () => {
    await withGodotProject(async (projectPath) => {
      await write(projectPath, ".godot/editor/editor_layout.cfg", "ignored");
      await write(projectPath, "addons/example/runtime.gd", "extends Node\n");
      const complete = await scanProject(projectPath);
      expect(complete.scenes).toEqual([
        "res://scenes/enemy.tscn",
        "res://scenes/main.tscn",
      ]);
      expect(complete.gdScripts).toEqual([
        "res://addons/example/runtime.gd",
        "res://scripts/player_controller.gd",
        "res://scripts/save_manager.gd",
      ]);
      expect(complete.addonScripts).toEqual(["res://addons/example/runtime.gd"]);
      expect(complete.csharpScripts).toEqual(["res://scripts/NetPeer.cs"]);
      expect(complete.resources).toEqual(["res://data/player_stats.tres"]);
      expect(complete.shaders).toEqual(["res://shaders/hit_flash.gdshader"]);
      expect(complete.files.some((file) => file.path.includes(".godot"))).toBe(false);
      expect(complete.coverage.complete).toBe(true);

      const bounded = await scanProject(projectPath, { maxFiles: 3 });
      expect(bounded.scripts).toHaveLength(3);
      expect(bounded.coverage).toMatchObject({ scanned: 3, truncated: true, complete: false });
      expect(bounded.coverage.discovered).toBeGreaterThan(3);
    });
  });

  it("does not read project.godot through a symlink outside the project", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "godot-project-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "godot-project-link-outside-"));
    try {
      const external = path.join(outside, "external.godot");
      const secret = "External Project Name Must Not Leak";
      await fs.writeFile(external, `config_version=5\n[application]\nconfig/name="${secret}"\n`, "utf8");
      await fs.symlink(external, path.join(projectPath, "project.godot"));

      const detected = await detectGodotProject(projectPath);
      const scanned = await scanProject(projectPath);

      expect(detected.isGodotProject).toBe(false);
      expect(detected).not.toHaveProperty("projectName");
      expect(JSON.stringify(detected)).not.toContain(secret);
      expect(scanned.coverage.errors).toContainEqual(expect.objectContaining({
        path: "project.godot",
        message: expect.stringContaining("resolves outside"),
      }));
      expect(scanned.coverage.complete).toBe(false);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("Godot source parsing", () => {
  it("extracts the GDScript surface agents need to reason about", () => {
    const parsed = parseGDScript("res://player.gd", [
      "@tool",
      "class_name PlayerController",
      "extends CharacterBody2D",
      "signal health_changed(value: int)",
      "@export_range(1.0, 20.0) var speed: float = 8.0",
      "const Enemy = preload(\"res://scenes/enemy.tscn\")",
      "# preload(\"res://commented_out.gd\")",
      "func _physics_process(delta: float) -> void:",
      "    pass",
    ].join("\n"));

    expect(parsed).toMatchObject({
      className: "PlayerController",
      extends: "CharacterBody2D",
      tool: true,
    });
    expect(parsed.signals.map((signal) => signal.name)).toEqual(["health_changed"]);
    expect(parsed.exports).toEqual([
      expect.objectContaining({ name: "speed", type: "float", annotation: "@export_range(1.0, 20.0)" }),
    ]);
    expect(parsed.functions.map((fn) => fn.name)).toEqual(["_physics_process"]);
    expect(parsed.dependencies).toEqual([
      { path: "res://scenes/enemy.tscn", loader: "preload", line: 6 },
    ]);
  });

  it("distinguishes packed-scene instances from ordinary ext_resource references", () => {
    const dependencies = parseGodotResourceDependencies([
      "[gd_scene load_steps=3 format=3]",
      "[ext_resource type=\"Script\" path=\"res://player.gd\" id=\"1_script\"]",
      "[ext_resource type=\"PackedScene\" path=\"res://enemy.tscn\" id=\"2_enemy\"]",
      "[node name=\"Enemy\" parent=\".\" instance=ExtResource(\"2_enemy\")]",
    ].join("\n"));
    expect(dependencies).toEqual([
      { id: "2_enemy", path: "res://enemy.tscn", type: "PackedScene", instantiated: true, line: 3 },
      { id: "1_script", path: "res://player.gd", type: "Script", instantiated: false, line: 2 },
    ]);
  });
});

describe("Godot project knowledge graph", () => {
  it("writes a provenance-rich Godot graph and answers architecture queries", async () => {
    await withGodotProject(async (projectPath) => {
      await write(projectPath, "addons/combat_tools/plugin.gd", "@tool\nextends EditorPlugin\n");
      const generated = await generateBrain({ projectPath, write: true });
      expect(generated.brain.identity).toMatchObject({ isGodotProject: true, projectName: "Signal & Steel" });
      expect(generated.brain.architecture).toMatchObject({
        gdScriptCount: 3,
        csharpScriptCount: 1,
        signalCount: 1,
        exportCount: 1,
        hasSaveSystem: true,
        hasInputHandling: true,
      });

      for (const file of [
        ".godot-vibe/brain/project.json",
        ".godot-vibe/brain/overview.md",
        ".godot-vibe/brain/agent-context.md",
        ".godot-vibe/brain/manifest.json",
        ".godot-vibe/brain/entities.jsonl",
        ".godot-vibe/brain/relations.jsonl",
        ".godot-vibe/brain/index.md",
        ".godot-vibe/conventions.md",
      ]) await fs.access(path.join(projectPath, file));

      const knowledge = await readKnowledgeBase(projectPath);
      expect(knowledge?.manifest.schemaVersion).toBe(2);
      expect(knowledge?.manifest.project).toMatchObject({ isGodotProject: true, name: "Signal & Steel" });
      expect(new Set(knowledge?.entities.map((entity) => entity.kind))).toEqual(new Set([
        "project",
        "addon",
        "scene",
        "resource",
        "script",
        "class",
        "module",
        "shader",
      ]));
      expect(knowledge?.entities.some((entity) => entity.kind === "class" && entity.name === "PlayerController")).toBe(true);
      expect(knowledge?.entities.some((entity) => entity.kind === "class" && entity.name === "NetPeer")).toBe(true);
      expect(knowledge?.entities.some((entity) => entity.kind === "addon" && entity.name === "combat_tools")).toBe(true);
      expect(knowledge?.relations.some((relation) => relation.kind === "extends"
        && knowledge.entities.find((entity) => entity.id === relation.to)?.name === "CharacterBody2D")).toBe(true);
      expect(knowledge?.relations.some((relation) => relation.kind === "instantiates"
        && knowledge.entities.find((entity) => entity.id === relation.to)?.path === "res://scenes/enemy.tscn")).toBe(true);
      expect(knowledge?.relations.some((relation) => relation.kind === "references"
        && relation.provenance.path === "res://scripts/player_controller.gd")).toBe(true);

      const saving = await queryBrain(projectPath, { query: "what handles saving?", kinds: ["class"] });
      expect(saving.matches[0]?.entity.name).toBe("SaveManager");
      expect(saving.matches[0]?.entity.facts).toContainEqual(expect.objectContaining({
        key: "function",
        value: "func save_game() -> void:",
      }));

      const derived = await queryBrain(projectPath, {
        query: "classes extending CharacterBody2D",
        kinds: ["class"],
      });
      expect(derived.matches.map((match) => match.entity.name)).toContain("PlayerController");

      const dependencies = await queryBrain(projectPath, { query: "Main dependencies" });
      expect(dependencies.matches.map((match) => match.entity.path)).toEqual(expect.arrayContaining([
        "res://scripts/player_controller.gd",
        "res://scenes/enemy.tscn",
      ]));
    });
  });

  it("uses source fingerprints to avoid needless work and refresh changed scripts", async () => {
    await withGodotProject(async (projectPath) => {
      await generateBrain({ projectPath, write: true });
      const current = await ensureBrainCurrent(projectPath);
      expect(current).toMatchObject({ refreshed: false, reason: "current", written: [] });

      await write(projectPath, "scripts/save_manager.gd", [
        "class_name SaveCoordinator",
        "extends Node",
        "func persist_game() -> void:",
        "    FileAccess.open(\"user://save.dat\", FileAccess.WRITE)",
      ].join("\n"));
      const changed = await ensureBrainCurrent(projectPath);
      expect(changed).toMatchObject({ refreshed: true, reason: "changed" });
      expect(changed.knowledgeBase.entities.some((entity) => entity.name === "SaveCoordinator")).toBe(true);
      expect(changed.knowledgeBase.entities.some((entity) => entity.name === "SaveManager")).toBe(false);
    });
  });

  it("rejects a brain target symlink without writing outside the project", async () => {
    await withGodotProject(async (projectPath) => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "godot-brain-outside-"));
      try {
        await fs.mkdir(path.join(projectPath, ".godot-vibe"));
        await fs.symlink(outside, path.join(projectPath, ".godot-vibe", "brain"));

        await expect(generateBrain({ projectPath, write: true })).rejects.toThrow("resolves outside");
        expect(await fs.readdir(outside)).toEqual([]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("rejects a generated-state parent symlink without writing outside the project", async () => {
    await withGodotProject(async (projectPath) => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "godot-brain-parent-outside-"));
      try {
        await fs.symlink(outside, path.join(projectPath, ".godot-vibe"));

        await expect(generateBrain({ projectPath, write: true })).rejects.toThrow("resolves outside");
        expect(await fs.readdir(outside)).toEqual([]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });
});

async function withGodotProject(run: (projectPath: string) => Promise<void>): Promise<void> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "godot-project-brain-"));
  try {
    await writeFixture(projectPath);
    await run(projectPath);
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
}

async function writeFixture(projectPath: string): Promise<void> {
  await write(projectPath, "project.godot", [
    "; Engine configuration file.",
    "config_version=5",
    "",
    "[application]",
    'config/name="Signal & Steel"',
    'run/main_scene="res://scenes/main.tscn"',
    'config/features=PackedStringArray("4.7", "GL Compatibility")',
    "",
    "[autoload]",
    'SaveManager="*res://scripts/save_manager.gd"',
    "",
    "[display]",
    "window/size/viewport_width=1280",
    "window/size/viewport_height=720",
    "",
    "[input]",
    "jump={",
    '"deadzone": 0.5,',
    '"events": []',
    "}",
    "",
    "[rendering]",
    'renderer/rendering_method="gl_compatibility"',
    "",
  ].join("\n"));
  await write(projectPath, "scripts/player_controller.gd", [
    "class_name PlayerController",
    "extends CharacterBody2D",
    "signal health_changed(value: int)",
    "@export var speed: float = 8.0",
    'const EnemyScene = preload("res://scenes/enemy.tscn")',
    "func _physics_process(delta: float) -> void:",
    '    if Input.is_action_pressed("jump"):',
    "        velocity.y -= speed * delta",
  ].join("\n"));
  await write(projectPath, "scripts/save_manager.gd", [
    "class_name SaveManager",
    "extends Node",
    "func save_game() -> void:",
    '    FileAccess.open("user://save.dat", FileAccess.WRITE)',
  ].join("\n"));
  await write(projectPath, "scripts/NetPeer.cs", "public sealed class NetPeer : Node { }\n");
  await write(projectPath, "scenes/main.tscn", [
    "[gd_scene load_steps=3 format=3]",
    '[ext_resource type="Script" path="res://scripts/player_controller.gd" id="1_script"]',
    '[ext_resource type="PackedScene" path="res://scenes/enemy.tscn" id="2_enemy"]',
    '[node name="Main" type="Node2D"]',
    'script = ExtResource("1_script")',
    '[node name="Enemy" parent="." instance=ExtResource("2_enemy")]',
  ].join("\n"));
  await write(projectPath, "scenes/enemy.tscn", [
    "[gd_scene format=3]",
    '[node name="Enemy" type="CharacterBody2D"]',
  ].join("\n"));
  await write(projectPath, "data/player_stats.tres", [
    "[gd_resource type=\"Resource\" format=3]",
    "[resource]",
    "health = 100",
  ].join("\n"));
  await write(projectPath, "shaders/hit_flash.gdshader", "shader_type canvas_item;\n");
}

async function write(projectPath: string, relativePath: string, contents: string): Promise<void> {
  const destination = path.join(projectPath, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents, "utf8");
}
