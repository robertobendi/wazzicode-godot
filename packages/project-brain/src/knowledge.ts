import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "@gvibe/safety";

export const KNOWLEDGE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_KNOWLEDGE_SCAN_CAP = 25_000;

export type KnowledgeEntityKind =
  | "project"
  | "addon"
  | "scene"
  | "resource"
  | "script"
  | "class"
  | "module"
  | "shader";

export type KnowledgeRelationKind = "contains" | "declares" | "extends" | "references" | "instantiates";
export type KnowledgeScope = "project" | "first-party" | "addon" | "external";
export type KnowledgeSourceKind =
  | "filesystem"
  | "project-settings"
  | "gdscript-text"
  | "godot-resource"
  | "csharp-text"
  | "derived";
export type KnowledgeFactValue = string | number | boolean | string[];

export interface KnowledgeProvenance {
  source: KnowledgeSourceKind;
  path: string;
  line?: number;
  evidence?: string;
  heuristic?: boolean;
}

export interface KnowledgeFact {
  key: string;
  value: KnowledgeFactValue;
  provenance: KnowledgeProvenance;
  observedAt: number;
  confidence?: number;
}

export interface KnowledgeEntity {
  id: string;
  kind: KnowledgeEntityKind;
  name: string;
  path?: string;
  scope: KnowledgeScope;
  facts: KnowledgeFact[];
}

export interface KnowledgeRelation {
  id: string;
  kind: KnowledgeRelationKind;
  from: string;
  to: string;
  provenance: KnowledgeProvenance;
  observedAt: number;
  confidence?: number;
}

export interface KnowledgeScanError {
  path: string;
  message: string;
}

export interface KnowledgeScopeCoverage {
  root: "res://" | "res://addons";
  discovered: number;
  scanned: number;
  scripts: number;
}

export interface KnowledgeManifest {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  generatedAt: number;
  project: {
    id: string;
    path: ".";
    name: string;
    isGodotProject: boolean;
  };
  coverage: {
    cap: number;
    discovered: number;
    scanned: number;
    complete: boolean;
    truncated: boolean;
    errors: KnowledgeScanError[];
    counts: {
      files: number;
      firstPartyScripts: number;
      addonScripts: number;
      scenes: number;
      resources: number;
      shaders: number;
      entities: number;
      relations: number;
    };
    scopes: {
      firstParty: KnowledgeScopeCoverage;
      addons: KnowledgeScopeCoverage;
    };
  };
  fingerprint: {
    algorithm: "sha256";
    source: string;
    content: string;
  };
  dirty: {
    value: boolean;
    reasons: KnowledgeDirtyReason[];
  };
}

export interface KnowledgeDirtyReason {
  at: number;
  change: string;
}

export interface KnowledgeBase {
  manifest: KnowledgeManifest;
  entities: KnowledgeEntity[];
  relations: KnowledgeRelation[];
}

export interface BrainQueryOptions {
  query: string;
  kinds?: KnowledgeEntityKind[];
  limit?: number;
}

export interface BrainQueryNeighbor {
  relation: KnowledgeRelation;
  entity: KnowledgeEntity;
}

export interface BrainQueryMatch {
  entity: KnowledgeEntity;
  score: number;
  neighbors: BrainQueryNeighbor[];
}

export interface BrainQueryResult {
  query: string;
  generatedAt: number;
  matches: BrainQueryMatch[];
}

export interface KnowledgeLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

interface KnowledgeLockOwner {
  pid: number;
  createdAt: number;
  token: string;
}

interface RankedEntity {
  entity: KnowledgeEntity;
  score: number;
}

const operationQueues = new Map<string, Promise<void>>();
export const KNOWLEDGE_LOCK_TIMEOUT_MS = 11 * 60_000;
export const KNOWLEDGE_LOCK_STALE_MS = 30_000;
const KNOWLEDGE_LOCK_POLL_MS = 40;

export function knowledgeDirectory(projectPath: string): string {
  return path.join(projectPath, ".godot-vibe", "brain");
}

export async function readKnowledgeBase(projectPath: string): Promise<KnowledgeBase | null> {
  let directory: string;
  try {
    directory = (await resolveProjectPath(projectPath, ".godot-vibe/brain")).absolute;
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await readKnowledgeBaseOnce(directory);
    if (result) return result;
  }
  return null;
}

export async function queryBrain(projectPath: string, opts: BrainQueryOptions): Promise<BrainQueryResult> {
  const brain = await readKnowledgeBase(projectPath);
  if (!brain) return { query: opts.query, generatedAt: 0, matches: [] };
  const allowedKinds = opts.kinds ? new Set(opts.kinds) : null;
  const byId = new Map(brain.entities.map((entity) => [entity.id, entity]));
  const relationMatch = matchStructuredQuery(brain, opts.query, allowedKinds, byId);
  const tokens = tokenize(opts.query);
  const naturalQuestion = /\b(?:how|what|where|which|who|why|find|handle|locate)\b/i.test(opts.query);
  const lexical = brain.entities
    .filter((entity) => !allowedKinds || allowedKinds.has(entity.kind))
    .map((entity) => ({ entity, score: lexicalScore(entity, tokens, opts.query, naturalQuestion) }))
    .filter((entry) => entry.score > 0)
    .sort(compareRanked);
  const ranked = suppressDuplicateScripts(relationMatch ?? lexical, naturalQuestion).slice(
    0,
    clampLimit(opts.limit, brainQueryDefaultLimit(opts.query)),
  );
  const relations = relationIndex(brain.relations);
  return {
    query: opts.query,
    generatedAt: brain.manifest.generatedAt,
    matches: ranked.map(({ entity, score }) => ({
      entity,
      score,
      neighbors: (relations.get(entity.id) ?? [])
        .flatMap((relation) => {
          const other = byId.get(relation.from === entity.id ? relation.to : relation.from);
          return other ? [{ relation, entity: other }] : [];
        })
        .sort((a, b) => neighborScore(b.entity, tokens) - neighborScore(a.entity, tokens)
          || a.relation.id.localeCompare(b.relation.id))
        .slice(0, 20),
    })),
  };
}

export function brainQueryDefaultLimit(query: string): number {
  return parseStructuredQuery(query) ? 20 : 6;
}

export async function markBrainDirty(projectPath: string, change: string): Promise<KnowledgeManifest | null> {
  return withKnowledgeProjectLock(projectPath, async () => {
    const manifestPath = (await resolveProjectPath(projectPath, ".godot-vibe/brain/manifest.json")).absolute;
    let manifest: KnowledgeManifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as KnowledgeManifest;
    } catch {
      return null;
    }
    manifest.dirty = {
      value: true,
      reasons: [...manifest.dirty.reasons, {
        at: Date.now(),
        change: change.trim() || "unspecified project change",
      }].slice(-100),
    };
    await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  });
}

export async function withKnowledgeProjectLock<T>(
  projectPath: string,
  operation: () => Promise<T>,
  opts: KnowledgeLockOptions = {},
): Promise<T> {
  const key = path.resolve(projectPath);
  const prior = operationQueues.get(key) ?? Promise.resolve();
  let releaseQueue = (): void => undefined;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queued = prior.catch(() => undefined).then(() => current);
  operationQueues.set(key, queued);
  await prior.catch(() => undefined);
  let releaseFilesystem: (() => Promise<void>) | undefined;
  try {
    releaseFilesystem = await acquireFilesystemLock(key, opts);
    return await operation();
  } finally {
    await releaseFilesystem?.();
    releaseQueue();
    if (operationQueues.get(key) === queued) operationQueues.delete(key);
  }
}

export async function writeKnowledgeBase(
  projectPath: string,
  brain: KnowledgeBase,
  indexMarkdown: string,
): Promise<string[]> {
  const [directory, manifestPath, entitiesPath, relationsPath, indexPath] = await Promise.all([
    resolveProjectPath(projectPath, ".godot-vibe/brain").then(({ absolute }) => absolute),
    resolveProjectPath(projectPath, ".godot-vibe/brain/manifest.json").then(({ absolute }) => absolute),
    resolveProjectPath(projectPath, ".godot-vibe/brain/entities.jsonl").then(({ absolute }) => absolute),
    resolveProjectPath(projectPath, ".godot-vibe/brain/relations.jsonl").then(({ absolute }) => absolute),
    resolveProjectPath(projectPath, ".godot-vibe/brain/index.md").then(({ absolute }) => absolute),
  ]);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    atomicWriteFile(entitiesPath, toJsonLines(brain.entities)),
    atomicWriteFile(relationsPath, toJsonLines(brain.relations)),
    atomicWriteFile(indexPath, indexMarkdown),
  ]);
  await atomicWriteFile(manifestPath, `${JSON.stringify(brain.manifest, null, 2)}\n`);
  return [manifestPath, entitiesPath, relationsPath, indexPath];
}

export function knowledgeContentFingerprint(
  entities: KnowledgeEntity[],
  relations: KnowledgeRelation[],
): string {
  return sha256(`${toJsonLines(entities)}\0${toJsonLines(relations)}`);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function atomicWriteFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, contents, "utf8");
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readKnowledgeBaseOnce(directory: string): Promise<KnowledgeBase | null> {
  const manifestPath = path.join(directory, "manifest.json");
  try {
    const before = await fs.readFile(manifestPath, "utf8");
    const [entitiesRaw, relationsRaw] = await Promise.all([
      fs.readFile(path.join(directory, "entities.jsonl"), "utf8"),
      fs.readFile(path.join(directory, "relations.jsonl"), "utf8"),
    ]);
    const after = await fs.readFile(manifestPath, "utf8");
    if (before !== after) return null;
    const manifest = JSON.parse(after) as KnowledgeManifest;
    if (manifest.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) return null;
    const entities = parseJsonLines<KnowledgeEntity>(entitiesRaw);
    const relations = parseJsonLines<KnowledgeRelation>(relationsRaw);
    if (manifest.coverage.counts.entities !== entities.length) return null;
    if (manifest.coverage.counts.relations !== relations.length) return null;
    if (manifest.fingerprint.content !== knowledgeContentFingerprint(entities, relations)) return null;
    const entityIds = new Set(entities.map((entity) => entity.id));
    const relationIds = new Set(relations.map((relation) => relation.id));
    if (entityIds.size !== entities.length || relationIds.size !== relations.length) return null;
    if (relations.some((relation) => !entityIds.has(relation.from) || !entityIds.has(relation.to))) return null;
    return { manifest, entities, relations };
  } catch {
    return null;
  }
}

async function acquireFilesystemLock(
  projectPath: string,
  opts: KnowledgeLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = boundedDuration(opts.timeoutMs, KNOWLEDGE_LOCK_TIMEOUT_MS, 1, 15 * 60_000, "timeoutMs");
  const staleMs = boundedDuration(opts.staleMs, KNOWLEDGE_LOCK_STALE_MS, 100, 15 * 60_000, "staleMs");
  const pollMs = boundedDuration(opts.pollMs, KNOWLEDGE_LOCK_POLL_MS, 5, 1_000, "pollMs");
  const [lockPath, ownerPath] = await Promise.all([
    resolveProjectPath(projectPath, ".godot-vibe/brain.lock").then(({ absolute }) => absolute),
    resolveProjectPath(projectPath, ".godot-vibe/brain.lock/owner.json").then(({ absolute }) => absolute),
  ]);
  const parent = path.dirname(lockPath);
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(parent, { recursive: true });
  for (;;) {
    const owner: KnowledgeLockOwner = { pid: process.pid, createdAt: Date.now(), token: randomUUID() };
    try {
      await fs.mkdir(lockPath);
      try {
        await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      const heartbeatMs = Math.max(50, Math.min(2_000, Math.floor(staleMs / 3)));
      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lockPath, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        const currentOwner = await readOwner(ownerPath);
        if (currentOwner?.token === owner.token) await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await recoverStaleLock(lockPath, ownerPath, staleMs)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for project brain lock at ${lockPath}`);
      await delay(Math.min(pollMs, remaining));
    }
  }
}

async function recoverStaleLock(lockPath: string, ownerPath: string, staleMs: number): Promise<boolean> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const owner = await readOwner(ownerPath);
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner && Date.now() - stat.mtimeMs <= staleMs) return false;
  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await fs.rename(lockPath, stalePath);
  } catch (error) {
    return ["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "");
  }
  await fs.rm(stalePath, { recursive: true, force: true });
  return true;
}

async function readOwner(ownerPath: string): Promise<KnowledgeLockOwner | null> {
  try {
    const value = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Partial<KnowledgeLockOwner>;
    return typeof value.pid === "number" && typeof value.createdAt === "number" && typeof value.token === "string"
      ? { pid: value.pid, createdAt: value.createdAt, token: value.token }
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type StructuredQuery =
  | { kind: "extends"; target: string }
  | { kind: "module"; target: string }
  | { kind: "dependencies"; target: string; incoming: boolean };

function parseStructuredQuery(query: string): StructuredQuery | null {
  const extendsMatch = /\b(?:classes?|scripts?|types?)\s+(?:that\s+)?(?:extend|extends|extending|inherit|inherits)\s+(?:from\s+)?([A-Za-z_]\w*)/i.exec(query);
  if (extendsMatch) return { kind: "extends", target: extendsMatch[1] };
  const moduleMatch = /\bscripts?\s+(?:contained\s+)?in\s+(?:the\s+)?(.+?)\s+module\b/i.exec(query);
  if (moduleMatch) return { kind: "module", target: moduleMatch[1].trim() };
  const dependencyMatch = /^\s*([A-Za-z_]\w*)\s+(dependencies|dependents|references)\s*[?!.]*\s*$/i.exec(query);
  if (dependencyMatch) {
    return {
      kind: "dependencies",
      target: dependencyMatch[1],
      incoming: dependencyMatch[2].toLowerCase() === "dependents",
    };
  }
  return null;
}

function matchStructuredQuery(
  brain: KnowledgeBase,
  query: string,
  allowedKinds: Set<KnowledgeEntityKind> | null,
  byId: Map<string, KnowledgeEntity>,
): RankedEntity[] | null {
  const parsed = parseStructuredQuery(query);
  if (!parsed) return null;
  if (parsed.kind === "extends") {
    const targets = new Set(brain.entities.filter((entity) => entity.kind === "class" && entityMatches(entity, parsed.target)).map((entity) => entity.id));
    return uniqueRanked(brain.relations.flatMap((relation) => {
      const entity = relation.kind === "extends" && targets.has(relation.to) ? byId.get(relation.from) : undefined;
      return entity && (!allowedKinds || allowedKinds.has(entity.kind)) ? [{ entity, score: 250 }] : [];
    }));
  }
  if (parsed.kind === "module") {
    const modules = brain.entities.filter((entity) => entity.kind === "module" && entityMatches(entity, parsed.target));
    const contains = new Map<string, KnowledgeRelation[]>();
    for (const relation of brain.relations) {
      if (relation.kind === "contains") addToList(contains, relation.from, relation);
    }
    const queue = modules.map((entity) => entity.id);
    const visited = new Set(queue);
    const matches: RankedEntity[] = [];
    while (queue.length) {
      const owner = queue.shift()!;
      for (const relation of contains.get(owner) ?? []) {
        const entity = byId.get(relation.to);
        if (!entity) continue;
        if (entity.kind === "module" && !visited.has(entity.id)) {
          visited.add(entity.id);
          queue.push(entity.id);
        } else if (entity.kind === "script" && (!allowedKinds || allowedKinds.has("script"))) {
          matches.push({ entity, score: 250 });
        }
      }
    }
    return uniqueRanked(matches);
  }
  const subjects = new Set(brain.entities.filter((entity) => entityMatches(entity, parsed.target)).map((entity) => entity.id));
  return uniqueRanked(brain.relations.flatMap((relation) => {
    if (!["extends", "references", "instantiates"].includes(relation.kind)) return [];
    const related = parsed.incoming
      ? subjects.has(relation.to) ? byId.get(relation.from) : undefined
      : subjects.has(relation.from) ? byId.get(relation.to) : undefined;
    return related && (!allowedKinds || allowedKinds.has(related.kind)) ? [{ entity: related, score: 250 }] : [];
  }));
}

function lexicalScore(
  entity: KnowledgeEntity,
  queryTokens: string[],
  rawQuery: string,
  naturalQuestion: boolean,
): number {
  if (!queryTokens.length) return 0;
  const nameTokens = new Set(tokenize(entity.name));
  const pathTokens = new Set(tokenize(entity.path ?? ""));
  const factsText = entity.facts.map((fact) => `${fact.key} ${factValueText(fact.value)}`).join(" ");
  const factTokens = new Set(tokenize(factsText));
  let score = entity.name.toLowerCase() === rawQuery.trim().toLowerCase() ? 120 : 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 30;
    if (pathTokens.has(token)) score += 9;
    if (factTokens.has(token)) score += 7;
  }
  if (score === 0) return 0;
  if (entity.scope === "first-party") score += 18;
  else if (entity.scope === "addon" && !/\baddon|plugin\b/i.test(rawQuery)) score -= 8;
  if (naturalQuestion) {
    if (entity.kind === "class") score += 24;
    if (entity.kind === "script") score += 8;
    if (entity.kind === "scene" || entity.kind === "resource") score -= 8;
  }
  const editorLike = /(?:^|\/)addons\//.test(entity.path ?? "") || /editor/i.test(entity.name);
  if (editorLike && !/\beditor|plugin|addon\b/i.test(rawQuery)) score -= 30;
  return score;
}

function suppressDuplicateScripts(ranked: RankedEntity[], naturalQuestion: boolean): RankedEntity[] {
  if (!naturalQuestion) return ranked;
  const classPaths = new Set(ranked.filter(({ entity }) => entity.kind === "class").map(({ entity }) => entity.path));
  return ranked.filter(({ entity }) => entity.kind !== "script" || !classPaths.has(entity.path));
}

function tokenize(value: string): string[] {
  const stopwords = new Set(["a", "an", "and", "are", "by", "for", "from", "how", "in", "is", "of", "on", "or", "the", "to", "what", "where", "which", "who", "why", "with", "handle", "handles", "find"]);
  return [...new Set(value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !stopwords.has(token))
    .map(normalizeToken))];
}

function normalizeToken(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) {
    const base = token.slice(0, -3);
    return base.endsWith("v") ? `${base}e` : base;
  }
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function entityMatches(entity: KnowledgeEntity, target: string): boolean {
  const expected = target.toLowerCase();
  return entity.name.toLowerCase() === expected || entity.facts.some((fact) =>
    ["className", "baseClass", "directory"].includes(fact.key)
      && String(fact.value).toLowerCase().endsWith(expected));
}

function relationIndex(relations: KnowledgeRelation[]): Map<string, KnowledgeRelation[]> {
  const output = new Map<string, KnowledgeRelation[]>();
  for (const relation of relations) {
    addToList(output, relation.from, relation);
    addToList(output, relation.to, relation);
  }
  return output;
}

function neighborScore(entity: KnowledgeEntity, tokens: string[]): number {
  const text = new Set(tokenize(`${entity.name} ${entity.path ?? ""}`));
  return tokens.reduce((score, token) => score + (text.has(token) ? 1 : 0), 0);
}

function uniqueRanked(values: RankedEntity[]): RankedEntity[] {
  const output = new Map<string, RankedEntity>();
  for (const value of values) if (!output.has(value.entity.id)) output.set(value.entity.id, value);
  return [...output.values()].sort(compareRanked);
}

function compareRanked(left: RankedEntity, right: RankedEntity): number {
  return right.score - left.score
    || scopePriority(left.entity.scope) - scopePriority(right.entity.scope)
    || left.entity.id.localeCompare(right.entity.id);
}

function scopePriority(scope: KnowledgeScope): number {
  return scope === "first-party" ? 0 : scope === "project" ? 1 : scope === "addon" ? 2 : 3;
}

function addToList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function factValueText(value: KnowledgeFactValue): string {
  return Array.isArray(value) ? value.join(" ") : String(value);
}

function parseJsonLines<T>(raw: string): T[] {
  return raw.trim() ? raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as T) : [];
}

function toJsonLines<T>(values: T[]): string {
  return values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(50, Math.max(1, Math.floor(value)));
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum} milliseconds`);
  }
  return Math.floor(resolved);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
