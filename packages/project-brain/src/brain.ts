import { promises as fs } from "node:fs";
import { resolveProjectPath } from "@gvibe/safety";
import { detectGodotProject, type GodotAutoload, type GodotProjectDetection } from "./detect.js";
import { analyzeScripts, type ScriptHeuristics } from "./heuristics.js";
import { buildKnowledgeBase } from "./knowledge-builder.js";
import {
  atomicWriteFile,
  type KnowledgeBase,
  readKnowledgeBase,
  withKnowledgeProjectLock,
  writeKnowledgeBase,
} from "./knowledge.js";
import { scanProject, type ProjectScan } from "./scan.js";
import {
  DEFAULT_CONVENTIONS_MD,
  renderBrainMarkdown,
  renderClaudeContextMarkdown,
  renderKnowledgeIndexMarkdown,
} from "./templates.js";

export interface Brain {
  generatedAt: number;
  identity: {
    projectPath: string;
    isGodotProject: boolean;
    projectName?: string;
  };
  engine: {
    configVersion?: number;
    versionHint?: string;
    mainScene?: string;
    features: string[];
    renderer?: string;
    viewport?: { width?: number; height?: number };
    autoloads: GodotAutoload[];
    inputActions: string[];
    usesDotnet: boolean;
  };
  assets: ProjectScan;
  architecture: ScriptHeuristics;
}

export interface BrainGenerationOptions {
  projectPath: string;
  write?: boolean;
  maxFiles?: number;
}

export interface BrainGenerationResult {
  brain: Brain;
  knowledgeBase: KnowledgeBase;
  written: string[];
}

export type BrainFreshnessReason = "current" | "absent" | "dirty" | "changed" | "incomplete";

export interface EnsureBrainCurrentOptions {
  maxFiles?: number;
}

export interface EnsureBrainCurrentResult extends BrainGenerationResult {
  refreshed: boolean;
  reason: BrainFreshnessReason;
}

export interface BrainFreshnessStatus {
  exists: boolean;
  stale: boolean;
  reason: BrainFreshnessReason;
  ageMs?: number;
}

interface BrainFreshnessInspection {
  status: BrainFreshnessStatus;
  knowledgeBase: KnowledgeBase | null;
  brain: Brain | null;
  maxFiles?: number;
  scan?: ProjectScan;
}

export async function buildBrain(projectPath: string, opts: { maxFiles?: number } = {}): Promise<Brain> {
  const [detection, scan] = await Promise.all([
    detectGodotProject(projectPath),
    scanProject(projectPath, { maxFiles: opts.maxFiles }),
  ]);
  return buildBrainFromScan(projectPath, detection, scan);
}

export async function generateBrain(opts: BrainGenerationOptions): Promise<BrainGenerationResult> {
  if (opts.write === false) return generateBrainUnlocked(opts);
  return withKnowledgeProjectLock(opts.projectPath, () => generateBrainUnlocked(opts));
}

export async function ensureBrainCurrent(
  projectPath: string,
  opts: EnsureBrainCurrentOptions = {},
): Promise<EnsureBrainCurrentResult> {
  return withKnowledgeProjectLock(projectPath, () => ensureBrainCurrentUnlocked(projectPath, opts));
}

export async function inspectBrainFreshness(
  projectPath: string,
  opts: EnsureBrainCurrentOptions = {},
): Promise<BrainFreshnessStatus> {
  return (await inspectBrainFreshnessUnlocked(projectPath, opts)).status;
}

export async function readBrain(projectPath: string): Promise<Brain | null> {
  try {
    const file = (await resolveProjectPath(projectPath, ".godot-vibe/brain/project.json")).absolute;
    return JSON.parse(await fs.readFile(file, "utf8")) as Brain;
  } catch {
    return null;
  }
}

export async function brainAgeMs(projectPath: string): Promise<number | null> {
  const knowledge = await readKnowledgeBase(projectPath);
  if (knowledge) return Date.now() - knowledge.manifest.generatedAt;
  const brain = await readBrain(projectPath);
  return brain ? Date.now() - brain.generatedAt : null;
}

async function generateBrainUnlocked(opts: BrainGenerationOptions): Promise<BrainGenerationResult> {
  const [detection, scan] = await Promise.all([
    detectGodotProject(opts.projectPath),
    scanProject(opts.projectPath, { maxFiles: opts.maxFiles }),
  ]);
  return generateBrainFromScan(opts, detection, scan);
}

async function ensureBrainCurrentUnlocked(
  projectPath: string,
  opts: EnsureBrainCurrentOptions,
): Promise<EnsureBrainCurrentResult> {
  const inspected = await inspectBrainFreshnessUnlocked(projectPath, opts);
  if (!inspected.knowledgeBase) return refresh(projectPath, inspected.maxFiles, "absent");
  if (inspected.status.reason === "changed") {
    const detection = await detectGodotProject(projectPath);
    const generated = await generateBrainFromScan(
      { projectPath, write: true, maxFiles: inspected.maxFiles },
      detection,
      inspected.scan!,
    );
    return { ...generated, refreshed: true, reason: "changed" };
  }
  if (inspected.status.reason !== "current") {
    return refresh(projectPath, inspected.maxFiles, inspected.status.reason);
  }
  return {
    brain: inspected.brain!,
    knowledgeBase: inspected.knowledgeBase,
    written: [],
    refreshed: false,
    reason: "current",
  };
}

async function inspectBrainFreshnessUnlocked(
  projectPath: string,
  opts: EnsureBrainCurrentOptions,
): Promise<BrainFreshnessInspection> {
  const knowledgeBase = await readKnowledgeBase(projectPath);
  if (!knowledgeBase) {
    return {
      status: { exists: false, stale: false, reason: "absent" },
      knowledgeBase: null,
      brain: null,
      maxFiles: opts.maxFiles,
    };
  }
  const maxFiles = opts.maxFiles ?? knowledgeBase.manifest.coverage.cap;
  const ageMs = Date.now() - knowledgeBase.manifest.generatedAt;
  const stale = (reason: Exclude<BrainFreshnessReason, "current" | "absent">): BrainFreshnessInspection => ({
    status: { exists: true, stale: true, reason, ageMs },
    knowledgeBase,
    brain: null,
    maxFiles,
  });
  if (knowledgeBase.manifest.dirty.value) return stale("dirty");
  if (!(await generatedFilesAreCurrent(projectPath, knowledgeBase))) return stale("incomplete");
  const scan = await scanProject(projectPath, { maxFiles });
  if (scan.coverage.sourceFingerprint !== knowledgeBase.manifest.fingerprint.source) {
    return { ...stale("changed"), scan };
  }
  const brain = await readBrain(projectPath);
  if (!brain) return stale("incomplete");
  return {
    status: { exists: true, stale: false, reason: "current", ageMs },
    knowledgeBase,
    brain,
    maxFiles,
    scan,
  };
}

async function buildBrainFromScan(
  projectPath: string,
  detection: GodotProjectDetection,
  scan: ProjectScan,
): Promise<Brain> {
  const architecture = await analyzeScripts(projectPath, scan.scripts);
  return {
    generatedAt: Date.now(),
    identity: {
      projectPath,
      isGodotProject: detection.isGodotProject,
      projectName: detection.projectName,
    },
    engine: {
      configVersion: detection.configVersion,
      versionHint: detection.features.find((feature) => /^\d+\.\d+/.test(feature)),
      mainScene: detection.mainScene,
      features: detection.features,
      renderer: detection.renderer,
      viewport: detection.viewport,
      autoloads: detection.autoloads,
      inputActions: detection.inputActions,
      usesDotnet: detection.usesDotnet,
    },
    assets: scan,
    architecture,
  };
}

async function generateBrainFromScan(
  opts: BrainGenerationOptions,
  detection: GodotProjectDetection,
  scan: ProjectScan,
): Promise<BrainGenerationResult> {
  const brain = await buildBrainFromScan(opts.projectPath, detection, scan);
  const { knowledgeBase } = await buildKnowledgeBase(opts.projectPath, brain, scan);
  const written: string[] = [];
  if (opts.write ?? true) {
    const [
      directory,
      projectPath,
      overviewPath,
      contextPath,
      conventionsPath,
    ] = await Promise.all([
      resolveProjectPath(opts.projectPath, ".godot-vibe/brain").then(({ absolute }) => absolute),
      resolveProjectPath(opts.projectPath, ".godot-vibe/brain/project.json").then(({ absolute }) => absolute),
      resolveProjectPath(opts.projectPath, ".godot-vibe/brain/overview.md").then(({ absolute }) => absolute),
      resolveProjectPath(opts.projectPath, ".godot-vibe/brain/agent-context.md").then(({ absolute }) => absolute),
      resolveProjectPath(opts.projectPath, ".godot-vibe/conventions.md").then(({ absolute }) => absolute),
    ]);
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
      atomicWriteFile(projectPath, `${JSON.stringify(brain, null, 2)}\n`),
      atomicWriteFile(overviewPath, renderBrainMarkdown(brain, knowledgeBase.manifest)),
      atomicWriteFile(contextPath, renderClaudeContextMarkdown(brain, knowledgeBase.manifest)),
    ]);
    written.push(projectPath, overviewPath, contextPath);
    written.push(...await writeKnowledgeBase(opts.projectPath, knowledgeBase, renderKnowledgeIndexMarkdown(knowledgeBase)));
    if (!(await fileExists(conventionsPath))) {
      await atomicWriteFile(conventionsPath, DEFAULT_CONVENTIONS_MD);
      written.push(conventionsPath);
    }
  }
  return { brain, knowledgeBase, written };
}

async function refresh(
  projectPath: string,
  maxFiles: number | undefined,
  reason: Exclude<BrainFreshnessReason, "current" | "changed">,
): Promise<EnsureBrainCurrentResult> {
  const generated = await generateBrainUnlocked({ projectPath, write: true, maxFiles });
  return { ...generated, refreshed: true, reason };
}

async function generatedFilesAreCurrent(projectPath: string, knowledgeBase: KnowledgeBase): Promise<boolean> {
  try {
    const [indexPath, generatedProjectPath] = await Promise.all([
      resolveProjectPath(projectPath, ".godot-vibe/brain/index.md").then(({ absolute }) => absolute),
      resolveProjectPath(projectPath, ".godot-vibe/brain/project.json").then(({ absolute }) => absolute),
    ]);
    const index = await fs.readFile(indexPath, "utf8");
    await fs.access(generatedProjectPath);
    return index === renderKnowledgeIndexMarkdown(knowledgeBase);
  } catch {
    return false;
  }
}

async function fileExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}
