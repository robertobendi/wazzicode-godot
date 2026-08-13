export type KnowledgeEntityKind =
  | "project"
  | "package"
  | "scene"
  | "prefab"
  | "script"
  | "type"
  | "module";

export type KnowledgeScope =
  | "project"
  | "first-party"
  | "package"
  | "external";

export type KnowledgeRelationKind =
  | "contains"
  | "declares"
  | "derives"
  | "references";

export type KnowledgeProvenanceSource =
  | "filesystem"
  | "project-settings"
  | "package-manifest"
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
  /** Present only for heuristic facts. */
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
  /** Present only for heuristic relationships. */
  confidence?: number;
}

export interface KnowledgeManifest {
  schemaVersion: 1;
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
    errors: Array<{ path: string; message: string }>;
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
    reasons: Array<{ at: number; change: string }>;
  };
}

export interface KnowledgeScopeCoverage {
  root: "Assets" | "Packages";
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

export interface ProjectMapSearchHit {
  entity: KnowledgeEntity;
  score: number;
}

export interface ProjectMapQueryResult {
  hits: ProjectMapSearchHit[];
  refreshedMap?: ProjectMapData;
}

/** Answer to a read-only question about the project, plus the entities it
 *  cites — already filtered to ids that exist in the current map. */
export interface ProjectMapAnswer {
  answer: string;
  entityIds: string[];
}
