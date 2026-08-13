import { promises as fs } from "node:fs";
import path from "node:path";
import { writeConfigIfMissing } from "@uvibe/safety";
import { detectUnityProject, UnityProjectDetection } from "./detect.js";
import { scanProject, ProjectScan } from "./scan.js";
import { analyzeScripts, ScriptHeuristics } from "./heuristics.js";
import {
  renderBrainMarkdown,
  renderClaudeContextMarkdown,
  renderKnowledgeIndexMarkdown,
  DEFAULT_CONVENTIONS_MD,
} from "./templates.js";
import { buildKnowledgeBase } from "./knowledge-builder.js";
import {
  atomicWriteFile,
  KnowledgeBase,
  readKnowledgeBase,
  withKnowledgeProjectLock,
  writeKnowledgeBase,
} from "./knowledge.js";

export interface Brain {
  generatedAt: number;
  identity: {
    projectPath: string;
    isUnityProject: boolean;
    productName?: string;
    companyName?: string;
    bundleIdentifier?: string;
  };
  engine: {
    unityVersion?: string;
    unityRevision?: string;
    renderPipeline?: string;
    inputSystem?: string;
    scriptingBackend?: string;
    defaultBuildTarget?: string;
    packages?: Array<{ name: string; version: string }>;
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

export async function buildBrain(projectPath: string, opts: { maxFiles?: number } = {}): Promise<Brain> {
  const [detection, scan] = await Promise.all([
    detectUnityProject(projectPath),
    scanProject(projectPath, { maxFiles: opts.maxFiles }),
  ]);
  return buildBrainFromScan(projectPath, detection, scan);
}

export async function generateBrain(opts: BrainGenerationOptions): Promise<BrainGenerationResult> {
  if (opts.write === false) return generateBrainUnlocked(opts);
  return withKnowledgeProjectLock(opts.projectPath, () => generateBrainUnlocked(opts));
}

async function generateBrainUnlocked(opts: BrainGenerationOptions): Promise<BrainGenerationResult> {
  const [detection, scan] = await Promise.all([
    detectUnityProject(opts.projectPath),
    scanProject(opts.projectPath, { maxFiles: opts.maxFiles }),
  ]);
  return generateBrainFromScan(opts, detection, scan);
}

export async function ensureBrainCurrent(
  projectPath: string,
  opts: EnsureBrainCurrentOptions = {},
): Promise<EnsureBrainCurrentResult> {
  return withKnowledgeProjectLock(projectPath, () => ensureBrainCurrentUnlocked(projectPath, opts));
}

async function ensureBrainCurrentUnlocked(
  projectPath: string,
  opts: EnsureBrainCurrentOptions,
): Promise<EnsureBrainCurrentResult> {
  const existing = await readKnowledgeBase(projectPath);
  if (!existing) return refresh(projectPath, opts.maxFiles, "absent");
  const maxFiles = opts.maxFiles ?? existing.manifest.coverage.cap;
  if (existing.manifest.dirty.value) {
    return refresh(projectPath, maxFiles, "dirty");
  }
  if (!(await knowledgeIndexIsCurrent(projectPath, existing))) {
    return refresh(projectPath, maxFiles, "incomplete");
  }
  const scan = await scanProject(projectPath, { maxFiles });
  if (scan.coverage.sourceFingerprint !== existing.manifest.fingerprint.source) {
    const detection = await detectUnityProject(projectPath);
    const generated = await generateBrainFromScan({ projectPath, write: true, maxFiles }, detection, scan);
    return { ...generated, refreshed: true, reason: "changed" };
  }

  const legacy = await readBrain(projectPath);
  if (!legacy) return refresh(projectPath, maxFiles, "incomplete");
  return {
    brain: legacy,
    knowledgeBase: existing,
    written: [],
    refreshed: false,
    reason: "current",
  };
}

export async function readBrain(projectPath: string): Promise<Brain | null> {
  const file = path.join(projectPath, ".unity-vibe", "project_brain.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as Brain;
  } catch {
    return null;
  }
}

export async function brainAgeMs(projectPath: string): Promise<number | null> {
  const knowledge = await readKnowledgeBase(projectPath);
  if (knowledge) return Date.now() - knowledge.manifest.generatedAt;
  const brain = await readBrain(projectPath);
  if (!brain) return null;
  return Date.now() - brain.generatedAt;
}

async function buildBrainFromScan(
  projectPath: string,
  detection: UnityProjectDetection,
  scan: ProjectScan,
): Promise<Brain> {
  const arch = await analyzeScripts(projectPath, scan.scripts);
  return {
    generatedAt: Date.now(),
    identity: {
      projectPath,
      isUnityProject: detection.isUnityProject,
      productName: detection.productName,
      companyName: detection.companyName,
      bundleIdentifier: detection.bundleIdentifier,
    },
    engine: {
      unityVersion: detection.unityVersion,
      unityRevision: detection.unityRevision,
      renderPipeline: detection.renderPipeline,
      inputSystem: detection.inputSystem,
      scriptingBackend: detection.scriptingBackend,
      defaultBuildTarget: detection.defaultBuildTarget,
      packages: detection.packages,
    },
    assets: scan,
    architecture: arch,
  };
}

async function generateBrainFromScan(
  opts: BrainGenerationOptions,
  detection: UnityProjectDetection,
  scan: ProjectScan,
): Promise<BrainGenerationResult> {
  const brain = await buildBrainFromScan(opts.projectPath, detection, scan);
  const { knowledgeBase } = await buildKnowledgeBase(opts.projectPath, brain, scan);
  const written: string[] = [];
  if (opts.write ?? true) {
    const dir = path.join(opts.projectPath, ".unity-vibe");
    await fs.mkdir(dir, { recursive: true });

    const jsonPath = path.join(dir, "project_brain.json");
    const mdPath = path.join(dir, "project_brain.md");
    const claudeCtxPath = path.join(dir, "claude_context.md");
    await Promise.all([
      atomicWriteFile(jsonPath, JSON.stringify(brain, null, 2) + "\n"),
      atomicWriteFile(mdPath, renderBrainMarkdown(brain, knowledgeBase.manifest)),
      atomicWriteFile(claudeCtxPath, renderClaudeContextMarkdown(brain, knowledgeBase.manifest)),
    ]);
    written.push(jsonPath, mdPath, claudeCtxPath);

    const knowledgeWritten = await writeKnowledgeBase(
      opts.projectPath,
      knowledgeBase,
      renderKnowledgeIndexMarkdown(knowledgeBase),
    );
    written.push(...knowledgeWritten);

    const conventionsPath = path.join(dir, "conventions.md");
    if (!(await fileExists(conventionsPath))) {
      await atomicWriteFile(conventionsPath, DEFAULT_CONVENTIONS_MD);
      written.push(conventionsPath);
    }

    const cfg = await writeConfigIfMissing(opts.projectPath);
    if (cfg.written) written.push(cfg.path);
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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function knowledgeIndexIsCurrent(projectPath: string, knowledgeBase: KnowledgeBase): Promise<boolean> {
  try {
    const indexPath = path.join(projectPath, ".unity-vibe", "knowledge", "index.md");
    return await fs.readFile(indexPath, "utf8") === renderKnowledgeIndexMarkdown(knowledgeBase);
  } catch {
    return false;
  }
}
