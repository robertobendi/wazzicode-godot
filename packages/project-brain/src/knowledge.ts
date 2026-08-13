import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const KNOWLEDGE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_KNOWLEDGE_SCAN_CAP = 25_000;

export type KnowledgeEntityKind =
  | "project"
  | "package"
  | "scene"
  | "prefab"
  | "script"
  | "type"
  | "module";

export type KnowledgeRelationKind = "contains" | "declares" | "derives" | "references";
export type KnowledgeScope = "project" | "first-party" | "package" | "external";
export type KnowledgeSourceKind =
  | "filesystem"
  | "project-settings"
  | "package-manifest"
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
  root: "Assets" | "Packages";
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
    isUnityProject: boolean;
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
      packageScripts: number;
      scenes: number;
      prefabs: number;
      entities: number;
      relations: number;
    };
    scopes: {
      firstParty: KnowledgeScopeCoverage;
      packages: KnowledgeScopeCoverage;
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

interface RankedKnowledgeEntity {
  entity: KnowledgeEntity;
  score: number;
}

interface QueryScoringContext {
  tokens: string[];
  rawQuery: string;
  naturalQuestion: boolean;
  packageIntent: boolean;
  editorIntent: boolean;
  runtimeIntent: boolean;
  testIntent: boolean;
  consumerIntent: boolean;
  kindIntents: Set<KnowledgeEntityKind>;
}

const projectOperationQueues = new Map<string, Promise<void>>();
export const KNOWLEDGE_LOCK_TIMEOUT_MS = 11 * 60_000;
export const KNOWLEDGE_LOCK_STALE_MS = 30_000;
const KNOWLEDGE_LOCK_POLL_MS = 40;

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

interface AcquiredKnowledgeLock {
  release: () => Promise<void>;
}

export function knowledgeDirectory(projectPath: string): string {
  return path.join(projectPath, ".unity-vibe", "knowledge");
}

export async function readKnowledgeBase(projectPath: string): Promise<KnowledgeBase | null> {
  const dir = knowledgeDirectory(projectPath);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await readKnowledgeBaseOnce(dir);
    if (result) return result;
  }
  return null;
}

export async function queryBrain(projectPath: string, opts: BrainQueryOptions): Promise<BrainQueryResult> {
  const brain = await readKnowledgeBase(projectPath);
  if (!brain) return { query: opts.query, generatedAt: 0, matches: [] };

  const allowedKinds = opts.kinds ? new Set(opts.kinds) : null;
  const entityById = new Map(brain.entities.map((entity) => [entity.id, entity]));
  const relationsByEntity = new Map<string, KnowledgeRelation[]>();
  for (const relation of brain.relations) {
    addToMapList(relationsByEntity, relation.from, relation);
    addToMapList(relationsByEntity, relation.to, relation);
  }

  const relationQuery = relationQueryMatches(brain, opts.query, allowedKinds, entityById);
  const limit = clampLimit(opts.limit, brainQueryDefaultLimit(opts.query));
  const scoring = queryScoringContext(opts.query, allowedKinds);
  const lexicalRanked = brain.entities
    .filter((entity) => !allowedKinds || allowedKinds.has(entity.kind))
    .map((entity) => ({
      entity,
      score: lexicalScore(entity, scoring)
        + graphOwnershipScore(entity, brain.relations, entityById, scoring),
    }))
    .filter((entry) => entry.score > 0)
    .sort(compareRankedEntities);
  const ranked = (relationQuery ?? suppressDuplicateScripts(lexicalRanked, scoring)).slice(0, limit);

  return {
    query: opts.query,
    generatedAt: brain.manifest.generatedAt,
    matches: ranked.map(({ entity, score }) => ({
      entity,
      score,
      neighbors: (relationsByEntity.get(entity.id) ?? [])
        .flatMap((relation) => {
          const otherId = relation.from === entity.id ? relation.to : relation.from;
          const neighbor = entityById.get(otherId);
          return neighbor
            ? [{ relation, entity: neighbor, relevance: neighborRelevance(neighbor, relation, scoring) }]
            : [];
        })
        .sort((left, right) => right.relevance - left.relevance
          || left.relation.id.localeCompare(right.relation.id))
        .slice(0, 20)
        .map(({ relation, entity: neighbor }) => ({ relation, entity: neighbor })),
    })),
  };
}

function suppressDuplicateScripts(
  ranked: RankedKnowledgeEntity[],
  context: QueryScoringContext,
): RankedKnowledgeEntity[] {
  if (!context.naturalQuestion || context.kindIntents.has("script")) return ranked;
  const typeKeys = new Set(ranked
    .filter(({ entity }) => entity.kind === "type" && entity.path)
    .map(({ entity }) => `${entity.path}\0${entity.name}`));
  return ranked.filter(({ entity }) => entity.kind !== "script"
    || !entity.path
    || !typeKeys.has(`${entity.path}\0${entity.name}`));
}

export function brainQueryDefaultLimit(query: string): number {
  return derivedTargetFromQuery(query)
    || moduleContentsTargetFromQuery(query)
    || dependencyTargetFromQuery(query)
    ? 20
    : 4;
}

export async function markBrainDirty(projectPath: string, change: string): Promise<KnowledgeManifest | null> {
  return withKnowledgeProjectLock(projectPath, () => markBrainDirtyUnlocked(projectPath, change));
}

export async function withKnowledgeProjectLock<T>(
  projectPath: string,
  operation: () => Promise<T>,
  opts: KnowledgeLockOptions = {},
): Promise<T> {
  const key = path.resolve(projectPath);
  const previous = projectOperationQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  projectOperationQueues.set(key, queued);
  await previous.catch(() => undefined);
  let filesystemLock: AcquiredKnowledgeLock | null = null;
  try {
    filesystemLock = await acquireKnowledgeFilesystemLock(key, opts);
    return await operation();
  } finally {
    try {
      await filesystemLock?.release();
    } finally {
      release();
      if (projectOperationQueues.get(key) === queued) projectOperationQueues.delete(key);
    }
  }
}

async function acquireKnowledgeFilesystemLock(
  projectPath: string,
  opts: KnowledgeLockOptions,
): Promise<AcquiredKnowledgeLock> {
  const timeoutMs = boundedDuration(opts.timeoutMs, KNOWLEDGE_LOCK_TIMEOUT_MS, 1, 15 * 60_000, "timeoutMs");
  const staleMs = boundedDuration(opts.staleMs, KNOWLEDGE_LOCK_STALE_MS, 100, 15 * 60_000, "staleMs");
  const pollMs = boundedDuration(opts.pollMs, KNOWLEDGE_LOCK_POLL_MS, 5, 1_000, "pollMs");
  const vibeDir = path.join(projectPath, ".unity-vibe");
  const lockPath = path.join(vibeDir, "knowledge.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(vibeDir, { recursive: true });

  for (;;) {
    const owner: KnowledgeLockOwner = {
      pid: process.pid,
      createdAt: Date.now(),
      token: `${process.pid}-${ownerToken()}`,
    };
    try {
      await fs.mkdir(lockPath);
      try {
        await fs.writeFile(ownerPath, JSON.stringify(owner) + "\n", { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await removeLockDirectory(lockPath);
        throw error;
      }
      const heartbeatMs = Math.max(50, Math.min(2_000, Math.floor(staleMs / 3)));
      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lockPath, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref();
      return {
        release: async () => {
          clearInterval(heartbeat);
          const currentOwner = await readLockOwner(ownerPath);
          if (currentOwner?.token === owner.token) await removeLockDirectory(lockPath);
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (await recoverStaleLock(lockPath, ownerPath, staleMs)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for project knowledge lock at ${lockPath}`);
      }
      await delay(Math.min(pollMs, remaining));
    }
  }
}

async function recoverStaleLock(lockPath: string, ownerPath: string, staleMs: number): Promise<boolean> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    return isMissingError(error);
  }
  const owner = await readLockOwner(ownerPath);
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner && Date.now() - stat.mtimeMs <= staleMs) return false;

  // Renaming first makes stale recovery atomic: a new contender can only own
  // the original lock path after this process has moved the stale generation.
  const stalePath = `${lockPath}.stale.${process.pid}.${ownerToken()}`;
  try {
    await fs.rename(lockPath, stalePath);
  } catch (error) {
    if (isMissingError(error) || isAlreadyExistsError(error)) return true;
    return false;
  }
  await removeLockDirectory(stalePath);
  return true;
}

async function readLockOwner(ownerPath: string): Promise<KnowledgeLockOwner | null> {
  try {
    const value = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Partial<KnowledgeLockOwner>;
    if (typeof value.pid !== "number" || typeof value.createdAt !== "number" || typeof value.token !== "string") {
      return null;
    }
    return { pid: value.pid, createdAt: value.createdAt, token: value.token };
  } catch {
    return null;
  }
}

async function removeLockDirectory(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { recursive: true, force: true });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function ownerToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function markBrainDirtyUnlocked(projectPath: string, change: string): Promise<KnowledgeManifest | null> {
  const dir = knowledgeDirectory(projectPath);
  const manifestPath = path.join(dir, "manifest.json");
  let manifest: KnowledgeManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as KnowledgeManifest;
  } catch {
    return null;
  }
  const normalized = change.trim() || "unspecified project change";
  manifest.dirty = {
    value: true,
    reasons: [...manifest.dirty.reasons, { at: Date.now(), change: normalized }].slice(-100),
  };
  await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function writeKnowledgeBase(projectPath: string, brain: KnowledgeBase, indexMarkdown: string): Promise<string[]> {
  const dir = knowledgeDirectory(projectPath);
  await fs.mkdir(dir, { recursive: true });
  const entitiesPath = path.join(dir, "entities.jsonl");
  const relationsPath = path.join(dir, "relations.jsonl");
  const indexPath = path.join(dir, "index.md");
  const manifestPath = path.join(dir, "manifest.json");

  await Promise.all([
    atomicWriteFile(entitiesPath, toJsonLines(brain.entities)),
    atomicWriteFile(relationsPath, toJsonLines(brain.relations)),
    atomicWriteFile(indexPath, indexMarkdown),
  ]);
  await atomicWriteFile(manifestPath, JSON.stringify(brain.manifest, null, 2) + "\n");
  return [manifestPath, entitiesPath, relationsPath, indexPath];
}

export function knowledgeContentFingerprint(entities: KnowledgeEntity[], relations: KnowledgeRelation[]): string {
  return sha256(`${toJsonLines(entities)}\u0000${toJsonLines(relations)}`);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function atomicWriteFile(file: string, contents: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomSuffix()}.tmp`);
  try {
    await fs.writeFile(temp, contents, "utf8");
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseJsonLines<T>(raw: string): T[] {
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

async function readKnowledgeBaseOnce(dir: string): Promise<KnowledgeBase | null> {
  const manifestPath = path.join(dir, "manifest.json");
  try {
    const manifestBefore = await fs.readFile(manifestPath, "utf8");
    const [entitiesRaw, relationsRaw] = await Promise.all([
      fs.readFile(path.join(dir, "entities.jsonl"), "utf8"),
      fs.readFile(path.join(dir, "relations.jsonl"), "utf8"),
    ]);
    const manifestAfter = await fs.readFile(manifestPath, "utf8");
    if (manifestBefore !== manifestAfter) return null;
    const manifest = JSON.parse(manifestAfter) as KnowledgeManifest;
    if (manifest.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) return null;
    const entities = parseJsonLines<KnowledgeEntity>(entitiesRaw);
    const relations = parseJsonLines<KnowledgeRelation>(relationsRaw);
    if (manifest.coverage.counts.entities !== entities.length) return null;
    if (manifest.coverage.counts.relations !== relations.length) return null;
    if (manifest.fingerprint.content !== knowledgeContentFingerprint(entities, relations)) return null;
    const entityIds = new Set(entities.map((entity) => entity.id));
    if (entityIds.size !== entities.length) return null;
    const relationIds = new Set(relations.map((relation) => relation.id));
    if (relationIds.size !== relations.length) return null;
    if (relations.some((relation) => !entityIds.has(relation.from) || !entityIds.has(relation.to))) return null;
    return { manifest, entities, relations };
  } catch {
    return null;
  }
}

function toJsonLines<T>(values: T[]): string {
  return values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

const GRAMMAR_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "i",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "what", "where", "which", "who",
  "why", "with",
]);

const QUERY_INTENT_STOPWORDS = new Set([
  "find", "handle", "handling", "locate", "responsibility", "responsible", "show", "tell", "use", "used",
]);

const BEHAVIOR_TOKENS = new Set([
  "build", "change", "construct", "consume", "coordinate", "drop", "handle", "load", "open",
  "persist", "read", "respond", "retry", "save", "schedule", "select", "spawn", "unlock", "update", "write",
]);

const OWNER_NAME_TOKENS = new Set([
  "controller", "director", "flow", "hub", "manager", "service", "system", "ui",
]);

function tokenizeQuery(value: string): string[] {
  const tokens = tokenizeText(value).filter((token) => !GRAMMAR_STOPWORDS.has(token));
  const semantic = tokens.filter((token) => !QUERY_INTENT_STOPWORDS.has(token));
  return semantic.length ? semantic : tokens;
}

function tokenizeText(value: string): string[] {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => normalizeQueryToken(token.toLowerCase()));
  return Array.from(new Set(words));
}

function normalizeQueryToken(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) {
    let base = token.slice(0, -3);
    if (base.length > 2 && base.at(-1) === base.at(-2)) base = base.slice(0, -1);
    if (base.endsWith("v")) base += "e";
    return base;
  }
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 6 && token.endsWith("tion")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) {
    let base = token.slice(0, -2);
    if (base.length > 2 && base.at(-1) === base.at(-2)) base = base.slice(0, -1);
    if (/(?:at|iz|ul)$/.test(base) || /[gsv]$/.test(base)) base += "e";
    return base;
  }
  if (token.length > 5 && token.endsWith("sses")) return token.slice(0, -2);
  if (
    token.length > 4 && token.endsWith("s") &&
    !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is")
  ) return token.slice(0, -1);
  return token;
}

function queryScoringContext(
  rawQuery: string,
  allowedKinds: Set<KnowledgeEntityKind> | null,
): QueryScoringContext {
  const tokens = tokenizeQuery(rawQuery);
  const kindIntents = new Set<KnowledgeEntityKind>();
  for (const token of tokens) {
    if (token === "class" || token === "struct" || token === "interface" || token === "enum") {
      kindIntents.add("type");
    } else if (isKnowledgeEntityKind(token)) {
      kindIntents.add(token);
    }
  }
  const packageIntent = kindIntents.has("package") || /(?:^|[^a-z0-9])com\.[a-z0-9]/i.test(rawQuery)
    || (allowedKinds?.has("package") ?? false);
  return {
    tokens,
    rawQuery,
    naturalQuestion: /\b(?:how|what|where|which|who|why)\b/i.test(rawQuery)
      || [...QUERY_INTENT_STOPWORDS].some((word) => new RegExp(`\\b${word}\\w*\\b`, "i").test(rawQuery)),
    packageIntent,
    editorIntent: /\b(?:editor|inspector|authoring)\b/i.test(rawQuery),
    runtimeIntent: /\b(?:runtime|gameplay|in-game|production)\b/i.test(rawQuery),
    testIntent: /\b(?:test|tests|testing|fixture|fixtures)\b/i.test(rawQuery),
    consumerIntent: /\b(?:consume|consumer|handle|process|read|use|uses|using|reference|references)\w*\b/i.test(rawQuery),
    kindIntents,
  };
}

function lexicalScore(entity: KnowledgeEntity, context: QueryScoringContext): number {
  if (context.tokens.length === 0) return 0;
  const nameTokens = new Set(tokenizeText(entity.name));
  const pathTokens = new Set(tokenizeText(entity.path ?? ""));
  const factTokens = new Set(tokenizeText(
    entity.facts.map((fact) => `${fact.key} ${factValueText(fact.value)}`).join(" "),
  ));
  const exact = context.rawQuery.trim().toLowerCase();
  let score = exact && entity.name.toLowerCase() === exact ? 120 : 0;
  for (const token of context.tokens) {
    if (nameTokens.has(token)) score += BEHAVIOR_TOKENS.has(token) ? 40 : 24;
    if (pathTokens.has(token)) score += 8;
    if (factTokens.has(token)) score += 3;
  }
  const matchedNameTokens = [...nameTokens].filter((token) => context.tokens.includes(token));
  if (nameTokens.size > 0 && matchedNameTokens.length === nameTokens.size) score += 18;
  const bestFactOverlap = entity.facts.reduce((best, fact) => {
    const tokens = new Set(tokenizeText(`${fact.key} ${factValueText(fact.value)}`));
    const overlap = context.tokens.reduce(
      (total, token) => total + (tokens.has(token) ? (BEHAVIOR_TOKENS.has(token) ? 2 : 1) : 0),
      0,
    );
    return Math.max(best, overlap);
  }, 0);
  score += bestFactOverlap * 5;
  if (context.kindIntents.has(entity.kind)) score += 16;
  if (score === 0) return 0;
  if (context.packageIntent) {
    if (entity.scope === "package") score += 24;
  } else if (entity.scope === "first-party") {
    score += 18;
  } else if (entity.scope === "external") {
    score -= 6;
  }
  if (context.naturalQuestion && context.kindIntents.size === 0) {
    if (entity.kind === "type") score += 24;
    else if (entity.kind === "script") score += 10;
    else if (entity.kind === "scene" || entity.kind === "prefab") score -= 16;
    if (
      entity.kind === "type" || entity.kind === "script"
    ) {
      if ([...nameTokens].some((token) => OWNER_NAME_TOKENS.has(token))) {
        score += 10;
        const subjectTokens = [...nameTokens].filter((token) => !OWNER_NAME_TOKENS.has(token));
        if (subjectTokens.length > 0 && subjectTokens.every((token) => context.tokens.includes(token))) {
          score += 25;
        }
      }
    }
  }
  const testLike = nameTokens.has("test") || pathTokens.has("test") || pathTokens.has("tests");
  const editorLike = nameTokens.has("editor") || pathTokens.has("editor");
  if (testLike && !context.testIntent) score -= context.runtimeIntent ? 200 : 70;
  if (editorLike && !context.editorIntent) score -= context.runtimeIntent ? 200 : 60;
  return score;
}

function graphOwnershipScore(
  entity: KnowledgeEntity,
  relations: KnowledgeRelation[],
  entityById: Map<string, KnowledgeEntity>,
  context: QueryScoringContext,
): number {
  if (!context.consumerIntent || entity.kind !== "type") return 0;
  let score = explicitlyNamedByQuery(entity, context) ? -60 : 0;
  for (const relation of relations) {
    if (relation.kind !== "references" || relation.from !== entity.id) continue;
    const target = entityById.get(relation.to);
    if (target && explicitlyNamedByQuery(target, context)) score += 60;
  }
  return Math.min(140, score);
}

function explicitlyNamedByQuery(entity: KnowledgeEntity, context: QueryScoringContext): boolean {
  const tokens = tokenizeText(entity.name)
    .filter((token) => token.length > 1 && !OWNER_NAME_TOKENS.has(token));
  return tokens.length >= 2 && tokens.every((token) => context.tokens.includes(token));
}

function neighborRelevance(
  entity: KnowledgeEntity,
  relation: KnowledgeRelation,
  context: QueryScoringContext,
): number {
  let score = Math.max(0, lexicalScore(entity, context));
  const relationTokens = new Set(tokenizeText([
    relation.kind,
    relation.provenance.path,
    relation.provenance.evidence ?? "",
  ].join(" ")));
  for (const token of context.tokens) if (relationTokens.has(token)) score += 4;
  return score;
}

function relationQueryMatches(
  brain: KnowledgeBase,
  rawQuery: string,
  allowedKinds: Set<KnowledgeEntityKind> | null,
  entityById: Map<string, KnowledgeEntity>,
): RankedKnowledgeEntity[] | null {
  const derivedTarget = derivedTargetFromQuery(rawQuery);
  if (derivedTarget) {
    const targetIds = new Set(brain.entities
      .filter((entity) => entity.kind === "type" && entityMatchesName(entity, derivedTarget))
      .map((entity) => entity.id));
    return uniqueRanked(brain.relations
      .filter((relation) => relation.kind === "derives" && targetIds.has(relation.to))
      .flatMap((relation) => {
        const entity = entityById.get(relation.from);
        return entity && (!allowedKinds || allowedKinds.has(entity.kind)) ? [{ entity, score: 200 }] : [];
      }));
  }

  const moduleName = moduleContentsTargetFromQuery(rawQuery);
  if (moduleName) {
    const moduleIds = new Set(brain.entities
      .filter((entity) => entity.kind === "module" && entityMatchesName(entity, moduleName))
      .sort((a, b) => scopePriority(a.scope) - scopePriority(b.scope) || a.id.localeCompare(b.id))
      .map((entity) => entity.id));
    if (moduleIds.size === 0) return null;
    const containsByOwner = new Map<string, KnowledgeRelation[]>();
    for (const relation of brain.relations) {
      if (relation.kind === "contains") addToMapList(containsByOwner, relation.from, relation);
    }
    const queue = [...moduleIds];
    const visited = new Set(queue);
    const scripts: RankedKnowledgeEntity[] = [];
    while (queue.length) {
      const owner = queue.shift()!;
      for (const relation of containsByOwner.get(owner) ?? []) {
        const entity = entityById.get(relation.to);
        if (!entity) continue;
        if (entity.kind === "module" && !visited.has(entity.id)) {
          visited.add(entity.id);
          queue.push(entity.id);
        } else if (entity.kind === "script" && (!allowedKinds || allowedKinds.has("script"))) {
          scripts.push({ entity, score: 200 });
        }
      }
    }
    return uniqueRanked(scripts);
  }

  const dependency = dependencyTargetFromQuery(rawQuery);
  if (!dependency) return null;
  const subjects = brain.entities
    .filter((entity) => entity.kind === "type" && entityMatchesName(entity, dependency.target))
    .sort((a, b) => scopePriority(a.scope) - scopePriority(b.scope) || a.id.localeCompare(b.id));
  if (subjects.length === 0) return null;
  const subjectIds = new Set(subjects.map((entity) => entity.id));
  return uniqueRanked(brain.relations.flatMap((relation) => {
    if (relation.kind !== "references" && relation.kind !== "derives") return [];
    const relatedId = dependency.incoming
      ? subjectIds.has(relation.to) ? relation.from : null
      : subjectIds.has(relation.from) ? relation.to : null;
    if (!relatedId) return [];
    const entity = entityById.get(relatedId);
    return entity && (!allowedKinds || allowedKinds.has(entity.kind)) ? [{ entity, score: 200 }] : [];
  }));
}

function derivedTargetFromQuery(query: string): string | null {
  const patterns = [
    /\b(?:types?|classes?)\s+(?:that\s+)?(?:derive|derived|inherit|inheriting|extend|extending)\s+(?:from\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/i,
    /\b(?:subclasses|implementations|derivatives)\s+of\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(query);
    if (match) return match[1];
  }
  return null;
}

function moduleContentsTargetFromQuery(query: string): string | null {
  const match = /\bscripts?\s+(?:contained\s+)?in\s+(?:the\s+)?(.+?)\s+modules?\b/i.exec(query);
  return match?.[1].trim() || null;
}

function dependencyTargetFromQuery(query: string): { target: string; incoming: boolean } | null {
  const match = /^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+(dependencies|dependents|references)\s*[?!.]*\s*$/i.exec(query);
  if (!match) return null;
  return { target: match[1], incoming: match[2].toLowerCase() === "dependents" };
}

function entityMatchesName(entity: KnowledgeEntity, expected: string): boolean {
  const normalized = expected.toLowerCase();
  if (entity.name.toLowerCase() === normalized) return true;
  return entity.facts.some((fact) =>
    fact.key === "qualifiedName" && String(fact.value).toLowerCase() === normalized);
}

function uniqueRanked(values: RankedKnowledgeEntity[]): RankedKnowledgeEntity[] {
  const unique = new Map<string, RankedKnowledgeEntity>();
  for (const value of values) if (!unique.has(value.entity.id)) unique.set(value.entity.id, value);
  return [...unique.values()].sort(compareRankedEntities);
}

function compareRankedEntities(a: RankedKnowledgeEntity, b: RankedKnowledgeEntity): number {
  return b.score - a.score
    || scopePriority(a.entity.scope) - scopePriority(b.entity.scope)
    || a.entity.id.localeCompare(b.entity.id);
}

function scopePriority(scope: KnowledgeScope): number {
  switch (scope) {
    case "first-party": return 0;
    case "project": return 1;
    case "package": return 2;
    case "external": return 3;
  }
}

function isKnowledgeEntityKind(value: string): value is KnowledgeEntityKind {
  return value === "project" || value === "package" || value === "scene" || value === "prefab"
    || value === "script" || value === "type" || value === "module";
}

function factValueText(value: KnowledgeFactValue): string {
  return Array.isArray(value) ? value.join(" ") : String(value);
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

function addToMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2);
}
