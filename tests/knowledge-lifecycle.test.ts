import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureBrainCurrent,
  generateBrain,
  knowledgeContentFingerprint,
  knowledgeDirectory,
  markBrainDirty,
  queryBrain,
  readKnowledgeBase,
  renderKnowledgeIndexMarkdown,
  type KnowledgeBase,
  type KnowledgeEntity,
  type KnowledgeRelation,
} from "@uvibe/project-brain";

const temporaryProjects: string[] = [];
const KNOWLEDGE_FILES = ["manifest.json", "entities.jsonl", "relations.jsonl", "index.md"] as const;

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((projectPath) =>
    fs.rm(projectPath, { recursive: true, force: true })));
});

describe("project knowledge full lifecycle", () => {
  it("builds an internally consistent store and leaves every generated file untouched on a warm ensure", async () => {
    const projectPath = await createUnityProject();
    const generated = await generateBrain({ projectPath, write: true });

    expect(generated.written.length).toBeGreaterThanOrEqual(7);
    const initial = await expectValidStore(projectPath);
    expect(initial.manifest.coverage.complete).toBe(true);
    expect(initial.manifest.coverage.truncated).toBe(false);
    expect(initial.entities.some((entity) => entity.name === "LifecycleController")).toBe(true);

    const generatedPaths = [
      ...KNOWLEDGE_FILES.map((name) => path.join(knowledgeDirectory(projectPath), name)),
      ...["project_brain.json", "project_brain.md", "claude_context.md"].map((name) =>
        path.join(projectPath, ".unity-vibe", name)),
    ];
    const before = await snapshotFiles(generatedPaths);
    const ensured = await ensureBrainCurrent(projectPath);
    const after = await snapshotFiles(generatedPaths);

    expect(ensured).toMatchObject({ refreshed: false, reason: "current", written: [] });
    expect(after).toEqual(before);
    await expectValidStore(projectPath);
    expect(await transientKnowledgePaths(projectPath)).toEqual([]);
  });

  it("tracks add, same-size restored-mtime edit, move, and delete without retaining stale graph nodes", async () => {
    const projectPath = await createUnityProject();
    await generateBrain({ projectPath, write: true });

    const addedPath = "Assets/Game/Systems/AddedSystem.cs";
    await writeProjectFile(projectPath, addedPath, [
      "namespace Game.Systems;",
      "public class AddedSystem : LifecycleBase",
      "{",
      "    private Game.Core.AlphaState state;",
      "    public void ExecuteAddedSystem() {}",
      "}",
      "",
    ].join("\n"));
    const added = await ensureBrainCurrent(projectPath);
    expect(added).toMatchObject({ refreshed: true, reason: "changed" });
    expect(added.knowledgeBase.entities.some((entity) => entity.path === addedPath)).toBe(true);
    const addedQuery = await queryBrain(projectPath, { query: "ExecuteAddedSystem", kinds: ["type"] });
    expect(addedQuery.matches[0]?.entity.name).toBe("AddedSystem");
    await expectValidStore(projectPath);

    const statePath = path.join(projectPath, "Assets/Game/Core/LifecycleState.cs");
    const fixedTime = new Date("2021-02-03T04:05:06.000Z");
    await fs.utimes(statePath, fixedTime, fixedTime);
    const beforeEdit = await fs.stat(statePath);
    const original = await fs.readFile(statePath, "utf8");
    const replacement = original.replace("AlphaState", "BravoState");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await fs.writeFile(statePath, replacement, "utf8");
    await fs.utimes(statePath, fixedTime, fixedTime);
    const afterEdit = await fs.stat(statePath);
    expect(afterEdit.size).toBe(beforeEdit.size);
    expect(afterEdit.mtimeMs).toBe(beforeEdit.mtimeMs);

    const edited = await ensureBrainCurrent(projectPath);
    expect(edited).toMatchObject({ refreshed: true, reason: "changed" });
    expect(edited.knowledgeBase.entities.some((entity) => entity.name === "BravoState")).toBe(true);
    expect(edited.knowledgeBase.entities.some((entity) => entity.name === "AlphaState")).toBe(false);
    await expectValidStore(projectPath);

    const movedPath = "Assets/Game/State/BravoStateMoved.cs";
    const movedAbsolute = path.join(projectPath, movedPath);
    await fs.mkdir(path.dirname(movedAbsolute), { recursive: true });
    await fs.rename(statePath, movedAbsolute);
    const moved = await ensureBrainCurrent(projectPath);
    expect(moved).toMatchObject({ refreshed: true, reason: "changed" });
    expect(moved.knowledgeBase.entities.some((entity) =>
      entity.kind === "script" && entity.path === "Assets/Game/Core/LifecycleState.cs")).toBe(false);
    expect(moved.knowledgeBase.entities.some((entity) =>
      entity.kind === "script" && entity.path === movedPath)).toBe(true);
    expect(moved.knowledgeBase.entities.find((entity) => entity.name === "BravoState")?.path).toBe(movedPath);
    await expectValidStore(projectPath);

    await fs.rm(movedAbsolute);
    await fs.rm(path.join(projectPath, addedPath));
    const removed = await ensureBrainCurrent(projectPath);
    expect(removed).toMatchObject({ refreshed: true, reason: "changed" });
    expect(removed.knowledgeBase.entities.some((entity) =>
      entity.path === movedPath || entity.path === addedPath)).toBe(false);
    expect(removed.knowledgeBase.relations.some((relation) =>
      relation.provenance.path === movedPath || relation.provenance.path === addedPath)).toBe(false);
    await expectValidStore(projectPath);
    expect(await transientKnowledgePaths(projectPath)).toEqual([]);
  });

  it("serializes concurrent dirty reconciliation across processes and removes locks and temporary files", async () => {
    const projectPath = await createUnityProject();
    await generateBrain({ projectPath, write: true });
    await writeProjectFile(
      projectPath,
      "Assets/Game/Systems/DirtyAdded.cs",
      "namespace Game.Systems; public class DirtyAdded : LifecycleBase {}\n",
    );
    const dirty = await markBrainDirty(projectPath, "Assets/Game/Systems/DirtyAdded.cs created");
    expect(dirty?.dirty.value).toBe(true);

    const results = await Promise.all(Array.from({ length: 4 }, () => ensureInChildProcess(projectPath)));
    expect(results.filter((result) => result.refreshed)).toHaveLength(1);
    expect(results.find((result) => result.refreshed)?.reason).toBe("dirty");
    expect(results.filter((result) => !result.refreshed).every((result) => result.reason === "current")).toBe(true);

    const knowledge = await expectValidStore(projectPath);
    expect(knowledge.manifest.dirty).toEqual({ value: false, reasons: [] });
    expect(knowledge.entities.some((entity) => entity.name === "DirtyAdded")).toBe(true);
    expect(await transientKnowledgePaths(projectPath)).toEqual([]);
  });

  it("rejects and repairs malformed, inconsistent, duplicate, dangling, and stale derived store data", async () => {
    const projectPath = await createUnityProject();
    await generateBrain({ projectPath, write: true });
    const knowledgeDir = knowledgeDirectory(projectPath);
    const manifestPath = path.join(knowledgeDir, "manifest.json");
    const entitiesPath = path.join(knowledgeDir, "entities.jsonl");
    const relationsPath = path.join(knowledgeDir, "relations.jsonl");
    const indexPath = path.join(knowledgeDir, "index.md");

    const cases: Array<{
      name: string;
      graphReadable: boolean;
      expectedReason: "absent" | "incomplete";
      mutate: (knowledge: KnowledgeBase) => Promise<void>;
    }> = [
      {
        name: "truncated manifest",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async () => fs.writeFile(manifestPath, "{\"schemaVersion\":", "utf8"),
      },
      {
        name: "truncated entities JSONL",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async () => fs.appendFile(entitiesPath, "{\"id\":", "utf8"),
      },
      {
        name: "truncated relations JSONL",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async () => fs.appendFile(relationsPath, "{\"id\":", "utf8"),
      },
      {
        name: "truncated generated index",
        graphReadable: true,
        expectedReason: "incomplete",
        mutate: async () => fs.writeFile(indexPath, "# stale and truncated\n", "utf8"),
      },
      {
        name: "unsupported schema",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async (knowledge) => {
          const manifest = structuredClone(knowledge.manifest) as Record<string, unknown>;
          manifest.schemaVersion = 999;
          await writeJson(manifestPath, manifest);
        },
      },
      {
        name: "wrong entity count",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async (knowledge) => {
          const manifest = structuredClone(knowledge.manifest);
          manifest.coverage.counts.entities += 1;
          await writeJson(manifestPath, manifest);
        },
      },
      {
        name: "wrong content hash",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async (knowledge) => {
          const manifest = structuredClone(knowledge.manifest);
          manifest.fingerprint.content = "0".repeat(64);
          await writeJson(manifestPath, manifest);
        },
      },
      {
        name: "duplicate entity id with matching count and hash",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async (knowledge) => {
          const entities = [...knowledge.entities, structuredClone(knowledge.entities[0])];
          await writeConsistentGraphFiles(knowledgeDir, knowledge, entities, knowledge.relations);
        },
      },
      {
        name: "duplicate relation id with matching count and hash",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async (knowledge) => {
          const relations = [...knowledge.relations, structuredClone(knowledge.relations[0])];
          await writeConsistentGraphFiles(knowledgeDir, knowledge, knowledge.entities, relations);
        },
      },
      {
        name: "dangling relation with matching count and hash",
        graphReadable: false,
        expectedReason: "absent",
        mutate: async (knowledge) => {
          const relations = structuredClone(knowledge.relations);
          relations[0].to = "type:missing-from-store";
          await writeConsistentGraphFiles(knowledgeDir, knowledge, knowledge.entities, relations);
        },
      },
    ];

    for (const corruption of cases) {
      await generateBrain({ projectPath, write: true });
      const clean = await expectValidStore(projectPath);
      await corruption.mutate(clean);
      const corruptedRead = await readKnowledgeBase(projectPath);
      if (corruption.graphReadable) expect(corruptedRead, corruption.name).not.toBeNull();
      else expect(corruptedRead, corruption.name).toBeNull();

      const repaired = await ensureBrainCurrent(projectPath);
      expect(repaired.refreshed, corruption.name).toBe(true);
      expect(repaired.reason, corruption.name).toBe(corruption.expectedReason);
      await expectValidStore(projectPath);
      expect(await transientKnowledgePaths(projectPath), corruption.name).toEqual([]);
    }

    await expectCuratedFilesUnchanged(projectPath);
  });

  it("honors an explicit scan cap, reports the boundary, and preserves it on later ensures", async () => {
    const projectPath = await createUnityProject();
    for (let index = 0; index < 8; index++) {
      await writeProjectFile(projectPath, `Assets/Art/Texture${index}.png`, `image-${index}`);
    }
    const generated = await generateBrain({ projectPath, write: true, maxFiles: 3 });

    expect(generated.knowledgeBase.manifest.coverage).toMatchObject({
      cap: 3,
      scanned: 3,
      complete: false,
      truncated: true,
    });
    expect(generated.knowledgeBase.manifest.coverage.discovered).toBeGreaterThan(3);
    expect(generated.knowledgeBase.manifest.coverage.counts.firstPartyScripts).toBe(3);
    await expectValidStore(projectPath);

    const warm = await ensureBrainCurrent(projectPath);
    expect(warm).toMatchObject({ refreshed: false, reason: "current" });
    expect(warm.knowledgeBase.manifest.coverage.cap).toBe(3);

    await writeProjectFile(projectPath, "Assets/AAAFirst.cs", "public class AAAFirst {}\n");
    const changed = await ensureBrainCurrent(projectPath);
    expect(changed).toMatchObject({ refreshed: true, reason: "changed" });
    expect(changed.knowledgeBase.manifest.coverage).toMatchObject({ cap: 3, scanned: 3, truncated: true });
    expect(changed.knowledgeBase.entities.some((entity) => entity.name === "AAAFirst")).toBe(true);
    await expectValidStore(projectPath);
    await expectCuratedFilesUnchanged(projectPath);
  });
});

async function createUnityProject(): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-knowledge-lifecycle-"));
  temporaryProjects.push(projectPath);
  const files: Record<string, string> = {
    "ProjectSettings/ProjectVersion.txt": [
      "m_EditorVersion: 2022.3.42f1",
      "m_EditorVersionWithRevision: 2022.3.42f1 (1234567890ab)",
      "",
    ].join("\n"),
    "ProjectSettings/ProjectSettings.asset": [
      "PlayerSettings:",
      "  productName: LifecycleGame",
      "  companyName: LifecycleStudio",
      "  applicationIdentifier:",
      "    Standalone: com.example.lifecycle",
      "",
    ].join("\n"),
    "Packages/manifest.json": JSON.stringify({ dependencies: {
      "com.example.vendor": "file:com.example.vendor",
      "com.unity.inputsystem": "1.7.0",
    } }, null, 2) + "\n",
    "Packages/com.example.vendor/Runtime/VendorSystem.cs":
      "namespace Example.Vendor; public class VendorSystem {}\n",
    "Assets/Scenes/Main.unity": "%YAML 1.1\n--- !u!1 &1\nGameObject:\n",
    "Assets/Prefabs/Player.prefab": "%YAML 1.1\n--- !u!1 &1\nGameObject:\n",
    "Assets/Game/Core/LifecycleState.cs": "namespace Game.Core; public class AlphaState {}\n",
    "Assets/Game/Systems/LifecycleBase.cs": [
      "namespace Game.Systems;",
      "public class LifecycleBase",
      "{",
      "    public virtual void TickLifecycle() {}",
      "}",
      "",
    ].join("\n"),
    "Assets/Game/Systems/LifecycleController.cs": [
      "namespace Game.Systems;",
      "public class LifecycleController : LifecycleBase",
      "{",
      "    private Game.Core.AlphaState state;",
      "    public override void TickLifecycle() {}",
      "}",
      "",
    ].join("\n"),
    ".unity-vibe/conventions.md": "# Team Conventions\nKeep lifecycle facts exact.\n",
    ".unity-vibe/known_issues.md": "# Known Issues\nNone recorded.\n",
    ".unity-vibe/feature_history.md": "# Feature History\nLifecycle fixture created.\n",
  };
  await Promise.all(Object.entries(files).map(([relativePath, contents]) =>
    writeProjectFile(projectPath, relativePath, contents)));
  return projectPath;
}

async function expectValidStore(projectPath: string): Promise<KnowledgeBase> {
  const knowledge = await readKnowledgeBase(projectPath);
  expect(knowledge).not.toBeNull();
  if (!knowledge) throw new Error("expected a readable project knowledge store");

  expect(knowledge.manifest.fingerprint.algorithm).toBe("sha256");
  expect(knowledge.manifest.fingerprint.content).toBe(
    knowledgeContentFingerprint(knowledge.entities, knowledge.relations),
  );
  expect(knowledge.manifest.coverage.counts.entities).toBe(knowledge.entities.length);
  expect(knowledge.manifest.coverage.counts.relations).toBe(knowledge.relations.length);
  expect(new Set(knowledge.entities.map((entity) => entity.id)).size).toBe(knowledge.entities.length);
  expect(new Set(knowledge.relations.map((relation) => relation.id)).size).toBe(knowledge.relations.length);

  const ids = new Set(knowledge.entities.map((entity) => entity.id));
  for (const entity of knowledge.entities) {
    for (const fact of entity.facts) {
      expect(path.isAbsolute(fact.provenance.path)).toBe(false);
      expect(fact.provenance.path).not.toContain(projectPath);
      expect(fact.observedAt).toBe(knowledge.manifest.generatedAt);
    }
  }
  for (const relation of knowledge.relations) {
    expect(ids.has(relation.from)).toBe(true);
    expect(ids.has(relation.to)).toBe(true);
    expect(path.isAbsolute(relation.provenance.path)).toBe(false);
    expect(relation.provenance.path).not.toContain(projectPath);
    expect(relation.observedAt).toBe(knowledge.manifest.generatedAt);
  }

  const dir = knowledgeDirectory(projectPath);
  expect(parseJsonLines(await fs.readFile(path.join(dir, "entities.jsonl"), "utf8"))).toHaveLength(
    knowledge.entities.length,
  );
  expect(parseJsonLines(await fs.readFile(path.join(dir, "relations.jsonl"), "utf8"))).toHaveLength(
    knowledge.relations.length,
  );
  expect(await fs.readFile(path.join(dir, "index.md"), "utf8")).toBe(renderKnowledgeIndexMarkdown(knowledge));
  return knowledge;
}

async function writeConsistentGraphFiles(
  knowledgeDir: string,
  knowledge: KnowledgeBase,
  entities: KnowledgeEntity[],
  relations: KnowledgeRelation[],
): Promise<void> {
  const manifest = structuredClone(knowledge.manifest);
  manifest.coverage.counts.entities = entities.length;
  manifest.coverage.counts.relations = relations.length;
  manifest.fingerprint.content = knowledgeContentFingerprint(entities, relations);
  await Promise.all([
    fs.writeFile(path.join(knowledgeDir, "entities.jsonl"), toJsonLines(entities), "utf8"),
    fs.writeFile(path.join(knowledgeDir, "relations.jsonl"), toJsonLines(relations), "utf8"),
  ]);
  await writeJson(path.join(knowledgeDir, "manifest.json"), manifest);
}

async function expectCuratedFilesUnchanged(projectPath: string): Promise<void> {
  const expected: Record<string, string> = {
    "conventions.md": "# Team Conventions\nKeep lifecycle facts exact.\n",
    "known_issues.md": "# Known Issues\nNone recorded.\n",
    "feature_history.md": "# Feature History\nLifecycle fixture created.\n",
  };
  for (const [name, contents] of Object.entries(expected)) {
    expect(await fs.readFile(path.join(projectPath, ".unity-vibe", name), "utf8")).toBe(contents);
  }
}

async function ensureInChildProcess(projectPath: string): Promise<{ refreshed: boolean; reason: string }> {
  const moduleUrl = pathToFileURL(path.resolve("packages/project-brain/dist/index.js")).href;
  const script = [
    "const api = await import(process.env.UVIBE_LIFECYCLE_MODULE);",
    "const result = await api.ensureBrainCurrent(process.env.UVIBE_LIFECYCLE_PROJECT);",
    "process.stdout.write(JSON.stringify({ refreshed: result.refreshed, reason: result.reason }));",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        UVIBE_LIFECYCLE_MODULE: moduleUrl,
        UVIBE_LIFECYCLE_PROJECT: projectPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`knowledge ensure child exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as { refreshed: boolean; reason: string });
      } catch (error) {
        reject(new Error(`knowledge ensure child returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
}

async function snapshotFiles(files: string[]): Promise<Record<string, { contents: string; mtimeMs: number }>> {
  const snapshots = await Promise.all(files.map(async (file) => ({
    file,
    contents: await fs.readFile(file, "utf8"),
    mtimeMs: (await fs.stat(file)).mtimeMs,
  })));
  return Object.fromEntries(snapshots.map(({ file, ...snapshot }) => [file, snapshot]));
}

async function transientKnowledgePaths(projectPath: string): Promise<string[]> {
  const vibeDir = path.join(projectPath, ".unity-vibe");
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.name === "knowledge.lock" || entry.name.includes(".tmp") || entry.name.includes(".stale.")) {
        found.push(path.relative(projectPath, absolute));
      }
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(vibeDir);
  return found.sort();
}

async function writeProjectFile(projectPath: string, relativePath: string, contents: string): Promise<void> {
  const destination = path.join(projectPath, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents, "utf8");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function toJsonLines<T>(values: T[]): string {
  return values.length ? values.map((value) => JSON.stringify(value)).join("\n") + "\n" : "";
}

function parseJsonLines(raw: string): unknown[] {
  return raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
