import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { err, ok } from "@uvibe/core";
import { allTools, buildContext, createMockBridgeClient } from "@uvibe/mcp-server";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  generateBrain,
  knowledgeDirectory,
  markBrainDirty,
  type BrainQueryResult,
  type KnowledgeBase,
  type KnowledgeEntity,
  type KnowledgeManifest,
} from "@uvibe/project-brain";
import { DEFAULT_CONFIG, writeConfig } from "@uvibe/safety";
import { executeTool } from "../packages/mcp-server/src/execute.js";
import {
  KNOWLEDGE_QUERY_MAX_BYTES,
  KNOWLEDGE_RELATION_QUERY_MAX_BYTES,
  projectBrainQuery,
} from "../packages/mcp-server/src/knowledgeProjection.js";
import type { AnyToolDef } from "../packages/mcp-server/src/registry.js";
import { readProjectBrainResource } from "../packages/mcp-server/src/resources.js";

describe("mcp-server/project-map invalidation", () => {
  it("answers through the public MCP query tool with coverage and evidence", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-map-query-"));
    try {
      await copyDirectory(
        path.resolve("tests/fixtures/sample-unity-project"),
        projectPath
      );
      await fs.writeFile(
        path.join(projectPath, "Assets", "Scripts", "FishSoulPickupSystem.cs"),
        "public class FishSoulPickupSystem\n{\n    public static void Drop() {}\n    private static void UpdateDrop() {}\n}\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(projectPath, "Assets", "Scripts", "OffscreenTargetIndicator.cs"),
        "public class OffscreenTargetIndicator\n{\n    private void LateUpdate() {}\n    private bool ShouldShowTargetIndicator() => true;\n}\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(projectPath, "Assets", "Scripts", "TutorialScreenManager.cs"),
        "public class TutorialScreenManager\n{\n    private void OnInputDeviceChanged(InputDeviceKind deviceKind) {}\n}\npublic enum InputDeviceKind { Keyboard, Gamepad }\n",
        "utf8",
      );
      const dependencyNames = Array.from({ length: 12 }, (_, index) => `Dependency${index}`);
      await fs.writeFile(
        path.join(projectPath, "Assets", "Scripts", "DependencyGraph.cs"),
        [
          ...dependencyNames.map((name) => `public class ${name} {}`),
          "public class Central",
          "{",
          ...dependencyNames.map((name, index) => `    private ${name} dependency${index};`),
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await generateBrain({ projectPath });
      const context = buildContext({
        bridgeOverride: createMockBridgeClient(),
        projectPath,
      });
      const tool = allTools.find(
        (candidate) => candidate.name === "unity_query_project_brain"
      );
      expect(tool).toBeDefined();

      const response = await tool!.run(
        { query: "what handles audio?", limit: 5 } as never,
        context
      );
      expect(response.ok).toBe(true);
      if (response.ok) {
        const data = response.data as {
          result: {
            matchCount: { total: number; returned: number; truncated: boolean };
            matches: Array<{
              entity: {
                name: string;
                facts: Array<{ provenance: { path: string } }>;
                factCount: { total: number; returned: number; truncated: boolean };
              };
            }>;
          };
          manifest: { coverage: { complete: boolean } };
        };
        expect(data.manifest.coverage.complete).toBe(true);
        const audio = data.result.matches.find(
          (match) => match.entity.name === "AudioManager"
        );
        expect(audio).toBeDefined();
        expect(data.result.matchCount.returned).toBe(data.result.matches.length);
        expect(
          audio?.entity.facts.some((fact) => fact.provenance.path.endsWith("AudioManager.cs"))
        ).toBe(true);
        expect(audio?.entity.factCount.returned).toBe(audio?.entity.facts.length);
      }

      const methodResponse = await tool!.run(
        { query: "Update", kinds: ["type"], limit: 5 } as never,
        context
      );
      expect(methodResponse.ok).toBe(true);
      if (methodResponse.ok) {
        const matches = (methodResponse.data as {
          result: {
            matches: Array<{
              entity: {
                name: string;
                facts: Array<{
                  key: string;
                  value: unknown;
                  provenance: { path: string; line?: number };
                }>;
              };
            }>;
          };
        }).result.matches;
        const player = matches.find((match) => match.entity.name === "PlayerController");
        const update = player?.entity.facts.find(
          (fact) => fact.key === "memberSignature" && String(fact.value).includes("Update")
        );
        expect(update?.provenance.path).toBe("Assets/Scripts/PlayerController.cs");
        expect(update?.provenance.line).toBe(9);
      }

      for (const expected of [
        {
          query: "What system drops fish-soul pickups?",
          entity: "FishSoulPickupSystem",
          member: "Drop",
          line: 3,
        },
        {
          query: "What updates off-screen target indicators?",
          entity: "OffscreenTargetIndicator",
          member: "LateUpdate",
          line: 3,
        },
        {
          query: "What responds when the active input device changes on tutorial screens?",
          entity: "TutorialScreenManager",
          member: "OnInputDeviceChanged",
          line: 3,
        },
      ]) {
        const behavioralResponse = await tool!.run({ query: expected.query } as never, context);
        expect(behavioralResponse.ok).toBe(true);
        if (!behavioralResponse.ok) continue;
        const matches = (behavioralResponse.data as {
          result: {
            output: { bytes: number; maxBytes: number };
            matches: Array<{
              entity: {
                name: string;
                facts: Array<{ value: unknown; provenance: { line?: number } }>;
              };
            }>;
          };
        }).result;
        expect(matches.output.maxBytes).toBe(KNOWLEDGE_QUERY_MAX_BYTES);
        expect(matches.output.bytes).toBeLessThanOrEqual(KNOWLEDGE_QUERY_MAX_BYTES);
        const entity = matches.matches.find((match) => match.entity.name === expected.entity);
        expect(entity).toBeDefined();
        expect(entity?.entity.facts).toEqual(expect.arrayContaining([
          expect.objectContaining({
            value: expect.stringContaining(expected.member),
            provenance: expect.objectContaining({ line: expected.line }),
          }),
        ]));
      }

      const relationResponse = await tool!.run(
        { query: "types derived from ScriptableObject", kinds: ["type"] } as never,
        context
      );
      expect(relationResponse.ok).toBe(true);
      if (relationResponse.ok) {
        const result = (relationResponse.data as {
          result: {
            queryLimit: { value: number; reached: boolean };
            matches: Array<{ entity: { name: string } }>;
          };
        }).result;
        expect(result.queryLimit.value).toBe(20);
        expect(result.matches.some((match) => match.entity.name === "WeaponData")).toBe(true);
      }

      const dependencyResponse = await tool!.run(
        { query: "Central dependencies", kinds: ["type"] } as never,
        context,
      );
      expect(dependencyResponse.ok).toBe(true);
      if (dependencyResponse.ok) {
        const result = (dependencyResponse.data as {
          result: {
            queryLimit: { value: number };
            output: { bytes: number; maxBytes: number; truncated: boolean };
            matches: Array<{ entity: { name: string } }>;
          };
        }).result;
        expect(result.queryLimit.value).toBe(20);
        expect(result.output.maxBytes).toBe(KNOWLEDGE_RELATION_QUERY_MAX_BYTES);
        expect(result.output.bytes).toBeLessThanOrEqual(KNOWLEDGE_RELATION_QUERY_MAX_BYTES);
        expect(result.output.truncated).toBe(false);
        expect(result.matches.map((match) => match.entity.name)).toEqual(
          expect.arrayContaining(Array.from({ length: 12 }, (_, index) => `Dependency${index}`)),
        );
      }

      const orient = allTools.find((candidate) => candidate.name === "unity_orient");
      expect(orient).toBeDefined();
      const oriented = await orient!.run(
        { task: "what handles audio?", problemLimit: 0 } as never,
        context
      );
      expect(oriented.ok).toBe(true);
      if (oriented.ok) {
        const brain = (oriented.data as {
          brain: { relevant?: { matchCount: { returned: number }; matches: unknown[] } };
        }).brain;
        expect(brain.relevant?.matchCount.returned).toBe(brain.relevant?.matches.length);
        expect(Buffer.byteLength(JSON.stringify(brain.relevant), "utf8")).toBeLessThanOrEqual(
          KNOWLEDGE_QUERY_MAX_BYTES
        );
      }
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("marks only successful, persistent writes dirty", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-map-invalidation-"));
    const manifestPath = path.join(knowledgeDirectory(projectPath), "manifest.json");
    const context = buildContext({
      bridgeOverride: createMockBridgeClient(),
      projectPath,
    });
    const tool = scriptWriteTool();

    try {
      await writeManifest(manifestPath);
      const success = await executeTool(tool, { path: "Assets/Player.cs" }, context);
      expect(success.ok).toBe(true);
      await expect(readDirty(manifestPath)).resolves.toMatchObject({
        value: true,
        reasons: [{ change: "unity_test_script_write: Assets/Player.cs" }],
      });

      await writeManifest(manifestPath);
      const preview = await executeTool(
        tool,
        { path: "Assets/Player.cs", preview: true },
        context
      );
      expect(preview.ok).toBe(true);
      await expect(readDirty(manifestPath)).resolves.toEqual({ value: false, reasons: [] });

      await writeManifest(manifestPath);
      const failed = await executeTool(
        scriptWriteTool(false),
        { path: "Assets/Player.cs" },
        context
      );
      expect(failed.ok).toBe(false);
      await expect(readDirty(manifestPath)).resolves.toEqual({ value: false, reasons: [] });

      await writeManifest(manifestPath);
      await writeConfig(projectPath, { ...DEFAULT_CONFIG, safetyMode: "read_only" });
      const blocked = await executeTool(tool, { path: "Assets/Player.cs" }, context);
      expect(blocked.ok).toBe(false);
      await expect(readDirty(manifestPath)).resolves.toEqual({ value: false, reasons: [] });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("bounds projected matches, facts, neighbors, evidence, and serialized output", () => {
    const raw = syntheticLargeQuery();
    const knowledge = {
      relations: raw.matches.flatMap((match) =>
        match.neighbors.map((neighbor) => neighbor.relation)
      ),
    } as KnowledgeBase;

    const projected = projectBrainQuery(raw, { knowledge, queryLimit: 20 });
    const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
    expect(bytes).toBeLessThanOrEqual(KNOWLEDGE_QUERY_MAX_BYTES);
    expect(projected.output.bytes).toBe(bytes);
    expect(projected.matchCount.total).toBe(20);
    expect(projected.matchCount.returned).toBe(projected.matches.length);
    expect(projected.matchCount.truncated).toBe(true);
    expect(projected.output.truncated).toBe(true);
    expect(projected.queryLimit).toEqual({ value: 20, reached: true });

    const first = projected.matches[0];
    expect(first.entity.factCount).toEqual({ total: 20, returned: 3, truncated: true });
    expect(first.neighborCount).toEqual({ total: 8, returned: 1, truncated: true });
    expect(first.entity.facts[0].provenance).toMatchObject({
      source: "csharp-text",
      line: 1,
      evidenceTruncated: true,
    });
    expect(first.entity.facts[0].provenance.path).toContain("HugeScript0.cs");
    expect(first.entity.facts[0].provenance.evidence?.length).toBeLessThanOrEqual(240);
  });

  it("refreshes a dirty project-brain resource before serving its index", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-map-resource-"));
    try {
      await copyDirectory(
        path.resolve("tests/fixtures/sample-unity-project"),
        projectPath
      );
      await generateBrain({ projectPath });
      await markBrainDirty(projectPath, "known MCP write");
      const indexPath = path.join(knowledgeDirectory(projectPath), "index.md");
      await fs.writeFile(indexPath, "STALE INDEX CLAIMING CLEAN\n", "utf8");

      const context = buildContext({
        bridgeOverride: createMockBridgeClient(),
        projectPath,
      });
      const resource = await readProjectBrainResource(context);
      expect(resource.contents[0].mimeType).toBe("text/markdown");
      expect(resource.contents[0].text).not.toContain("STALE INDEX CLAIMING CLEAN");
      await expect(readDirty(path.join(knowledgeDirectory(projectPath), "manifest.json")))
        .resolves.toEqual({ value: false, reasons: [] });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

function scriptWriteTool(succeeds = true): AnyToolDef {
  return {
    name: "unity_test_script_write",
    description: "Test-only script write used to verify project-map invalidation.",
    inputShape: {},
    requires: ["filesystem"],
    write: true,
    writeTarget: "script",
    async run() {
      return succeeds
        ? ok({ applied: false }, { source: "filesystem" })
        : err("INTERNAL_ERROR", "write failed", { source: "filesystem" });
    },
  };
}

async function writeManifest(manifestPath: string): Promise<void> {
  const manifest: KnowledgeManifest = {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: 1,
    project: { id: "project:test", path: ".", name: "Test", isUnityProject: true },
    coverage: {
      cap: 1,
      discovered: 0,
      scanned: 0,
      complete: true,
      truncated: false,
      errors: [],
      counts: {
        files: 0,
        firstPartyScripts: 0,
        packageScripts: 0,
        scenes: 0,
        prefabs: 0,
        entities: 0,
        relations: 0,
      },
      scopes: {
        firstParty: { root: "Assets", discovered: 0, scanned: 0, scripts: 0 },
        packages: { root: "Packages", discovered: 0, scanned: 0, scripts: 0 },
      },
    },
    fingerprint: { algorithm: "sha256", source: "test", content: "test" },
    dirty: { value: false, reasons: [] },
  };
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readDirty(manifestPath: string): Promise<KnowledgeManifest["dirty"]> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as KnowledgeManifest;
  return manifest.dirty;
}

function syntheticLargeQuery(): BrainQueryResult {
  const huge = "project-knowledge-evidence ".repeat(320);
  return {
    query: "which systems own project knowledge?",
    generatedAt: 1,
    matches: Array.from({ length: 20 }, (_, matchIndex) => {
      const entity = syntheticEntity(`type:huge-${matchIndex}`, matchIndex, huge);
      return {
        entity,
        score: 100 - matchIndex,
        neighbors: Array.from({ length: 8 }, (_, neighborIndex) => {
          const neighbor = syntheticEntity(
            `type:neighbor-${matchIndex}-${neighborIndex}`,
            neighborIndex,
            huge
          );
          return {
            relation: {
              id: `relation:${matchIndex}:${neighborIndex}`,
              kind: "references" as const,
              from: entity.id,
              to: neighbor.id,
              provenance: {
                source: "csharp-text" as const,
                path: `Assets/${huge}/HugeScript${matchIndex}.cs`,
                line: neighborIndex + 1,
                evidence: huge,
              },
              observedAt: 1,
            },
            entity: neighbor,
          };
        }),
      };
    }),
  };
}

function syntheticEntity(id: string, index: number, huge: string): KnowledgeEntity {
  return {
    id,
    kind: "type",
    name: `HugeType${index}${huge}`,
    path: `Assets/${huge}/HugeScript${index}.cs`,
    scope: "first-party",
    facts: Array.from({ length: 20 }, (_, factIndex) => ({
      key: `fact-${factIndex}-${huge}`,
      value: huge,
      provenance: {
        source: "csharp-text",
        path: `Assets/${huge}/HugeScript${index}.cs`,
        line: factIndex + 1,
        evidence: huge,
        heuristic: factIndex % 2 === 0,
      },
      observedAt: 1,
      confidence: 0.75,
    })),
  };
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}
