import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  detectUnityProject,
  ensureBrainCurrent,
  generateBrain,
  knowledgeContentFingerprint,
  markBrainDirty,
  queryBrain,
  readBrain,
  readKnowledgeBase,
  renderKnowledgeIndexMarkdown,
  scanProject,
} from "@uvibe/project-brain";

const FIXTURE = path.resolve("tests/fixtures/sample-unity-project");

describe("project-brain/detect", () => {
  it("recognizes a Unity project", async () => {
    const result = await detectUnityProject(FIXTURE);
    expect(result.isUnityProject).toBe(true);
    expect(result.unityVersion).toBe("2022.3.42f1");
    expect(result.productName).toBe("SampleGame");
    expect(result.companyName).toBe("SampleStudio");
    expect(result.renderPipeline).toBe("URP");
    expect(result.inputSystem).toBe("InputSystem");
    expect(result.packages?.length ?? 0).toBeGreaterThan(0);
  });

  it("returns isUnityProject=false for empty dirs", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-brain-empty-"));
    try {
      const result = await detectUnityProject(tmp);
      expect(result.isUnityProject).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("project-brain/scan", () => {
  it("finds assets, separates source scopes, and skips meta files", async () => {
    const result = await scanProject(FIXTURE);
    expect(result.scenes).toContain("Assets/Scenes/Sample.unity");
    expect(result.firstPartyScripts).toHaveLength(3);
    expect(result.packageScripts).toHaveLength(0);
    expect(result.scripts.some((script) => script.endsWith("PlayerController.cs"))).toBe(true);
    expect(result.scripts.some((script) => script.endsWith("WeaponData.cs"))).toBe(true);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.truncated).toBe(false);
    expect(result.coverage.cap).toBe(25_000);
  });

  it("prioritizes first-party and package code and reports truncation explicitly", async () => {
    await withFixture(async (projectPath) => {
      await writeProjectFile(projectPath, "Packages/com.example.vendor/Runtime/VendorType.cs", "public class VendorType {}\n");
      for (let index = 0; index < 20; index++) {
        await writeProjectFile(projectPath, `Assets/Textures/T${index}.png`, "not-an-image");
      }
      const result = await scanProject(projectPath, { maxFiles: 4 });
      expect(result.firstPartyScripts).toHaveLength(3);
      expect(result.packageScripts).toEqual(["Packages/com.example.vendor/Runtime/VendorType.cs"]);
      expect(result.coverage.scanned).toBe(4);
      expect(result.coverage.discovered).toBeGreaterThan(4);
      expect(result.coverage.cap).toBe(4);
      expect(result.coverage.truncated).toBe(true);
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.scopes.packages.scripts).toBe(1);
    });
  });
});

describe("project-brain/knowledge store", () => {
  it("writes the v1 canonical graph and compatibility files with provenance", async () => {
    await withFixture(async (projectPath) => {
      await writeProjectFile(projectPath, "Assets/Prefabs/Enemy.prefab", "%YAML 1.1\n");
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/PlayerLink.cs",
        "public class PlayerLink { public PlayerController Player; }\n",
      );
      const generated = await generateBrain({ projectPath, write: true });
      expect(generated.brain.identity.isUnityProject).toBe(true);
      expect(generated.brain.architecture.scriptableObjectTypes).toContain("WeaponData");
      expect(generated.brain.architecture.hasAudioManager).toBe(true);

      const brainDir = path.join(projectPath, ".unity-vibe");
      for (const name of ["project_brain.md", "project_brain.json", "claude_context.md", "conventions.md", "config.json"]) {
        await fs.access(path.join(brainDir, name));
      }
      for (const name of ["manifest.json", "entities.jsonl", "relations.jsonl", "index.md"]) {
        await fs.access(path.join(brainDir, "knowledge", name));
      }

      const knowledge = await readKnowledgeBase(projectPath);
      expect(knowledge).not.toBeNull();
      expect(knowledge?.manifest.schemaVersion).toBe(1);
      expect(knowledge?.manifest.project.path).toBe(".");
      expect(knowledge?.manifest.project.id).toBe("project:.");
      expect(knowledge?.manifest.coverage.complete).toBe(true);
      expect(knowledge?.manifest.coverage.counts.entities).toBe(knowledge?.entities.length);
      expect(knowledge?.manifest.coverage.counts.relations).toBe(knowledge?.relations.length);
      expect(new Set(knowledge?.entities.map((entity) => entity.kind))).toEqual(
        new Set(["project", "package", "scene", "prefab", "script", "type", "module"]),
      );
      expect(new Set(knowledge?.relations.map((relation) => relation.kind))).toEqual(
        new Set(["contains", "declares", "derives", "references"]),
      );
      for (const entity of knowledge?.entities ?? []) {
        for (const fact of entity.facts) {
          expect(fact.observedAt).toBe(knowledge?.manifest.generatedAt);
          expect(fact.provenance.path).not.toContain(projectPath);
          if (fact.provenance.heuristic) expect(fact.confidence).toBeTypeOf("number");
        }
      }
      for (const relation of knowledge?.relations ?? []) {
        expect(relation.observedAt).toBe(knowledge?.manifest.generatedAt);
        expect(relation.provenance.path).not.toContain(projectPath);
        if (relation.provenance.heuristic) expect(relation.confidence).toBeTypeOf("number");
      }
      const index = await fs.readFile(path.join(brainDir, "knowledge", "index.md"), "utf8");
      expect(index).toContain("Coverage and freshness");
      expect(index).toContain("Declared types");

      const reread = await readBrain(projectPath);
      expect(reread?.engine.unityVersion).toBe("2022.3.42f1");
    });
  });

  it("analyzes every selected first-party script beyond the former 400-file sample", async () => {
    await withFixture(async (projectPath) => {
      const generatedCount = 405;
      await Promise.all(Array.from({ length: generatedCount }, (_, index) => {
        const name = `GeneratedType${String(index).padStart(3, "0")}`;
        return writeProjectFile(projectPath, `Assets/Large/${name}.cs`, `public class ${name} {}\n`);
      }));
      const result = await generateBrain({ projectPath, write: false, maxFiles: 1_000 });
      expect(result.brain.assets.firstPartyScripts).toHaveLength(generatedCount + 3);
      expect(result.brain.architecture.totalScripts).toBe(generatedCount + 3);
      expect(result.knowledgeBase.manifest.coverage.counts.firstPartyScripts).toBe(generatedCount + 3);
      expect(result.knowledgeBase.entities.some((entity) => entity.name === "GeneratedType404")).toBe(true);
    });
  });

  it("answers natural questions with member evidence and bounded graph neighbors", async () => {
    await withFixture(async (projectPath) => {
      await writeProjectFile(projectPath, "Assets/Systems/Inventory.cs", "public class Inventory {}\n");
      await writeProjectFile(
        projectPath,
        "Assets/Systems/SaveManager.cs",
        [
          "using UnityEngine;",
          "public class SaveManager : MonoBehaviour",
          "{",
          "    [SerializeField] private Inventory inventory;",
          "    public void SaveGame() {}",
          "}",
          "",
        ].join("\n"),
      );
      await generateBrain({ projectPath, write: true });
      const result = await queryBrain(projectPath, { query: "what handles saving?", kinds: ["type"], limit: 5 });
      expect(result.matches[0]?.entity.name).toBe("SaveManager");
      expect(result.matches[0]?.entity.facts.some((fact) => fact.key === "memberSignature" && String(fact.value).includes("SaveGame"))).toBe(true);
      const reference = result.matches[0]?.neighbors.find((neighbor) => neighbor.relation.kind === "references");
      expect(reference?.entity.name).toBe("Inventory");
      expect(reference?.relation.provenance.path).toBe("Assets/Systems/SaveManager.cs");
      expect(reference?.relation.confidence).toBeGreaterThan(0);
    });
  });

  it("keeps multi-namespace, nested, and duplicate partial declarations distinct", async () => {
    await withFixture(async (projectPath) => {
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/NamespaceShapes.cs",
        [
          "namespace First",
          "{",
          "    public partial class Shared",
          "    {",
          "        public class Nested {}",
          "    }",
          "    public partial class Shared {}",
          "}",
          "namespace Second",
          "{",
          "    public class Shared {}",
          "    public class Outer",
          "    {",
          "        public class Nested {}",
          "    }",
          "}",
          "",
        ].join("\n"),
      );
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/FileScopedShapes.cs",
        "namespace FileScoped;\npublic partial class Across { public class Inner {} }\n",
      );
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/FileScopedShapes.Partial.cs",
        "namespace FileScoped;\npublic partial class Across {}\n",
      );
      const { knowledgeBase } = await generateBrain({ projectPath, write: false });
      const declarations = knowledgeBase.entities.filter((entity) =>
        entity.kind === "type" && entity.scope === "first-party" && entity.path?.includes("Shapes"));
      const qualifiedNames = declarations.map((entity) =>
        String(entity.facts.find((fact) => fact.key === "qualifiedName")?.value));

      expect(qualifiedNames.filter((name) => name === "First.Shared")).toHaveLength(2);
      expect(qualifiedNames).toContain("First.Shared.Nested");
      expect(qualifiedNames).toContain("Second.Shared");
      expect(qualifiedNames).toContain("Second.Outer.Nested");
      expect(qualifiedNames.filter((name) => name === "FileScoped.Across")).toHaveLength(2);
      expect(qualifiedNames).toContain("FileScoped.Across.Inner");
      expect(new Set(knowledgeBase.entities.map((entity) => entity.id)).size).toBe(knowledgeBase.entities.length);

      const outer = declarations.find((entity) =>
        entity.facts.some((fact) => fact.key === "qualifiedName" && fact.value === "Second.Outer"));
      const inner = declarations.find((entity) =>
        entity.facts.some((fact) => fact.key === "qualifiedName" && fact.value === "Second.Outer.Nested"));
      expect(knowledgeBase.relations.some((relation) =>
        relation.kind === "contains" && relation.from === outer?.id && relation.to === inner?.id)).toBe(true);
    });
  });

  it("no-ops on a matching source fingerprint and refreshes changed, added, and removed scripts", async () => {
    await withFixture(async (projectPath) => {
      await generateBrain({ projectPath, write: true });
      const manifestPath = path.join(projectPath, ".unity-vibe", "knowledge", "manifest.json");
      const before = await readKnowledgeBase(projectPath);
      const beforeMtime = (await fs.stat(manifestPath)).mtimeMs;

      const current = await ensureBrainCurrent(projectPath);
      expect(current.refreshed).toBe(false);
      expect(current.reason).toBe("current");
      expect(current.written).toEqual([]);
      expect((await fs.stat(manifestPath)).mtimeMs).toBe(beforeMtime);
      expect(current.knowledgeBase.manifest.fingerprint.source).toBe(before?.manifest.fingerprint.source);

      await writeProjectFile(projectPath, "Assets/Scripts/PlayerController.cs", "public class ChangedController {}\n");
      const changed = await ensureBrainCurrent(projectPath);
      expect(changed.refreshed).toBe(true);
      expect(changed.reason).toBe("changed");
      expect(changed.knowledgeBase.entities.some((entity) => entity.name === "ChangedController")).toBe(true);

      await writeProjectFile(projectPath, "Assets/Scripts/AddedLater.cs", "public class AddedLater {}\n");
      const added = await ensureBrainCurrent(projectPath);
      expect(added.refreshed).toBe(true);
      expect(added.knowledgeBase.entities.some((entity) => entity.name === "AddedLater")).toBe(true);

      await fs.rm(path.join(projectPath, "Assets/Scripts/AddedLater.cs"));
      const removed = await ensureBrainCurrent(projectPath);
      expect(removed.refreshed).toBe(true);
      expect(removed.knowledgeBase.entities.some((entity) => entity.name === "AddedLater")).toBe(false);
    });
  });

  it("keeps unchanged persistent coverage errors without rebuilding until sources change", async () => {
    await withFixture(async (projectPath) => {
      const generated = await generateBrain({ projectPath, write: true });
      const manifestPath = path.join(projectPath, ".unity-vibe", "knowledge", "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      manifest.coverage.complete = false;
      manifest.coverage.errors = [{ path: "Assets/Unreadable", message: "EACCES: persistent test error" }];
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      await fs.writeFile(
        path.join(projectPath, ".unity-vibe", "knowledge", "index.md"),
        renderKnowledgeIndexMarkdown({ ...generated.knowledgeBase, manifest }),
        "utf8",
      );
      const mtimeBefore = (await fs.stat(manifestPath)).mtimeMs;

      const unchanged = await ensureBrainCurrent(projectPath);
      expect(unchanged.refreshed).toBe(false);
      expect(unchanged.reason).toBe("current");
      expect(unchanged.knowledgeBase.manifest.coverage.complete).toBe(false);
      expect(unchanged.knowledgeBase.manifest.coverage.errors).toHaveLength(1);
      expect((await fs.stat(manifestPath)).mtimeMs).toBe(mtimeBefore);

      await writeProjectFile(projectPath, "Assets/Scripts/ErrorRecoveryChange.cs", "public class ErrorRecoveryChange {}\n");
      const changed = await ensureBrainCurrent(projectPath);
      expect(changed.refreshed).toBe(true);
      expect(changed.reason).toBe("changed");
      expect(changed.knowledgeBase.manifest.coverage.complete).toBe(true);
    });
  });

  it("marks dirty reasons and serializes concurrent refreshes into a valid clean store", async () => {
    await withFixture(async (projectPath) => {
      await generateBrain({ projectPath, write: true });
      const dirty = await markBrainDirty(projectPath, "Assets/Scripts/AudioManager.cs changed");
      expect(dirty?.dirty.value).toBe(true);
      expect(dirty?.dirty.reasons.at(-1)?.change).toContain("AudioManager.cs");

      const results = await Promise.all([
        ensureBrainCurrent(projectPath),
        ensureBrainCurrent(projectPath),
        ensureBrainCurrent(projectPath),
      ]);
      expect(results.filter((result) => result.refreshed)).toHaveLength(1);
      expect(results.find((result) => result.refreshed)?.reason).toBe("dirty");
      const knowledge = await readKnowledgeBase(projectPath);
      expect(knowledge?.manifest.dirty).toEqual({ value: false, reasons: [] });
    });
  });

  it("waits for another process's live lock and recovers a dead-owner lock", async () => {
    await withFixture(async (projectPath) => {
      await generateBrain({ projectPath, write: true });
      const childScript = [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const root = process.argv.at(-1);",
        "const lock = path.join(root, '.unity-vibe', 'knowledge.lock');",
        "fs.mkdirSync(lock);",
        "fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'child' }));",
        "process.stdout.write('locked\\n');",
        "setTimeout(() => { fs.rmSync(lock, { recursive: true, force: true }); }, 450);",
      ].join("\n");
      const child = spawn(process.execPath, ["-e", childScript, projectPath], { stdio: ["ignore", "pipe", "pipe"] });
      try {
        await waitForChildOutput(child, "locked");
        const startedAt = Date.now();
        const dirty = await markBrainDirty(projectPath, "cross-process change");
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
        expect(dirty?.dirty.reasons.at(-1)?.change).toBe("cross-process change");
        await waitForChildExit(child);
      } finally {
        if (child.exitCode === null) child.kill();
      }

      const lockPath = path.join(projectPath, ".unity-vibe", "knowledge.lock");
      await fs.mkdir(lockPath);
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now(), token: "dead" }),
        "utf8",
      );
      const recovered = await markBrainDirty(projectPath, "recovered stale lock");
      expect(recovered?.dirty.reasons.at(-1)?.change).toBe("recovered stale lock");
      await expect(fs.access(lockPath)).rejects.toThrow();
    });
  });

  it("preserves curated notes across refreshes", async () => {
    await withFixture(async (projectPath) => {
      const brainDir = path.join(projectPath, ".unity-vibe");
      const curated: Record<string, string> = {
        "conventions.md": "# Team Conventions\nCustom rule.\n",
        "known_issues.md": "# Known Issues\nReal issue.\n",
        "feature_history.md": "# Feature History\nReal feature.\n",
      };
      for (const [name, contents] of Object.entries(curated)) {
        await writeProjectFile(projectPath, `.unity-vibe/${name}`, contents);
      }
      await generateBrain({ projectPath, write: true });
      await markBrainDirty(projectPath, "refresh requested");
      await ensureBrainCurrent(projectPath);
      for (const [name, contents] of Object.entries(curated)) {
        expect(await fs.readFile(path.join(brainDir, name), "utf8")).toBe(contents);
      }
    });
  });

  it("rejects a partial mixed store so ensure can repair it", async () => {
    await withFixture(async (projectPath) => {
      await generateBrain({ projectPath, write: true });
      await fs.writeFile(path.join(projectPath, ".unity-vibe", "knowledge", "relations.jsonl"), "", "utf8");
      expect(await readKnowledgeBase(projectPath)).toBeNull();
      const repaired = await ensureBrainCurrent(projectPath);
      expect(repaired.refreshed).toBe(true);
      expect(repaired.reason).toBe("absent");
      expect(await readKnowledgeBase(projectPath)).not.toBeNull();
    });
  });

  it("rejects duplicate relation ids even when counts and fingerprints match", async () => {
    await withFixture(async (projectPath) => {
      await generateBrain({ projectPath, write: true });
      const knowledgeDir = path.join(projectPath, ".unity-vibe", "knowledge");
      const manifestPath = path.join(knowledgeDir, "manifest.json");
      const relationsPath = path.join(knowledgeDir, "relations.jsonl");
      const knowledge = await readKnowledgeBase(projectPath);
      expect(knowledge).not.toBeNull();
      const relations = [...knowledge!.relations, knowledge!.relations[0]];
      const relationsRaw = `${relations.map((relation) => JSON.stringify(relation)).join("\n")}\n`;
      const manifest = knowledge!.manifest;
      manifest.coverage.counts.relations = relations.length;
      manifest.fingerprint.content = knowledgeContentFingerprint(knowledge!.entities, relations);
      await fs.writeFile(relationsPath, relationsRaw, "utf8");
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

      expect(await readKnowledgeBase(projectPath)).toBeNull();
    });
  });
});

async function withFixture(run: (projectPath: string) => Promise<void>): Promise<void> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-brain-test-"));
  try {
    await copyDir(FIXTURE, projectPath);
    await run(projectPath);
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
}

async function writeProjectFile(projectPath: string, relativePath: string, contents: string): Promise<void> {
  const destination = path.join(projectPath, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents, "utf8");
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(src, entry.name);
    const destination = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(source, destination);
    else if (entry.isFile()) await fs.copyFile(source, destination);
  }
}

async function waitForChildOutput(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes(expected)) reject(new Error(`lock child exited ${code}: ${output}`));
    });
  });
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    expect(child.exitCode).toBe(0);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`)));
  });
}
