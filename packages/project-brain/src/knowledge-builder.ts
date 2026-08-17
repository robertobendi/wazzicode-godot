import { promises as fs } from "node:fs";
import path from "node:path";
import type { Brain } from "./brain.js";
import type { CSharpAnalysis, GDScriptAnalysis } from "./heuristics.js";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeBase,
  type KnowledgeEntity,
  type KnowledgeEntityKind,
  type KnowledgeFact,
  type KnowledgeManifest,
  type KnowledgeProvenance,
  type KnowledgeRelation,
  type KnowledgeRelationKind,
  type KnowledgeScope,
  knowledgeContentFingerprint,
  sha256,
} from "./knowledge.js";
import { type ProjectFile, type ProjectScan, resourcePathToAbsolute } from "./scan.js";

export interface GodotResourceDependency {
  id: string;
  path: string;
  type?: string;
  instantiated: boolean;
  line: number;
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
  const projectId = "project:.";
  const entities: KnowledgeEntity[] = [];
  const relations: KnowledgeRelation[] = [];
  const entityIds = new Set<string>();
  const relationKeys = new Set<string>();
  const readErrors: Array<{ path: string; message: string }> = [];

  addEntity(entities, entityIds, {
    id: projectId,
    kind: "project",
    name: brain.identity.projectName ?? path.basename(projectPath),
    path: ".",
    scope: "project",
    facts: projectFacts(brain, observedAt),
  });

  const addonIds = new Map<string, string>();
  for (const addon of scan.addons) {
    const id = `addon:${addon}`;
    addonIds.set(addon, id);
    addEntity(entities, entityIds, {
      id,
      kind: "addon",
      name: addon,
      path: `res://addons/${addon}`,
      scope: "addon",
      facts: [fact("path", `res://addons/${addon}`, filesystem(`res://addons/${addon}`), observedAt)],
    });
    addRelation(relations, relationKeys, "contains", projectId, id, filesystem(`res://addons/${addon}`), observedAt);
  }

  const gdScriptsByPath = new Map(brain.architecture.gdScripts.map((script) => [script.path, script]));
  const assetIds = new Map<string, string>();
  for (const file of scan.files) {
    const kind = entityKindForFile(file);
    const id = assetId(kind, file.path);
    assetIds.set(file.path, id);
    const entity = assetEntity(file, id, kind, observedAt);
    const script = gdScriptsByPath.get(file.path);
    // Scripts without `class_name` declare no class, so their surface belongs
    // on the script entity rather than an invented class one.
    if (script && !script.className) entity.facts.push(...gdScriptSurfaceFacts(script, observedAt));
    addEntity(entities, entityIds, entity);
  }

  const moduleIds = addModules(entities, entityIds, relations, relationKeys, scan, addonIds, projectId, observedAt);
  for (const file of scan.files) {
    const entityId = assetIds.get(file.path)!;
    const directory = resourceDirectory(file.path);
    const owner = moduleIds.get(directory) ?? addonOwner(file.path, addonIds) ?? projectId;
    addRelation(relations, relationKeys, "contains", owner, entityId, filesystem(file.path), observedAt);
  }

  const classByName = new Map<string, string[]>();
  const classByScript = new Map<string, string[]>();
  for (const script of brain.architecture.gdScripts) {
    if (!script.className) continue;
    const entity = gdClassEntity(script, script.className, observedAt);
    addEntity(entities, entityIds, entity);
    addMapList(classByName, entity.name, entity.id);
    addMapList(classByScript, script.path, entity.id);
    const scriptId = assetIds.get(script.path);
    if (scriptId) addRelation(relations, relationKeys, "declares", scriptId, entity.id, gdscript(script.path, 1), observedAt);
  }
  for (const script of brain.architecture.csharpScripts) {
    for (const declaration of script.classes) {
      const entity = csharpClassEntity(script, declaration, observedAt);
      addEntity(entities, entityIds, entity);
      addMapList(classByName, entity.name, entity.id);
      addMapList(classByScript, script.path, entity.id);
      const scriptId = assetIds.get(script.path);
      if (scriptId) {
        addRelation(relations, relationKeys, "declares", scriptId, entity.id, csharp(script.path, declaration.line), observedAt);
      }
    }
  }

  for (const script of brain.architecture.gdScripts) {
    const sourceId = classByScript.get(script.path)?.[0] ?? assetIds.get(script.path);
    if (!sourceId) continue;
    if (script.extends) {
      const targetId = script.extendsPath
        ? classByScript.get(script.extendsPath)?.[0]
          ?? assetIds.get(script.extendsPath)
          ?? ensureExternalEntity(
            entities,
            entityIds,
            kindFromResourcePath(script.extendsPath),
            nameFromPath(script.extendsPath),
            script.extendsPath,
            observedAt,
          )
        : classByName.get(script.extends)?.[0]
          ?? ensureExternalEntity(entities, entityIds, "class", script.extends, undefined, observedAt);
      addRelation(relations, relationKeys, "extends", sourceId, targetId, gdscript(script.path, script.extendsLine ?? 1), observedAt, 0.98);
    }
    for (const dependency of script.dependencies) {
      if (dependency.loader === "extends") continue;
      const targetId = assetIds.get(dependency.path)
        ?? ensureExternalEntity(
          entities,
          entityIds,
          kindFromResourcePath(dependency.path),
          nameFromPath(dependency.path),
          dependency.path,
          observedAt,
        );
      addRelation(
        relations,
        relationKeys,
        "references",
        sourceId,
        targetId,
        gdscript(script.path, dependency.line, `${dependency.loader}(\"${dependency.path}\")`),
        observedAt,
        0.98,
      );
    }
  }

  for (const script of brain.architecture.csharpScripts) {
    for (const declaration of script.classes) {
      if (!declaration.base) continue;
      const sourceId = classByName.get(declaration.name)?.find((id) => id.includes(encodedPath(script.path)));
      if (!sourceId) continue;
      const targetId = classByName.get(declaration.base)?.[0]
        ?? ensureExternalEntity(entities, entityIds, "class", declaration.base, undefined, observedAt);
      addRelation(relations, relationKeys, "extends", sourceId, targetId, csharp(script.path, declaration.line), observedAt, 0.9);
    }
  }

  for (const file of scan.files.filter((entry) => entry.kind === "scene" || entry.kind === "resource")) {
    if (![".tscn", ".tres"].includes(path.posix.extname(file.path))) continue;
    let text: string;
    try {
      text = await fs.readFile(resourcePathToAbsolute(projectPath, file.path), "utf8");
    } catch (error) {
      readErrors.push({ path: file.path, message: errorMessage(error) });
      continue;
    }
    const sourceId = assetIds.get(file.path)!;
    for (const dependency of parseGodotResourceDependencies(text)) {
      const targetId = assetIds.get(dependency.path)
        ?? ensureExternalEntity(
          entities,
          entityIds,
          kindFromResourcePath(dependency.path),
          nameFromPath(dependency.path),
          dependency.path,
          observedAt,
        );
      const relationKind: KnowledgeRelationKind = dependency.instantiated && dependency.type === "PackedScene"
        ? "instantiates"
        : "references";
      addRelation(
        relations,
        relationKeys,
        relationKind,
        sourceId,
        targetId,
        resourceProvenance(file.path, dependency.line, dependency.path),
        observedAt,
        0.99,
      );
    }
  }

  for (const autoload of brain.engine.autoloads) {
    const targetId = assetIds.get(autoload.path)
      ?? ensureExternalEntity(entities, entityIds, kindFromResourcePath(autoload.path), autoload.name, autoload.path, observedAt);
    addRelation(
      relations,
      relationKeys,
      "references",
      projectId,
      targetId,
      settingsProvenance("project.godot", `[autoload] ${autoload.name}`),
      observedAt,
      1,
    );
  }

  entities.sort(compareEntities);
  relations.sort(compareRelations);
  const errors = [...scan.coverage.errors, ...readErrors].sort((a, b) => a.path.localeCompare(b.path));
  const manifest: KnowledgeManifest = {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: observedAt,
    project: {
      id: projectId,
      path: ".",
      name: brain.identity.projectName ?? path.basename(projectPath),
      isGodotProject: brain.identity.isGodotProject,
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
        addonScripts: scan.addonScripts.length,
        scenes: scan.scenes.length,
        resources: scan.resources.length,
        shaders: scan.shaders.length,
        entities: entities.length,
        relations: relations.length,
      },
      scopes: {
        firstParty: scan.coverage.scopes.firstParty,
        addons: scan.coverage.scopes.addons,
      },
    },
    fingerprint: {
      algorithm: "sha256",
      source: scan.coverage.sourceFingerprint,
      content: knowledgeContentFingerprint(entities, relations),
    },
    dirty: { value: false, reasons: [] },
  };
  return { knowledgeBase: { manifest, entities, relations }, readErrors };
}

export function parseGodotResourceDependencies(text: string): GodotResourceDependency[] {
  const instantiatedIds = new Set<string>();
  const instancePattern = /\binstance\s*=\s*ExtResource\(\s*"([^"]+)"\s*\)/g;
  let instance: RegExpExecArray | null;
  while ((instance = instancePattern.exec(text)) !== null) instantiatedIds.add(instance[1]);

  const output: GodotResourceDependency[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const header = /^\[ext_resource\s+(.+)\]$/.exec(lines[index].trim());
    if (!header) continue;
    const attributes = new Map<string, string>();
    const attributePattern = /([A-Za-z_]\w*)="((?:\\.|[^"\\])*)"/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributePattern.exec(header[1])) !== null) {
      attributes.set(attribute[1], attribute[2].replace(/\\"/g, '"'));
    }
    const dependencyPath = attributes.get("path");
    const id = attributes.get("id");
    if (!dependencyPath || !id || !dependencyPath.startsWith("res://")) continue;
    output.push({
      id,
      path: dependencyPath,
      type: attributes.get("type"),
      instantiated: instantiatedIds.has(id),
      line: index + 1,
    });
  }
  return output.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
}

function projectFacts(brain: Brain, observedAt: number): KnowledgeFact[] {
  const facts: KnowledgeFact[] = [
    fact("isGodotProject", brain.identity.isGodotProject, settingsProvenance("project.godot"), observedAt),
  ];
  addDefinedFact(facts, "projectName", brain.identity.projectName, settingsProvenance("project.godot", "application/config/name"), observedAt);
  addDefinedFact(facts, "mainScene", brain.engine.mainScene, settingsProvenance("project.godot", "application/run/main_scene"), observedAt);
  addDefinedFact(facts, "configVersion", brain.engine.configVersion, settingsProvenance("project.godot", "config_version"), observedAt);
  addDefinedFact(facts, "renderer", brain.engine.renderer, settingsProvenance("project.godot", "rendering/renderer/rendering_method"), observedAt);
  if (brain.engine.features.length) facts.push(fact("features", brain.engine.features, settingsProvenance("project.godot", "application/config/features"), observedAt));
  if (brain.engine.inputActions.length) facts.push(fact("inputActions", brain.engine.inputActions, settingsProvenance("project.godot", "input"), observedAt));
  if (brain.engine.autoloads.length) facts.push(fact("autoloads", brain.engine.autoloads.map((entry) => entry.name), settingsProvenance("project.godot", "autoload"), observedAt));
  facts.push(fact("usesDotnet", brain.engine.usesDotnet, settingsProvenance("project.godot"), observedAt));
  return facts;
}

function assetEntity(
  file: ProjectFile,
  id: string,
  kind: KnowledgeEntityKind,
  observedAt: number,
): KnowledgeEntity {
  const facts: KnowledgeFact[] = [
    fact("path", file.path, filesystem(file.path), observedAt),
    fact("assetType", kind, filesystem(file.path), observedAt),
  ];
  if (file.language) facts.push(fact("language", file.language, filesystem(file.path), observedAt));
  return {
    id,
    kind,
    name: nameFromPath(file.path),
    path: file.path,
    scope: file.scope,
    facts,
  };
}

function gdScriptSurfaceFacts(script: GDScriptAnalysis, observedAt: number): KnowledgeFact[] {
  const facts: KnowledgeFact[] = [
    fact("tool", script.tool, gdscript(script.path, 1), observedAt, 0.98),
  ];
  addDefinedFact(facts, "baseClass", script.extends, gdscript(script.path, script.extendsLine ?? 1), observedAt, 0.98);
  for (const fn of script.functions) facts.push(fact("function", fn.signature, gdscript(script.path, fn.line, fn.signature), observedAt, 0.98));
  for (const signal of script.signals) facts.push(fact("signal", signal.signature, gdscript(script.path, signal.line, signal.signature), observedAt, 0.98));
  for (const exported of script.exports) {
    facts.push(fact("export", `${exported.name}${exported.type ? `: ${exported.type}` : ""}`, gdscript(script.path, exported.line, exported.annotation), observedAt, 0.95));
  }
  return facts;
}

function gdClassEntity(script: GDScriptAnalysis, name: string, observedAt: number): KnowledgeEntity {
  const classProvenance = gdscript(script.path, script.classNameLine ?? 1);
  const facts: KnowledgeFact[] = [
    fact("language", "GDScript", filesystem(script.path), observedAt),
    fact("className", name, classProvenance, observedAt, 1),
    fact("globalClass", true, classProvenance, observedAt, 0.98),
    ...gdScriptSurfaceFacts(script, observedAt),
  ];
  return {
    id: `class:${encodedPath(script.path)}:${encodeURIComponent(name)}`,
    kind: "class",
    name,
    path: script.path,
    scope: scopeForPath(script.path),
    facts,
  };
}

function csharpClassEntity(
  script: CSharpAnalysis,
  declaration: CSharpAnalysis["classes"][number],
  observedAt: number,
): KnowledgeEntity {
  const provenance = csharp(script.path, declaration.line);
  const facts = [
    fact("language", "C#", filesystem(script.path), observedAt),
    fact("className", declaration.name, provenance, observedAt, 0.9),
  ];
  addDefinedFact(facts, "baseClass", declaration.base, provenance, observedAt, 0.85);
  return {
    id: `class:${encodedPath(script.path)}:${encodeURIComponent(declaration.name)}`,
    kind: "class",
    name: declaration.name,
    path: script.path,
    scope: scopeForPath(script.path),
    facts,
  };
}

function addModules(
  entities: KnowledgeEntity[],
  entityIds: Set<string>,
  relations: KnowledgeRelation[],
  relationKeys: Set<string>,
  scan: ProjectScan,
  addonIds: Map<string, string>,
  projectId: string,
  observedAt: number,
): Map<string, string> {
  const directories = new Set<string>();
  for (const file of scan.files) {
    let directory = resourceDirectory(file.path);
    while (directory !== "res://") {
      directories.add(directory);
      if (/^res:\/\/addons\/[^/]+$/.test(directory)) break;
      directory = resourceDirectory(directory);
    }
  }
  const moduleIds = new Map<string, string>();
  for (const directory of [...directories].sort()) {
    // `res://addons/<name>` already has an addon entity; a module twin would
    // only add an identically named nesting level above the addon's files.
    const addonId = directAddonOwner(directory, addonIds);
    if (addonId) {
      moduleIds.set(directory, addonId);
      continue;
    }
    const id = `module:${directory}`;
    moduleIds.set(directory, id);
    addEntity(entities, entityIds, {
      id,
      kind: "module",
      name: path.posix.basename(directory),
      path: directory,
      scope: scopeForPath(directory),
      facts: [fact("directory", directory, derived(directory), observedAt)],
    });
  }
  for (const [directory, id] of moduleIds) {
    if (directAddonOwner(directory, addonIds)) continue;
    const owner = moduleIds.get(resourceDirectory(directory)) ?? projectId;
    addRelation(relations, relationKeys, "contains", owner, id, derived(directory), observedAt);
  }
  return moduleIds;
}

function ensureExternalEntity(
  entities: KnowledgeEntity[],
  entityIds: Set<string>,
  kind: KnowledgeEntityKind,
  name: string,
  resourcePath: string | undefined,
  observedAt: number,
): string {
  const id = `external:${kind}:${resourcePath ? encodedPath(resourcePath) : encodeURIComponent(name)}`;
  if (!entityIds.has(id)) {
    addEntity(entities, entityIds, {
      id,
      kind,
      name,
      ...(resourcePath ? { path: resourcePath } : {}),
      scope: "external",
      facts: [fact(resourcePath ? "path" : "className", resourcePath ?? name, derived(resourcePath ?? name), observedAt)],
    });
  }
  return id;
}

function addEntity(entities: KnowledgeEntity[], ids: Set<string>, entity: KnowledgeEntity): void {
  if (ids.has(entity.id)) return;
  ids.add(entity.id);
  entities.push(entity);
}

function addRelation(
  relations: KnowledgeRelation[],
  keys: Set<string>,
  kind: KnowledgeRelationKind,
  from: string,
  to: string,
  provenance: KnowledgeProvenance,
  observedAt: number,
  confidence?: number,
): void {
  if (from === to) return;
  const key = `${kind}\0${from}\0${to}`;
  if (keys.has(key)) return;
  keys.add(key);
  relations.push({
    id: `${kind}:${sha256(`${from}\0${to}`).slice(0, 20)}`,
    kind,
    from,
    to,
    provenance,
    observedAt,
    ...(confidence === undefined ? {} : { confidence }),
  });
}

function fact(
  key: string,
  value: KnowledgeFact["value"],
  provenance: KnowledgeProvenance,
  observedAt: number,
  confidence?: number,
): KnowledgeFact {
  return {
    key,
    value,
    provenance,
    observedAt,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function addDefinedFact(
  facts: KnowledgeFact[],
  key: string,
  value: KnowledgeFact["value"] | undefined,
  provenance: KnowledgeProvenance,
  observedAt: number,
  confidence?: number,
): void {
  if (value !== undefined) facts.push(fact(key, value, provenance, observedAt, confidence));
}

function filesystem(resourcePath: string): KnowledgeProvenance {
  return { source: "filesystem", path: resourcePath };
}

function derived(resourcePath: string): KnowledgeProvenance {
  return { source: "derived", path: resourcePath };
}

function settingsProvenance(settingsPath: string, evidence?: string): KnowledgeProvenance {
  return { source: "project-settings", path: settingsPath, ...(evidence ? { evidence } : {}) };
}

function gdscript(resourcePath: string, line: number, evidence?: string): KnowledgeProvenance {
  return { source: "gdscript-text", path: resourcePath, line, ...(evidence ? { evidence } : {}), heuristic: true };
}

function csharp(resourcePath: string, line: number): KnowledgeProvenance {
  return { source: "csharp-text", path: resourcePath, line, heuristic: true };
}

function resourceProvenance(resourcePath: string, line: number, evidence: string): KnowledgeProvenance {
  return { source: "godot-resource", path: resourcePath, line, evidence, heuristic: true };
}

function entityKindForFile(file: ProjectFile): KnowledgeEntityKind {
  return file.kind;
}

function kindFromResourcePath(resourcePath: string): KnowledgeEntityKind {
  switch (path.posix.extname(resourcePath).toLowerCase()) {
    case ".gd":
    case ".cs": return "script";
    case ".tscn":
    case ".scn": return "scene";
    case ".gdshader": return "shader";
    default: return "resource";
  }
}

function assetId(kind: KnowledgeEntityKind, resourcePath: string): string {
  return `${kind}:${encodedPath(resourcePath)}`;
}

function encodedPath(resourcePath: string): string {
  return encodeURIComponent(resourcePath);
}

function resourceDirectory(resourcePath: string): string {
  if (resourcePath === "res://") return resourcePath;
  const relative = resourcePath.slice("res://".length).replace(/\/$/, "");
  const directory = path.posix.dirname(relative);
  return directory === "." ? "res://" : `res://${directory}`;
}

function addonOwner(resourcePath: string, addonIds: Map<string, string>): string | undefined {
  const match = /^res:\/\/addons\/([^/]+)/.exec(resourcePath);
  return match ? addonIds.get(match[1]) : undefined;
}

function directAddonOwner(resourcePath: string, addonIds: Map<string, string>): string | undefined {
  const match = /^res:\/\/addons\/([^/]+)$/.exec(resourcePath);
  return match ? addonIds.get(match[1]) : undefined;
}

function scopeForPath(resourcePath: string): KnowledgeScope {
  return resourcePath.startsWith("res://addons/") ? "addon" : "first-party";
}

function nameFromPath(resourcePath: string): string {
  return path.posix.basename(resourcePath, path.posix.extname(resourcePath));
}

function compareEntities(left: KnowledgeEntity, right: KnowledgeEntity): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function compareRelations(left: KnowledgeRelation, right: KnowledgeRelation): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function addMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
