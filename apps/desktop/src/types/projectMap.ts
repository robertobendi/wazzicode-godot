export type KnowledgeEntityKind =
  | "project"
  | "addon"
  | "scene"
  | "resource"
  | "script"
  | "class"
  | "module"
  | "shader";

export type KnowledgeScope = "project" | "first-party" | "addon" | "external";

export type KnowledgeRelationKind =
  | "contains"
  | "declares"
  | "extends"
  | "references"
  | "instantiates";

export type KnowledgeProvenanceSource =
  | "filesystem"
  | "project-settings"
  | "gdscript-text"
  | "godot-resource"
  | "csharp-text"
  | "derived";

export interface KnowledgeProvenance {
  source: KnowledgeProvenanceSource;
  path: string;
  line?: number;
  evidence?: string;
  heuristic?: boolean;
}

export interface KnowledgeFact {
  key: string;
  value: string | number | boolean | string[];
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

export interface KnowledgeManifest {
  schemaVersion: 2;
  generatedAt: number;
  project: { id: string; path: "."; name: string; isGodotProject: boolean };
  coverage: {
    cap: number;
    discovered: number;
    scanned: number;
    complete: boolean;
    truncated: boolean;
    errors: Array<{ path: string; message: string }>;
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
  fingerprint: { algorithm: "sha256"; source: string; content: string };
  dirty: { value: boolean; reasons: Array<{ at: number; change: string }> };
}

export interface KnowledgeScopeCoverage {
  root: "res://" | "res://addons";
  discovered: number;
  scanned: number;
  scripts: number;
}

export interface ProjectMapData {
  manifest: KnowledgeManifest;
  entities: KnowledgeEntity[];
  relations: KnowledgeRelation[];
  ageMs: number;
}

export interface ProjectMapSearchHit { entity: KnowledgeEntity; score: number }
export interface ProjectMapQueryResult { hits: ProjectMapSearchHit[]; refreshedMap?: ProjectMapData }
export interface ProjectMapAnswer { answer: string; entityIds: string[] }
