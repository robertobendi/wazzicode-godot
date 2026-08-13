import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBrainCurrent, generateBrain } from "@uvibe/project-brain";

const FIXTURE = path.resolve("tests/fixtures/sample-unity-project");
const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((projectPath) =>
    fs.rm(projectPath, { recursive: true, force: true })));
});

describe("project knowledge content freshness", () => {
  it("refreshes a same-size script edit after its mtime is restored", async () => {
    const projectPath = await copyFixture();
    const scriptPath = path.join(projectPath, "Assets/Scripts/PlayerController.cs");
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await fs.utimes(scriptPath, fixedTime, fixedTime);

    const generated = await generateBrain({ projectPath, write: true });
    const original = await fs.readFile(scriptPath, "utf8");
    const changed = original.replace("moveSpeed", "turnSpeed");
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));

    const metadataBefore = await fs.stat(scriptPath);
    await fs.writeFile(scriptPath, changed, "utf8");
    await fs.utimes(scriptPath, fixedTime, fixedTime);
    const metadataAfter = await fs.stat(scriptPath);
    expect(metadataAfter.size).toBe(metadataBefore.size);
    expect(metadataAfter.mtimeMs).toBe(metadataBefore.mtimeMs);

    const result = await ensureBrainCurrent(projectPath);
    expect(result.refreshed).toBe(true);
    expect(result.reason).toBe("changed");
    expect(result.knowledgeBase.manifest.fingerprint.source)
      .not.toBe(generated.knowledgeBase.manifest.fingerprint.source);
    const player = result.knowledgeBase.entities.find((entity) =>
      entity.kind === "type" && entity.name === "PlayerController");
    const signatures = player?.facts
      .filter((fact) => fact.key === "memberSignature")
      .map((fact) => String(fact.value)) ?? [];
    expect(signatures.some((signature) => signature.includes("turnSpeed"))).toBe(true);
    expect(signatures.some((signature) => signature.includes("moveSpeed"))).toBe(false);
  });

  it("refreshes same-size package manifest content with restored metadata", async () => {
    const projectPath = await copyFixture();
    const manifestPath = path.join(projectPath, "Packages/manifest.json");
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await fs.utimes(manifestPath, fixedTime, fixedTime);

    await generateBrain({ projectPath, write: true });
    const original = await fs.readFile(manifestPath, "utf8");
    const changed = original.replace('"1.7.0"', '"1.8.0"');
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    const metadataBefore = await fs.stat(manifestPath);
    await fs.writeFile(manifestPath, changed, "utf8");
    await fs.utimes(manifestPath, fixedTime, fixedTime);
    const metadataAfter = await fs.stat(manifestPath);
    expect(metadataAfter.size).toBe(metadataBefore.size);
    expect(metadataAfter.mtimeMs).toBe(metadataBefore.mtimeMs);

    const result = await ensureBrainCurrent(projectPath);
    expect(result.refreshed).toBe(true);
    expect(result.reason).toBe("changed");
    const inputSystemPackage = result.knowledgeBase.entities.find((entity) =>
      entity.kind === "package" && entity.name === "com.unity.inputsystem");
    expect(inputSystemPackage?.facts.some((fact) => fact.key === "version" && fact.value === "1.8.0"))
      .toBe(true);
  });
});

async function copyFixture(): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uvibe-knowledge-freshness-"));
  temporaryProjects.push(projectPath);
  await fs.cp(FIXTURE, projectPath, { recursive: true });
  return projectPath;
}
