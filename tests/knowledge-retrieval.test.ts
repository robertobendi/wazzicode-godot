import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateBrain, queryBrain } from "@uvibe/project-brain";

const FIXTURE = path.resolve("tests/fixtures/sample-unity-project");

describe("project knowledge retrieval", () => {
  it("ranks the first-party owner for natural saving questions without hiding packages", async () => {
    await withFixture(async (projectPath) => {
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/Save/SaveManager.cs",
        "public static class SaveManager { public static void SaveGame() {} public static void LoadGame() {} }\n",
      );
      await writeProjectFile(
        projectPath,
        "Packages/com.example.save/Runtime/SavePackage.cs",
        "public class SavePackage {}\n",
      );
      for (let index = 0; index < 24; index++) {
        await writeProjectFile(
          projectPath,
          `Assets/Plugins/Vendor/InputActionSetHandle${index}.cs`,
          `public class InputActionSetHandle${index} {}\n`,
        );
      }
      await generateBrain({ projectPath, write: true });

      for (const query of ["what handles saving?", "where is save data persisted?"]) {
        const result = await queryBrain(projectPath, { query, limit: 10 });
        expect(result.matches[0]?.entity.name).toBe("SaveManager");
        expect(result.matches[0]?.entity.kind).toBe("type");
        expect(result.matches[0]?.entity.scope).toBe("first-party");
        expect(result.matches.slice(0, 5).some((match) => match.entity.name.includes("Handle"))).toBe(false);
      }

      const packageResult = await queryBrain(projectPath, {
        query: "package com.example.save",
        limit: 5,
      });
      expect(packageResult.matches[0]?.entity.kind).toBe("package");
      expect(packageResult.matches[0]?.entity.name).toBe("com.example.save");
    });
  });

  it("returns every script contained by a matching module without package-token noise", async () => {
    await withFixture(async (projectPath) => {
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/Combat/AttackResolver.cs",
        "public class AttackResolver {}\n",
      );
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/Combat/DamageResolver.cs",
        "public class DamageResolver {}\n",
      );
      await generateBrain({ projectPath, write: true });

      const result = await queryBrain(projectPath, { query: "scripts in the combat module" });
      expect(result.matches.map((match) => match.entity.name)).toEqual([
        "AttackResolver",
        "DamageResolver",
      ]);
      expect(result.matches.every((match) => match.entity.kind === "script")).toBe(true);
      expect(result.matches.every((match) => match.entity.scope === "first-party")).toBe(true);
    });
  });

  it("returns complete derived sets and neighbor evidence through twenty relationships", async () => {
    await withFixture(async (projectPath) => {
      const derivedNames = Array.from({ length: 12 }, (_, index) => `DerivedAsset${index}`);
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/DerivedAssets.cs",
        `${derivedNames.map((name) => `public class ${name} : ScriptableObject {}`).join("\n")}\n`,
      );
      await generateBrain({ projectPath, write: true });

      const result = await queryBrain(projectPath, {
        query: "types derived from ScriptableObject",
        kinds: ["type"],
      });
      expect(result.matches).toHaveLength(13);
      expect(result.matches.map((match) => match.entity.name)).toEqual(
        expect.arrayContaining([...derivedNames, "WeaponData"]),
      );

      const base = await queryBrain(projectPath, {
        query: "ScriptableObject",
        kinds: ["type"],
        limit: 1,
      });
      expect(base.matches[0]?.entity.name).toBe("ScriptableObject");
      expect(base.matches[0]?.neighbors.filter((neighbor) => neighbor.relation.kind === "derives"))
        .toHaveLength(13);
    });
  });

  it("returns every direct dependency when the bounded set fits", async () => {
    await withFixture(async (projectPath) => {
      const dependencyNames = Array.from({ length: 12 }, (_, index) => `Dependency${index}`);
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/DependencyGraph.cs",
        [
          ...dependencyNames.map((name) => `public class ${name} {}`),
          "public class Central",
          "{",
          ...dependencyNames.map((name, index) => `    private ${name} dependency${index};`),
          "}",
          "",
        ].join("\n"),
      );
      await generateBrain({ projectPath, write: true });

      const result = await queryBrain(projectPath, {
        query: "Central dependencies",
        kinds: ["type"],
      });
      expect(result.matches).toHaveLength(dependencyNames.length);
      expect(result.matches.map((match) => match.entity.name)).toEqual(
        expect.arrayContaining(dependencyNames),
      );
    });
  });

  it("keeps late runtime methods searchable and ranks them above editor and test helpers", async () => {
    await withFixture(async (projectPath) => {
      const fields = Array.from({ length: 300 }, (_, index) => `    private int field${index};`);
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/TargetSpawnProfile.cs",
        "public class TargetSpawnProfile { public class SpawnEvent {} public SpawnEvent[] events; }\n",
      );
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/SpawnPoints.cs",
        "public class SpawnPoint {}\npublic class SpawnZone {}\n",
      );
      await writeProjectFile(
        projectPath,
        "Assets/Scripts/Managers/LevelManager.cs",
        [
          "public class LevelManager",
          "{",
          ...fields,
          "    private TargetSpawnProfile spawnProfile;",
          "    private TargetSpawnProfile.SpawnEvent currentEvent;",
          "    private SpawnPoint spawnPoint;",
          "    private SpawnZone activeZone;",
          "    private void SpawnScheduledTargets() {}",
          "    private void LogAuthoredSpawnRetry() {}",
          "    private void SpawnTargetInZone() {}",
          "}",
          "",
        ].join("\n"),
      );
      await writeProjectFile(
        projectPath,
        "Assets/Editor/LevelManagerSpawnTests.cs",
        "public class LevelManagerSpawnTests { public void ScheduledSpawnRetriesSafePointInActiveZone() {} }\n",
      );
      await writeProjectFile(
        projectPath,
        "Assets/Editor/TargetSpawnProfileEditorWindow.cs",
        "public class TargetSpawnProfileEditorWindow { public void DrawSpawnEventSchedule() {} }\n",
      );
      await generateBrain({ projectPath, write: true });

      for (const query of [
        "What handles scheduled target spawn events, including retrying until a safe point in an active zone?",
        "Which runtime type consumes TargetSpawnProfile SpawnEvent schedules and retries a safe point in the active zone?",
        "LevelManager SpawnTargetsOnSchedule",
      ]) {
        const result = await queryBrain(projectPath, { query, limit: 8 });
        expect(
          result.matches[0]?.entity.name,
          `${query}: ${result.matches.map((match) => `${match.score}:${match.entity.name}`).join(", ")}`,
        ).toBe("LevelManager");
        expect(result.matches[0]?.entity.facts).toEqual(expect.arrayContaining([
          expect.objectContaining({
            key: "memberSignature",
            value: "private void SpawnScheduledTargets()",
          }),
          expect.objectContaining({ key: "memberSignatureCount", value: 307 }),
          expect.objectContaining({ key: "memberSignaturesTruncated", value: true }),
        ]));
      }
    });
  });
});

async function withFixture(run: (projectPath: string) => Promise<void>): Promise<void> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-knowledge-retrieval-"));
  try {
    await copyDirectory(FIXTURE, projectPath);
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

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}
