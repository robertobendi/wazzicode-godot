import type {
  BrainQueryMatch,
  BrainQueryResult,
  KnowledgeBase,
  KnowledgeEntity,
  KnowledgeFact,
  KnowledgeFactValue,
  KnowledgeManifest,
  KnowledgeProvenance,
  KnowledgeRelation,
} from "@uvibe/project-brain";

export const KNOWLEDGE_QUERY_MAX_BYTES = 16 * 1024;
export const KNOWLEDGE_RELATION_QUERY_MAX_BYTES = 32 * 1024;

const MAX_PRIMARY_FACTS = 3;
const MAX_NEIGHBOR_FACTS = 0;
const MAX_NEIGHBORS = 1;
const MAX_ARRAY_VALUES = 8;
const MAX_ID_CHARS = 240;
const MAX_NAME_CHARS = 160;
const MAX_PATH_CHARS = 320;
const MAX_KEY_CHARS = 120;
const MAX_VALUE_CHARS = 320;
const MAX_ARRAY_VALUE_CHARS = 120;
const MAX_EVIDENCE_CHARS = 240;
const MAX_MANIFEST_ERRORS = 5;
const MAX_DIRTY_REASONS = 5;

const BEHAVIOR_FACT_TOKENS = new Set([
  "build", "change", "construct", "consume", "coordinate", "drop", "handle", "load", "open",
  "persist", "read", "respond", "retry", "save", "schedule", "select", "spawn", "unlock", "update", "write",
]);

export interface ProjectionCount {
  total: number;
  returned: number;
  truncated: boolean;
}

export interface KnowledgeProjectionOptions {
  knowledge?: KnowledgeBase;
  queryLimit?: number;
  maxBytes?: number;
}

export function projectBrainQuery(
  result: BrainQueryResult,
  options: KnowledgeProjectionOptions = {}
) {
  const maxBytes = options.maxBytes ?? KNOWLEDGE_QUERY_MAX_BYTES;
  const relationCounts = countRelations(options.knowledge?.relations ?? []);
  const queryTokens = tokenize(result.query);
  const projected = result.matches.map((match) =>
    projectMatch(
      match,
      relationCounts.get(match.entity.id) ?? match.neighbors.length,
      queryTokens
    )
  );
  const matches: ReturnType<typeof projectMatch>[] = [];

  for (const match of projected) {
    const candidate = buildProjectedQuery(result, [...matches, match], maxBytes, options.queryLimit);
    if (serializedBytes(candidate) > maxBytes) break;
    matches.push(match);
  }

  return buildProjectedQuery(result, matches, maxBytes, options.queryLimit);
}

export function projectKnowledgeManifest(manifest: KnowledgeManifest) {
  const errors = manifest.coverage.errors.slice(0, MAX_MANIFEST_ERRORS).map((error) => ({
    path: clipPath(error.path),
    message: clipText(error.message, MAX_VALUE_CHARS),
  }));
  const reasons = manifest.dirty.reasons.slice(-MAX_DIRTY_REASONS).map((reason) => ({
    at: reason.at,
    change: clipText(reason.change, MAX_VALUE_CHARS),
  }));

  return {
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt,
    project: {
      id: clipMiddle(manifest.project.id, MAX_ID_CHARS),
      path: manifest.project.path,
      name: clipText(manifest.project.name, MAX_NAME_CHARS),
      isUnityProject: manifest.project.isUnityProject,
    },
    coverage: {
      cap: manifest.coverage.cap,
      discovered: manifest.coverage.discovered,
      scanned: manifest.coverage.scanned,
      complete: manifest.coverage.complete,
      truncated: manifest.coverage.truncated,
      counts: manifest.coverage.counts,
      scopes: manifest.coverage.scopes,
      errors,
      errorCount: count(manifest.coverage.errors.length, errors.length),
    },
    fingerprint: {
      algorithm: manifest.fingerprint.algorithm,
      source: clipText(manifest.fingerprint.source, MAX_VALUE_CHARS),
      content: clipText(manifest.fingerprint.content, MAX_VALUE_CHARS),
    },
    dirty: {
      value: manifest.dirty.value,
      reasons,
      reasonCount: count(manifest.dirty.reasons.length, reasons.length),
    },
  };
}

function buildProjectedQuery(
  result: BrainQueryResult,
  matches: ReturnType<typeof projectMatch>[],
  maxBytes: number,
  queryLimit: number | undefined
) {
  const projected = {
    query: clipText(result.query, MAX_VALUE_CHARS),
    generatedAt: result.generatedAt,
    matches,
    matchCount: count(result.matches.length, matches.length),
    queryLimit: {
      value: queryLimit ?? null,
      reached: queryLimit !== undefined && result.matches.length >= queryLimit,
    },
    output: {
      maxBytes,
      bytes: 0,
      truncated: matches.length < result.matches.length,
    },
  };
  projected.output.bytes = stableSerializedBytes(projected);
  return projected;
}

function projectMatch(
  match: BrainQueryMatch,
  totalNeighbors: number,
  queryTokens: string[]
) {
  const nameTokens = new Set(tokenize(match.entity.name));
  const factQueryTokens = queryTokens.filter((token) =>
    !nameTokens.has(token) || BEHAVIOR_FACT_TOKENS.has(token));
  const neighbors = match.neighbors.slice(0, MAX_NEIGHBORS).map((neighbor) => ({
    relation: projectRelation(neighbor.relation, match.entity.id),
    entity: projectEntity(neighbor.entity, MAX_NEIGHBOR_FACTS),
  }));
  return {
    score: match.score,
    entity: projectEntity(
      match.entity,
      MAX_PRIMARY_FACTS,
      factQueryTokens.length ? factQueryTokens : queryTokens
    ),
    neighbors,
    neighborCount: count(totalNeighbors, neighbors.length),
  };
}

function projectEntity(
  entity: KnowledgeEntity,
  factLimit: number,
  queryTokens: string[] = []
) {
  const facts = selectFacts(entity.facts, factLimit, queryTokens).map(projectFact);
  return {
    id: clipMiddle(entity.id, MAX_ID_CHARS),
    kind: entity.kind,
    name: clipText(entity.name, MAX_NAME_CHARS),
    ...(entity.path ? { path: clipPath(entity.path) } : {}),
    scope: entity.scope,
    facts,
    factCount: count(entity.facts.length, facts.length),
  };
}

function selectFacts(
  facts: KnowledgeFact[],
  limit: number,
  queryTokens: string[]
): KnowledgeFact[] {
  if (queryTokens.length === 0) return facts.slice(0, limit);
  return facts
    .map((fact, index) => ({ fact, index, relevance: factRelevance(fact, queryTokens) }))
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .slice(0, limit)
    .map(({ fact }) => fact);
}

function factRelevance(fact: KnowledgeFact, queryTokens: string[]): number {
  const text = `${fact.key} ${factValueText(fact.value)}`.toLowerCase();
  const factTokens = new Set(tokenize(text));
  const relevance = queryTokens.reduce(
    (score, token) => score + (factTokens.has(token)
      ? BEHAVIOR_FACT_TOKENS.has(token) ? 4 : 2
      : text.includes(token) ? 1 : 0),
    0
  );
  return relevance > 0 && fact.key === "memberSignature" && String(fact.value).includes("(")
    ? relevance + 5
    : relevance;
}

function projectFact(fact: KnowledgeFact) {
  const projectedValue = projectFactValue(fact.value);
  return {
    key: clipText(fact.key, MAX_KEY_CHARS),
    value: projectedValue.value,
    ...(projectedValue.valueCount ? { valueCount: projectedValue.valueCount } : {}),
    provenance: projectProvenance(fact.provenance),
    ...(fact.confidence === undefined ? {} : { confidence: fact.confidence }),
  };
}

function projectFactValue(value: KnowledgeFactValue): {
  value: KnowledgeFactValue;
  valueCount?: ProjectionCount;
} {
  if (Array.isArray(value)) {
    const values = value
      .slice(0, MAX_ARRAY_VALUES)
      .map((entry) => clipText(entry, MAX_ARRAY_VALUE_CHARS));
    return { value: values, valueCount: count(value.length, values.length) };
  }
  return {
    value: typeof value === "string" ? clipText(value, MAX_VALUE_CHARS) : value,
  };
}

function projectRelation(relation: KnowledgeRelation, matchedEntityId: string) {
  return {
    kind: relation.kind,
    direction: relation.from === matchedEntityId ? "outgoing" : "incoming",
    provenance: projectProvenance(relation.provenance),
    ...(relation.confidence === undefined ? {} : { confidence: relation.confidence }),
  };
}

function projectProvenance(provenance: KnowledgeProvenance) {
  const evidence = provenance.evidence
    ? clipText(provenance.evidence, MAX_EVIDENCE_CHARS)
    : undefined;
  return {
    source: provenance.source,
    path: clipPath(provenance.path),
    ...(provenance.line === undefined ? {} : { line: provenance.line }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(provenance.evidence && provenance.evidence !== evidence
      ? { evidenceTruncated: true }
      : {}),
    ...(provenance.heuristic === undefined ? {} : { heuristic: provenance.heuristic }),
  };
}

function count(total: number, returned: number): ProjectionCount {
  return { total, returned, truncated: returned < total };
}

function countRelations(relations: KnowledgeRelation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const relation of relations) {
    counts.set(relation.from, (counts.get(relation.from) ?? 0) + 1);
    counts.set(relation.to, (counts.get(relation.to) ?? 0) + 1);
  }
  return counts;
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((token) => normalizeQueryToken(token.toLowerCase()))
        .filter((token) => !PROJECTION_STOPWORDS.has(token))
    )
  );
}

const PROJECTION_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "what", "where", "which",
  "who", "why", "with", "find", "handle", "locate", "show", "tell", "use",
]);

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
  if (
    token.length > 4 && token.endsWith("s") &&
    !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is")
  ) return token.slice(0, -1);
  return token;
}

function factValueText(value: KnowledgeFactValue): string {
  return Array.isArray(value) ? value.join(" ") : String(value);
}

function clipText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function clipPath(value: string): string {
  return clipMiddle(value, MAX_PATH_CHARS);
}

function clipMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const left = Math.ceil((maxChars - 1) / 2);
  const right = Math.floor((maxChars - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function stableSerializedBytes(value: { output: { bytes: number } }): number {
  let bytes = serializedBytes(value);
  for (let attempt = 0; attempt < 3; attempt++) {
    value.output.bytes = bytes;
    const next = serializedBytes(value);
    if (next === bytes) return bytes;
    bytes = next;
  }
  return bytes;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
