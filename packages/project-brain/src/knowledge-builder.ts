import { promises as fs } from "node:fs";
import path from "node:path";
import type { Brain } from "./brain.js";
import type { ProjectScan } from "./scan.js";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  KnowledgeBase,
  KnowledgeEntity,
  KnowledgeFact,
  KnowledgeManifest,
  KnowledgeProvenance,
  KnowledgeRelation,
  KnowledgeRelationKind,
  KnowledgeScope,
  knowledgeContentFingerprint,
  sha256,
} from "./knowledge.js";

interface ParsedType {
  id: string;
  name: string;
  qualifiedName: string;
  declarationKind: string;
  namespace?: string;
  partial: boolean;
  parentId?: string;
  baseTypes: Array<{ name: string; line: number; evidence: string }>;
  path: string;
  scope: KnowledgeScope;
  line: number;
  evidence: string;
  body: string;
  bodyStartLine: number;
  members: ParsedMember[];
  memberSignatureCount: number;
  memberSignaturesTruncated: boolean;
}

interface TypeDeclarationDraft {
  declarationIndex: number;
  name: string;
  declarationKind: string;
  partial: boolean;
  baseClause: string;
  openBrace: number;
  closeBrace: number;
  parent?: TypeDeclarationDraft;
  namespace?: string;
  qualifiedName?: string;
  id?: string;
}

interface NamespaceSpan {
  name: string;
  declarationIndex: number;
  openBrace: number;
  closeBrace: number;
  fileScoped: boolean;
}

interface ParsedMember {
  signature: string;
  line: number;
  evidence: string;
}

const MAX_MEMBER_SIGNATURES_PER_TYPE = 256;

interface ParsedScript {
  path: string;
  scope: "first-party" | "package";
  text: string;
  masked: string;
  types: ParsedType[];
}

export interface KnowledgeBuildResult {
  knowledgeBase: KnowledgeBase;
  readErrors: Array<{ path: string; message: string }>;
}

export async function buildKnowledgeBase(
  projectPath: string,
  brain: Brain,
  scan: ProjectScan,
): Promise<KnowledgeBuildResult> {
  const observedAt = brain.generatedAt;
  const entities: KnowledgeEntity[] = [];
  const relations: KnowledgeRelation[] = [];
  const relationKeys = new Set<string>();
  const readErrors: Array<{ path: string; message: string }> = [];
  const projectId = "project:.";

  entities.push({
    id: projectId,
    kind: "project",
    name: brain.identity.productName ?? path.basename(projectPath),
    path: ".",
    scope: "project",
    facts: projectFacts(brain, observedAt),
  });

  const packageIds = addPackageEntities(entities, brain, scan, observedAt);
  const assetEntities = [
    ...scan.scenes.map((assetPath) => assetEntity("scene", assetPath, observedAt)),
    ...scan.prefabs.map((assetPath) => assetEntity("prefab", assetPath, observedAt)),
  ];
  entities.push(...assetEntities);

  const scripts = await readScripts(projectPath, scan, readErrors);
  for (const script of scripts) {
    entities.push(scriptEntity(script, observedAt));
  }

  const modulePaths = modulePathsForScripts(scripts);
  for (const modulePath of modulePaths) {
    entities.push(moduleEntity(modulePath, observedAt));
  }

  const parsedTypes = scripts.flatMap((script) => script.types);
  for (const parsed of parsedTypes) {
    entities.push(typeEntity(parsed, observedAt));
  }

  for (const entity of assetEntities) {
    addContainsRelation(relations, relationKeys, ownerForPath(entity.path ?? "", projectId, packageIds), entity.id, entity.path ?? ".", observedAt);
  }
  for (const [name, packageId] of packageIds) {
    addContainsRelation(relations, relationKeys, projectId, packageId, `Packages/manifest.json#${name}`, observedAt);
  }
  addModuleRelations(relations, relationKeys, modulePaths, packageIds, projectId, observedAt);
  for (const script of scripts) {
    const scriptId = scriptEntityId(script.path);
    const parentModule = path.posix.dirname(script.path);
    const owner = modulePaths.has(parentModule)
      ? moduleEntityId(parentModule)
      : ownerForPath(script.path, projectId, packageIds);
    addContainsRelation(relations, relationKeys, owner, scriptId, script.path, observedAt);
    for (const type of script.types) {
      addRelation(relations, relationKeys, {
        kind: "declares",
        from: scriptId,
        to: type.id,
        provenance: csharpProvenance(type.path, type.line, type.evidence, true),
        observedAt,
        confidence: 0.98,
      });
    }
  }

  addTypeRelations(entities, relations, relationKeys, parsedTypes, observedAt);

  entities.sort(compareEntities);
  relations.sort(compareRelations);
  const errors = [...scan.coverage.errors, ...readErrors].sort((a, b) => a.path.localeCompare(b.path));
  const content = knowledgeContentFingerprint(entities, relations);
  const manifest: KnowledgeManifest = {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: observedAt,
    project: {
      id: projectId,
      path: ".",
      name: brain.identity.productName ?? path.basename(projectPath),
      isUnityProject: brain.identity.isUnityProject,
    },
    coverage: {
      cap: scan.coverage.cap,
      discovered: scan.coverage.discovered,
      scanned: scan.coverage.scanned,
      complete: scan.coverage.complete && readErrors.length === 0,
      truncated: scan.coverage.truncated,
      errors,
      counts: {
        files: scan.coverage.scanned,
        firstPartyScripts: scan.firstPartyScripts.length,
        packageScripts: scan.packageScripts.length,
        scenes: scan.scenes.length,
        prefabs: scan.prefabs.length,
        entities: entities.length,
        relations: relations.length,
      },
      scopes: {
        firstParty: scan.coverage.scopes.firstParty,
        packages: scan.coverage.scopes.packages,
      },
    },
    fingerprint: {
      algorithm: "sha256",
      source: scan.coverage.sourceFingerprint,
      content,
    },
    dirty: { value: false, reasons: [] },
  };

  return { knowledgeBase: { manifest, entities, relations }, readErrors };
}

function projectFacts(brain: Brain, observedAt: number): KnowledgeFact[] {
  const settings = (key: string, value: KnowledgeFact["value"], heuristic = false, confidence?: number): KnowledgeFact => ({
    key,
    value,
    provenance: {
      source: "project-settings",
      path: key.startsWith("unity") ? "ProjectSettings/ProjectVersion.txt" : "ProjectSettings/ProjectSettings.asset",
      ...(heuristic ? { heuristic: true } : {}),
    },
    observedAt,
    ...(confidence === undefined ? {} : { confidence }),
  });
  const facts: KnowledgeFact[] = [
    fact("isUnityProject", brain.identity.isUnityProject, filesystemProvenance("."), observedAt),
  ];
  if (brain.identity.productName) facts.push(settings("productName", brain.identity.productName));
  if (brain.identity.companyName) facts.push(settings("companyName", brain.identity.companyName));
  if (brain.identity.bundleIdentifier) facts.push(settings("bundleIdentifier", brain.identity.bundleIdentifier, true, 0.8));
  if (brain.engine.unityVersion) facts.push(settings("unityVersion", brain.engine.unityVersion));
  if (brain.engine.unityRevision) facts.push(settings("unityRevision", brain.engine.unityRevision));
  if (brain.engine.renderPipeline) {
    facts.push(fact("renderPipeline", brain.engine.renderPipeline, {
      source: "package-manifest",
      path: "Packages/manifest.json",
      heuristic: true,
    }, observedAt, 0.9));
  }
  if (brain.engine.inputSystem) {
    facts.push(fact("inputSystem", brain.engine.inputSystem, {
      source: "package-manifest",
      path: "Packages/manifest.json",
      heuristic: true,
    }, observedAt, 0.9));
  }
  if (brain.engine.scriptingBackend) facts.push(settings("scriptingBackend", brain.engine.scriptingBackend, true, 0.8));
  if (brain.engine.defaultBuildTarget) facts.push(settings("defaultBuildTarget", brain.engine.defaultBuildTarget, true, 0.75));
  return facts;
}

function addPackageEntities(
  entities: KnowledgeEntity[],
  brain: Brain,
  scan: ProjectScan,
  observedAt: number,
): Map<string, string> {
  const versions = new Map((brain.engine.packages ?? []).map((pkg) => [pkg.name, pkg.version]));
  for (const scriptPath of scan.packageScripts) {
    const packageName = packageNameForPath(scriptPath);
    if (packageName && !versions.has(packageName)) versions.set(packageName, "(embedded or unresolved)");
  }
  const ids = new Map<string, string>();
  for (const [name, version] of [...versions].sort(([a], [b]) => a.localeCompare(b))) {
    const id = packageEntityId(name);
    ids.set(name, id);
    const facts = [fact("name", name, packageManifestProvenance(name), observedAt)];
    if (version !== "(embedded or unresolved)") {
      facts.push(fact("version", version, packageManifestProvenance(name), observedAt));
    } else {
      facts.push(fact("source", "embedded", filesystemProvenance(`Packages/${name}`), observedAt));
    }
    entities.push({ id, kind: "package", name, path: `Packages/${name}`, scope: "package", facts });
  }
  return ids;
}

function assetEntity(kind: "scene" | "prefab", assetPath: string, observedAt: number): KnowledgeEntity {
  return {
    id: `${kind}:${assetPath}`,
    kind,
    name: path.posix.basename(assetPath, path.posix.extname(assetPath)),
    path: assetPath,
    scope: scopeForPath(assetPath),
    facts: [
      fact("path", assetPath, filesystemProvenance(assetPath), observedAt),
      fact("assetType", kind, filesystemProvenance(assetPath), observedAt),
    ],
  };
}

function scriptEntity(script: ParsedScript, observedAt: number): KnowledgeEntity {
  return {
    id: scriptEntityId(script.path),
    kind: "script",
    name: path.posix.basename(script.path, ".cs"),
    path: script.path,
    scope: script.scope,
    facts: [
      fact("path", script.path, filesystemProvenance(script.path), observedAt),
      fact("language", "C#", filesystemProvenance(script.path), observedAt),
      fact("declaredTypeCount", script.types.length, csharpProvenance(script.path, 1, undefined, true), observedAt, 0.98),
    ],
  };
}

function moduleEntity(modulePath: string, observedAt: number): KnowledgeEntity {
  return {
    id: moduleEntityId(modulePath),
    kind: "module",
    name: path.posix.basename(modulePath),
    path: modulePath,
    scope: scopeForPath(modulePath),
    facts: [fact("directory", modulePath, { source: "derived", path: modulePath }, observedAt)],
  };
}

function typeEntity(parsed: ParsedType, observedAt: number): KnowledgeEntity {
  const provenance = csharpProvenance(parsed.path, parsed.line, parsed.evidence, true);
  const facts: KnowledgeFact[] = [
    fact("declarationKind", parsed.declarationKind, provenance, observedAt, 0.98),
    fact("qualifiedName", parsed.qualifiedName, provenance, observedAt, 0.95),
  ];
  if (parsed.partial) facts.push(fact("partial", true, provenance, observedAt, 0.98));
  if (parsed.namespace) facts.push(fact("namespace", parsed.namespace, provenance, observedAt, 0.95));
  if (parsed.baseTypes.length) {
    facts.push(fact("baseTypes", parsed.baseTypes.map((base) => base.name), provenance, observedAt, 0.9));
  }
  for (const member of parsed.members) {
    facts.push(fact(
      "memberSignature",
      member.signature,
      csharpProvenance(parsed.path, member.line, member.evidence, true),
      observedAt,
      0.85,
    ));
  }
  facts.push(fact("memberSignatureCount", parsed.memberSignatureCount, provenance, observedAt, 0.85));
  if (parsed.memberSignaturesTruncated) {
    facts.push(fact("memberSignaturesTruncated", true, provenance, observedAt, 0.85));
  }
  return {
    id: parsed.id,
    kind: "type",
    name: parsed.name,
    path: parsed.path,
    scope: parsed.scope,
    facts,
  };
}

async function readScripts(
  projectPath: string,
  scan: ProjectScan,
  errors: Array<{ path: string; message: string }>,
): Promise<ParsedScript[]> {
  const paths = [...scan.firstPartyScripts, ...scan.packageScripts].sort();
  const result: ParsedScript[] = [];
  const batchSize = 32;
  for (let start = 0; start < paths.length; start += batchSize) {
    const batch = paths.slice(start, start + batchSize);
    const values = await Promise.all(batch.map(async (scriptPath): Promise<ParsedScript | null> => {
      try {
        const text = await fs.readFile(path.join(projectPath, scriptPath), "utf8");
        const masked = maskCSharp(text);
        return {
          path: scriptPath,
          scope: scriptPath.startsWith("Assets/") ? "first-party" : "package",
          text,
          masked,
          types: parseTypes(scriptPath, text, masked),
        };
      } catch (error) {
        errors.push({ path: scriptPath, message: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }));
    for (const value of values) if (value) result.push(value);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function parseTypes(scriptPath: string, text: string, masked: string): ParsedType[] {
  const regex = /\b(class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)(?:\s*<[^>{;\n]+>)?(?:\s*:\s*([^\n{]+))?\s*{/g;
  const drafts: TypeDeclarationDraft[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masked)) !== null) {
    const declarationIndex = match.index;
    const openBrace = masked.indexOf("{", match.index + match[0].length - 1);
    const closeBrace = findMatchingBrace(masked, openBrace);
    drafts.push({
      declarationIndex,
      name: match[2],
      declarationKind: match[1].replace(/\s+.*/, ""),
      partial: declarationHasModifier(masked, declarationIndex, "partial"),
      baseClause: (match[3] ?? "").split(/\bwhere\b/)[0].trim(),
      openBrace,
      closeBrace: closeBrace < 0 ? masked.length : closeBrace,
    });
  }

  const namespaceSpans = parseNamespaceSpans(masked);
  for (const draft of drafts) {
    draft.parent = nearestContainingType(draft, drafts);
    draft.namespace = namespaceAt(draft.declarationIndex, namespaceSpans);
    const parentName = draft.parent ? qualifiedNameForDraft(draft.parent) : undefined;
    draft.qualifiedName = parentName
      ? `${parentName}.${draft.name}`
      : draft.namespace
        ? `${draft.namespace}.${draft.name}`
        : draft.name;
    draft.id = typeEntityId(scriptPath, draft.qualifiedName, draft.declarationIndex);
  }

  const parsed: ParsedType[] = [];
  for (const draft of drafts) {
    const qualifiedName = draft.qualifiedName ?? draft.name;
    const id = draft.id ?? typeEntityId(scriptPath, qualifiedName, draft.declarationIndex);
    const bodyStart = draft.openBrace < 0 ? draft.declarationIndex : draft.openBrace + 1;
    const bodyEnd = draft.closeBrace;
    const line = lineNumberAt(text, draft.declarationIndex);
    const baseTypes = splitBaseTypes(draft.baseClause).map((base) => ({
      name: base,
      line,
      evidence: lineEvidence(text, draft.declarationIndex),
    }));
    const body = maskNestedDeclarations(masked, bodyStart, bodyEnd, draft, drafts);
    const parsedMembers = parseMemberSignatures(body, text, bodyStart);
    const members = selectMemberSignatures(parsedMembers);
    parsed.push({
      id,
      name: draft.name,
      qualifiedName,
      declarationKind: draft.declarationKind,
      namespace: draft.namespace,
      partial: draft.partial,
      parentId: draft.parent?.id,
      baseTypes,
      path: scriptPath,
      scope: scopeForPath(scriptPath),
      line,
      evidence: lineEvidence(text, draft.declarationIndex),
      body,
      bodyStartLine: lineNumberAt(text, bodyStart),
      members,
      memberSignatureCount: parsedMembers.length,
      memberSignaturesTruncated: parsedMembers.length > MAX_MEMBER_SIGNATURES_PER_TYPE,
    });
  }
  return parsed;
}

function selectMemberSignatures(members: ParsedMember[]): ParsedMember[] {
  if (members.length <= MAX_MEMBER_SIGNATURES_PER_TYPE) return members;
  const callables = members.filter((member) => member.signature.includes("("));
  const remaining = members.filter((member) => !member.signature.includes("("));
  return [...callables, ...remaining]
    .slice(0, MAX_MEMBER_SIGNATURES_PER_TYPE)
    .sort((left, right) => left.line - right.line || left.signature.localeCompare(right.signature));
}

function parseNamespaceSpans(masked: string): NamespaceSpan[] {
  const regex = /\bnamespace\s+([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*([;{])/g;
  const spans: NamespaceSpan[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masked)) !== null) {
    const fileScoped = match[2] === ";";
    const openBrace = fileScoped ? regex.lastIndex - 1 : masked.indexOf("{", regex.lastIndex - 1);
    const matchingBrace = fileScoped ? masked.length : findMatchingBrace(masked, openBrace);
    spans.push({
      name: match[1].replace(/\s+/g, ""),
      declarationIndex: match.index,
      openBrace,
      closeBrace: matchingBrace < 0 ? masked.length : matchingBrace,
      fileScoped,
    });
  }
  return spans;
}

function namespaceAt(index: number, spans: NamespaceSpan[]): string | undefined {
  const fileScoped = spans
    .filter((span) => span.fileScoped && span.declarationIndex < index)
    .sort((a, b) => b.declarationIndex - a.declarationIndex)[0];
  const blocks = spans
    .filter((span) => !span.fileScoped && span.openBrace < index && index < span.closeBrace)
    .sort((a, b) => a.openBrace - b.openBrace);
  const parts = [...(fileScoped ? [fileScoped.name] : []), ...blocks.map((span) => span.name)];
  return parts.length ? parts.join(".") : undefined;
}

function nearestContainingType(target: TypeDeclarationDraft, drafts: TypeDeclarationDraft[]): TypeDeclarationDraft | undefined {
  return drafts
    .filter((candidate) => candidate !== target && candidate.openBrace < target.declarationIndex && target.declarationIndex < candidate.closeBrace)
    .sort((a, b) => b.openBrace - a.openBrace)[0];
}

function qualifiedNameForDraft(draft: TypeDeclarationDraft): string {
  if (draft.qualifiedName) return draft.qualifiedName;
  const parentName = draft.parent ? qualifiedNameForDraft(draft.parent) : undefined;
  draft.qualifiedName = parentName
    ? `${parentName}.${draft.name}`
    : draft.namespace
      ? `${draft.namespace}.${draft.name}`
      : draft.name;
  return draft.qualifiedName;
}

function declarationHasModifier(masked: string, declarationIndex: number, modifier: string): boolean {
  const prefixStart = Math.max(
    masked.lastIndexOf(";", declarationIndex - 1),
    masked.lastIndexOf("{", declarationIndex - 1),
    masked.lastIndexOf("}", declarationIndex - 1),
  ) + 1;
  return new RegExp(`\\b${modifier}\\b`).test(masked.slice(prefixStart, declarationIndex));
}

function maskNestedDeclarations(
  masked: string,
  bodyStart: number,
  bodyEnd: number,
  owner: TypeDeclarationDraft,
  drafts: TypeDeclarationDraft[],
): string {
  const body = masked.slice(bodyStart, bodyEnd).split("");
  for (const nested of drafts.filter((candidate) => candidate.parent === owner)) {
    const declarationLineStart = masked.lastIndexOf("\n", nested.declarationIndex - 1) + 1;
    const start = Math.max(0, declarationLineStart - bodyStart);
    const end = Math.min(body.length, nested.closeBrace + 1 - bodyStart);
    for (let index = start; index < end; index++) {
      if (body[index] !== "\n") body[index] = " ";
    }
  }
  return body.join("");
}

function addTypeRelations(
  entities: KnowledgeEntity[],
  relations: KnowledgeRelation[],
  relationKeys: Set<string>,
  types: ParsedType[],
  observedAt: number,
): void {
  const bySimpleName = new Map<string, ParsedType[]>();
  for (const type of types) {
    const values = bySimpleName.get(type.name);
    if (values) values.push(type);
    else bySimpleName.set(type.name, [type]);
  }
  const externalTypes = new Map<string, string>();

  for (const type of types) {
    if (type.parentId) {
      addRelation(relations, relationKeys, {
        kind: "contains",
        from: type.parentId,
        to: type.id,
        provenance: csharpProvenance(type.path, type.line, type.evidence, true),
        observedAt,
        confidence: 0.95,
      });
    }
    for (const base of type.baseTypes) {
      const local = resolveLocalType(base.name, bySimpleName);
      const targetId = local?.id ?? externalTypeId(base.name);
      if (!local && !externalTypes.has(base.name)) {
        externalTypes.set(base.name, targetId);
        const provenance = csharpProvenance(type.path, base.line, base.evidence, true);
        entities.push({
          id: targetId,
          kind: "type",
          name: base.name,
          scope: "external",
          facts: [fact("symbol", base.name, provenance, observedAt, 0.8)],
        });
      }
      addRelation(relations, relationKeys, {
        kind: "derives",
        from: type.id,
        to: targetId,
        provenance: csharpProvenance(type.path, base.line, base.evidence, true),
        observedAt,
        confidence: local ? 0.9 : 0.8,
      });
    }

    for (const [candidateName, position] of identifierPositions(type.body)) {
      const candidates = bySimpleName.get(candidateName);
      if (!candidates) continue;
      if (candidates.length !== 1 || candidates[0].id === type.id) continue;
      addRelation(relations, relationKeys, {
        kind: "references",
        from: type.id,
        to: candidates[0].id,
        provenance: csharpProvenance(
          type.path,
          position.line + type.bodyStartLine - 1,
          candidateName,
          true,
        ),
        observedAt,
        confidence: 0.75,
      });
    }
  }
}

function identifierPositions(text: string): Map<string, { index: number; line: number }> {
  const positions = new Map<string, { index: number; line: number }>();
  let line = 1;
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      line++;
      index++;
      continue;
    }
    if (!isIdentifierStart(code)) {
      index++;
      continue;
    }
    const start = index++;
    while (index < text.length && isIdentifierPart(text.charCodeAt(index))) index++;
    const identifier = text.slice(start, index);
    if (!positions.has(identifier)) positions.set(identifier, { index: start, line });
  }
  return positions;
}

function isIdentifierStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

function parseMemberSignatures(body: string, sourceText: string, sourceOffset: number): ParsedMember[] {
  const members: ParsedMember[] = [];
  let segmentStart = 0;
  for (let index = 0; index < body.length; index++) {
    const terminator = body[index];
    if (terminator !== ";" && terminator !== "{") continue;
    const rawHeader = body.slice(segmentStart, index);
    const leading = rawHeader.search(/\S/);
    const signature = memberSignature(rawHeader, terminator);
    if (signature) {
      const absoluteIndex = sourceOffset + segmentStart + Math.max(0, leading);
      members.push({
        signature,
        line: lineNumberAt(sourceText, absoluteIndex),
        evidence: lineEvidence(sourceText, absoluteIndex),
      });
    }
    if (terminator === "{") {
      const close = findMatchingBrace(body, index);
      if (close < 0) break;
      index = close;
    }
    segmentStart = index + 1;
  }
  return members;
}

function memberSignature(rawHeader: string, terminator: string): string | null {
  let header = rawHeader
    .replace(/^\s*#.*$/gm, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!header || /\b(?:class|struct|interface|enum|record|namespace)\b/.test(header)) return null;
  if (/^(?:return|throw|if|for|foreach|while|switch|catch|lock|using)\b/.test(header)) return null;
  const arrow = header.indexOf("=>");
  if (arrow >= 0) header = header.slice(0, arrow).trim();
  if (terminator === "{" && header.includes("=")) return null;
  if (terminator === ";" && !header.includes("(") && header.includes("=")) {
    header = header.slice(0, header.indexOf("=")).trim();
  }
  if (!/[A-Za-z_]\w*/.test(header)) return null;
  if (header.length > 240) header = `${header.slice(0, 237)}...`;
  return terminator === "{" && !header.includes("(") ? `${header} { … }` : header;
}

function addModuleRelations(
  relations: KnowledgeRelation[],
  relationKeys: Set<string>,
  modules: Set<string>,
  packageIds: Map<string, string>,
  projectId: string,
  observedAt: number,
): void {
  for (const modulePath of [...modules].sort()) {
    let parentPath = path.posix.dirname(modulePath);
    while (parentPath !== "." && !modules.has(parentPath)) parentPath = path.posix.dirname(parentPath);
    const parent = modules.has(parentPath)
      ? moduleEntityId(parentPath)
      : ownerForPath(modulePath, projectId, packageIds);
    addContainsRelation(relations, relationKeys, parent, moduleEntityId(modulePath), modulePath, observedAt);
  }
}

function modulePathsForScripts(scripts: ParsedScript[]): Set<string> {
  const modules = new Set<string>();
  for (const script of scripts) {
    const minimumParts = script.scope === "first-party" ? 1 : 2;
    let dir = path.posix.dirname(script.path);
    while (dir !== "." && dir.split("/").length > minimumParts) {
      modules.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return modules;
}

function addContainsRelation(
  relations: KnowledgeRelation[],
  keys: Set<string>,
  from: string,
  to: string,
  sourcePath: string,
  observedAt: number,
): void {
  addRelation(relations, keys, {
    kind: "contains",
    from,
    to,
    provenance: { source: "derived", path: sourcePath },
    observedAt,
  });
}

function addRelation(
  relations: KnowledgeRelation[],
  keys: Set<string>,
  relation: Omit<KnowledgeRelation, "id">,
): void {
  const key = `${relation.kind}\u0000${relation.from}\u0000${relation.to}`;
  if (keys.has(key)) return;
  keys.add(key);
  relations.push({
    id: `relation:${relation.kind}:${sha256(key).slice(0, 16)}`,
    ...relation,
  });
}

function fact(
  key: string,
  value: KnowledgeFact["value"],
  provenance: KnowledgeProvenance,
  observedAt: number,
  confidence?: number,
): KnowledgeFact {
  return { key, value, provenance, observedAt, ...(confidence === undefined ? {} : { confidence }) };
}

function filesystemProvenance(sourcePath: string): KnowledgeProvenance {
  return { source: "filesystem", path: sourcePath };
}

function packageManifestProvenance(packageName: string): KnowledgeProvenance {
  return { source: "package-manifest", path: "Packages/manifest.json", evidence: packageName };
}

function csharpProvenance(
  sourcePath: string,
  line: number,
  evidence: string | undefined,
  heuristic: boolean,
): KnowledgeProvenance {
  return {
    source: "csharp-text",
    path: sourcePath,
    line,
    ...(evidence ? { evidence } : {}),
    ...(heuristic ? { heuristic: true } : {}),
  };
}

function ownerForPath(sourcePath: string, projectId: string, packageIds: Map<string, string>): string {
  const packageName = packageNameForPath(sourcePath);
  return packageName ? packageIds.get(packageName) ?? projectId : projectId;
}

function packageNameForPath(sourcePath: string): string | null {
  const match = /^Packages\/([^/]+)/.exec(sourcePath);
  return match?.[1] ?? null;
}

function packageEntityId(name: string): string {
  return `package:${name}`;
}

function scriptEntityId(scriptPath: string): string {
  return `script:${scriptPath}`;
}

function typeEntityId(scriptPath: string, qualifiedName: string, declarationIndex: number): string {
  return `type:${scriptPath}#${qualifiedName}@${declarationIndex}`;
}

function externalTypeId(name: string): string {
  return `type:external:${name}`;
}

function moduleEntityId(modulePath: string): string {
  return `module:${modulePath}`;
}

function scopeForPath(sourcePath: string): KnowledgeScope {
  if (sourcePath === ".") return "project";
  if (sourcePath === "Assets" || sourcePath.startsWith("Assets/")) return "first-party";
  if (sourcePath === "Packages" || sourcePath.startsWith("Packages/")) return "package";
  return "external";
}

function splitBaseTypes(value: string): string[] {
  if (!value) return [];
  const values: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "<") depth++;
    else if (char === ">") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      const normalized = normalizeTypeName(current);
      if (normalized) values.push(normalized);
      current = "";
    } else {
      current += char;
    }
  }
  const normalized = normalizeTypeName(current);
  if (normalized) values.push(normalized);
  return Array.from(new Set(values));
}

function normalizeTypeName(value: string): string {
  const withoutGeneric = value.trim().replace(/^global::/, "").replace(/<.*$/, "").trim();
  const match = /([A-Za-z_]\w*)$/.exec(withoutGeneric);
  return match?.[1] ?? "";
}

function resolveLocalType(name: string, bySimpleName: Map<string, ParsedType[]>): ParsedType | null {
  const values = bySimpleName.get(name);
  return values?.length === 1 ? values[0] : null;
}

function findMatchingBrace(text: string, openIndex: number): number {
  if (openIndex < 0) return -1;
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function lineEvidence(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const endIndex = text.indexOf("\n", index);
  const end = endIndex < 0 ? text.length : endIndex;
  return text.slice(start, end).trim().slice(0, 240);
}

function maskCSharp(text: string): string {
  const chars = text.split("");
  let state: "code" | "line" | "block" | "string" | "char" | "verbatim" = "code";
  for (let i = 0; i < chars.length; i++) {
    const current = chars[i];
    const next = chars[i + 1];
    if (state === "code") {
      if (current === "/" && next === "/") {
        chars[i] = chars[i + 1] = " ";
        state = "line";
        i++;
      } else if (current === "/" && next === "*") {
        chars[i] = chars[i + 1] = " ";
        state = "block";
        i++;
      } else if (current === "@" && next === '"') {
        chars[i] = chars[i + 1] = " ";
        state = "verbatim";
        i++;
      } else if (current === '"') {
        chars[i] = " ";
        state = "string";
      } else if (current === "'") {
        chars[i] = " ";
        state = "char";
      }
      continue;
    }
    if (current === "\n" && state === "line") {
      state = "code";
      continue;
    }
    if (current === "\n") continue;
    chars[i] = " ";
    if (state === "block" && current === "*" && next === "/") {
      chars[i + 1] = " ";
      state = "code";
      i++;
    } else if ((state === "string" || state === "char") && current === "\\") {
      if (i + 1 < chars.length) chars[++i] = " ";
    } else if (state === "string" && current === '"') {
      state = "code";
    } else if (state === "char" && current === "'") {
      state = "code";
    } else if (state === "verbatim" && current === '"') {
      if (next === '"') {
        chars[i + 1] = " ";
        i++;
      } else {
        state = "code";
      }
    }
  }
  return chars.join("");
}

function compareEntities(a: KnowledgeEntity, b: KnowledgeEntity): number {
  return a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}

function compareRelations(a: KnowledgeRelation, b: KnowledgeRelation): number {
  return a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
}
