import type {
  KnowledgeEntity,
  KnowledgeEntityKind,
  KnowledgeFact,
  KnowledgeRelation,
  KnowledgeRelationKind,
  ProjectMapData,
  ProjectMapSearchHit,
} from "@/types/projectMap";

export type ProjectMapFacet = "all" | KnowledgeEntityKind;

export interface ProjectMapHitGroup {
  kind: KnowledgeEntityKind;
  label: string;
  hits: ProjectMapSearchHit[];
}

export interface ProjectMapFactGroup {
  key: string;
  facts: KnowledgeFact[];
}

export interface ProjectMapConnection {
  relation: KnowledgeRelation;
  neighbor: KnowledgeEntity | null;
}

export type ProjectMapNeighborhoodArmId =
  | "north"
  | "south"
  | "west"
  | "east";

export interface ProjectMapNeighborhoodNode {
  neighbor: KnowledgeEntity;
  relations: KnowledgeRelation[];
  primaryRelationKind: KnowledgeRelationKind;
}

export interface ProjectMapNeighborhoodArm {
  nodes: ProjectMapNeighborhoodNode[];
  omittedCount: number;
}

export type ProjectMapNeighborhood = Record<
  ProjectMapNeighborhoodArmId,
  ProjectMapNeighborhoodArm
>;

const PROJECT_MAP_RELATION_KIND_PRIORITY: Record<
  KnowledgeRelationKind,
  number
> = {
  contains: 0,
  declares: 1,
  derives: 2,
  references: 3,
};

function compareProjectMapText(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function compareProjectMapTextExactly(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function emptyProjectMapNeighborhood(): ProjectMapNeighborhood {
  return {
    north: { nodes: [], omittedCount: 0 },
    south: { nodes: [], omittedCount: 0 },
    west: { nodes: [], omittedCount: 0 },
    east: { nodes: [], omittedCount: 0 },
  };
}

export function projectMapNeighborhood(
  data: ProjectMapData,
  selectedId: string,
  maxPerArm = 3,
): ProjectMapNeighborhood {
  const byId = new Map(data.entities.map((entity) => [entity.id, entity]));
  if (!byId.has(selectedId)) return emptyProjectMapNeighborhood();

  const grouped: Record<
    ProjectMapNeighborhoodArmId,
    Map<string, ProjectMapNeighborhoodNode>
  > = {
    north: new Map(),
    south: new Map(),
    west: new Map(),
    east: new Map(),
  };

  const add = (
    armId: ProjectMapNeighborhoodArmId,
    neighborId: string,
    relation: KnowledgeRelation,
  ) => {
    if (neighborId === selectedId) return;
    const neighbor = byId.get(neighborId);
    if (!neighbor) return;
    const existing = grouped[armId].get(neighborId);
    if (existing) existing.relations.push(relation);
    else {
      grouped[armId].set(neighborId, {
        neighbor,
        relations: [relation],
        primaryRelationKind: relation.kind,
      });
    }
  };

  for (const relation of data.relations) {
    const isStructural =
      relation.kind === "contains" || relation.kind === "declares";
    if (relation.to === selectedId) {
      add(isStructural ? "north" : "west", relation.from, relation);
    }
    if (relation.from === selectedId) {
      add(isStructural ? "south" : "east", relation.to, relation);
    }
  }

  const relationOrder = (left: KnowledgeRelation, right: KnowledgeRelation) =>
    PROJECT_MAP_RELATION_KIND_PRIORITY[left.kind] -
      PROJECT_MAP_RELATION_KIND_PRIORITY[right.kind] ||
    compareProjectMapText(left.id, right.id) ||
    compareProjectMapTextExactly(left.id, right.id);
  const nodeOrder = (
    left: ProjectMapNeighborhoodNode,
    right: ProjectMapNeighborhoodNode,
  ) =>
    PROJECT_MAP_RELATION_KIND_PRIORITY[left.primaryRelationKind] -
      PROJECT_MAP_RELATION_KIND_PRIORITY[right.primaryRelationKind] ||
    (left.primaryRelationKind === "contains"
      ? PROJECT_MAP_STRUCTURE_KIND_PRIORITY[left.neighbor.kind] -
        PROJECT_MAP_STRUCTURE_KIND_PRIORITY[right.neighbor.kind]
      : 0) ||
    compareProjectMapText(left.neighbor.name, right.neighbor.name) ||
    compareProjectMapText(left.neighbor.id, right.neighbor.id) ||
    compareProjectMapTextExactly(left.neighbor.name, right.neighbor.name) ||
    compareProjectMapTextExactly(left.neighbor.id, right.neighbor.id);
  const cap = Number.isFinite(maxPerArm)
    ? Math.max(0, Math.floor(maxPerArm))
    : 0;

  const result = emptyProjectMapNeighborhood();
  for (const armId of Object.keys(grouped) as ProjectMapNeighborhoodArmId[]) {
    const nodes = [...grouped[armId].values()];
    for (const node of nodes) {
      node.relations.sort(relationOrder);
      node.primaryRelationKind = node.relations[0].kind;
    }
    nodes.sort(nodeOrder);
    result[armId] = {
      nodes: nodes.slice(0, cap),
      omittedCount: Math.max(0, nodes.length - cap),
    };
  }
  return result;
}

export function projectMapCoveragePercent(data: ProjectMapData): number {
  const { discovered, scanned, complete } = data.manifest.coverage;
  if (discovered <= 0) return complete ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((scanned / discovered) * 100)));
}

export function projectMapConnections(
  data: ProjectMapData,
  entityId: string,
): {
  inbound: ProjectMapConnection[];
  outbound: ProjectMapConnection[];
} {
  const entities = new Map(data.entities.map((entity) => [entity.id, entity]));
  const inbound: ProjectMapConnection[] = [];
  const outbound: ProjectMapConnection[] = [];
  for (const relation of data.relations) {
    if (relation.to === entityId) {
      inbound.push({
        relation,
        neighbor: entities.get(relation.from) ?? null,
      });
    }
    if (relation.from === entityId) {
      outbound.push({
        relation,
        neighbor: entities.get(relation.to) ?? null,
      });
    }
  }
  const byName = (left: ProjectMapConnection, right: ProjectMapConnection) =>
    (left.neighbor?.name ?? left.relation.id).localeCompare(
      right.neighbor?.name ?? right.relation.id,
    );
  inbound.sort(byName);
  outbound.sort(byName);
  return { inbound, outbound };
}

const PROJECT_MAP_KIND_ORDER: KnowledgeEntityKind[] = [
  "project",
  "module",
  "scene",
  "prefab",
  "script",
  "type",
  "package",
];

const PROJECT_MAP_SCOPE_ORDER: Record<KnowledgeEntity["scope"], number> = {
  project: 0,
  "first-party": 1,
  package: 2,
  external: 3,
};

const PROJECT_MAP_STRUCTURE_KIND_PRIORITY: Record<KnowledgeEntityKind, number> = {
  module: 0,
  scene: 1,
  prefab: 2,
  script: 3,
  type: 4,
  package: 5,
  project: 6,
};

export function projectMapFacetCounts(
  entities: KnowledgeEntity[],
): Record<ProjectMapFacet, number> {
  const counts: Record<ProjectMapFacet, number> = {
    all: entities.length,
    project: 0,
    module: 0,
    scene: 0,
    prefab: 0,
    script: 0,
    type: 0,
    package: 0,
  };
  for (const entity of entities) counts[entity.kind] += 1;
  return counts;
}

export function filterProjectMapHits(
  hits: ProjectMapSearchHit[],
  facet: ProjectMapFacet,
): ProjectMapSearchHit[] {
  return facet === "all"
    ? hits
    : hits.filter(({ entity }) => entity.kind === facet);
}

export function groupProjectMapHits(
  hits: ProjectMapSearchHit[],
): ProjectMapHitGroup[] {
  const byKind = new Map<KnowledgeEntityKind, ProjectMapSearchHit[]>();
  for (const hit of hits) {
    const grouped = byKind.get(hit.entity.kind);
    if (grouped) grouped.push(hit);
    else byKind.set(hit.entity.kind, [hit]);
  }

  const groups: ProjectMapHitGroup[] = [];
  for (const kind of PROJECT_MAP_KIND_ORDER) {
    const grouped = byKind.get(kind);
    if (grouped) {
      groups.push({ kind, label: formatKnowledgeKind(kind), hits: grouped });
    }
  }
  return groups;
}

export function localProjectMapHits(
  entities: KnowledgeEntity[],
  query: string,
  limit = 80,
): ProjectMapSearchHit[] {
  const cappedLimit = Math.max(0, limit);
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return entities
      .slice(0, cappedLimit)
      .map((entity) => ({ entity, score: 0 }));
  }

  const tokens = normalizedQuery.split(/\s+/);
  return entities
    .flatMap((entity) => {
      const name = entity.name.toLowerCase();
      const path = entity.path?.toLowerCase() ?? "";
      const metadata = [entity.kind, entity.scope];
      const facts = entity.facts.flatMap((fact) => [
        fact.key.toLowerCase(),
        formatKnowledgeFactValue(fact.value).toLowerCase(),
      ]);
      let score = 0;

      for (const token of tokens) {
        if (name === token) score += 400;
        else if (name.startsWith(token)) score += 300;
        else if (name.includes(token)) score += 200;
        else if (path.includes(token)) score += 100;
        else if (metadata.some((value) => value.includes(token))) score += 50;
        else if (facts.some((value) => value.includes(token))) score += 25;
        else return [];
      }

      if (name === normalizedQuery) score += 10_000;
      else if (name.startsWith(normalizedQuery)) score += 8_000;
      else if (name.includes(normalizedQuery)) score += 6_000;
      return [{ entity, score }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        PROJECT_MAP_SCOPE_ORDER[left.entity.scope] -
          PROJECT_MAP_SCOPE_ORDER[right.entity.scope] ||
        left.entity.id.localeCompare(right.entity.id),
    )
    .slice(0, cappedLimit);
}

export function projectMapChildren(
  data: ProjectMapData,
  entityId: string,
): KnowledgeEntity[] {
  const byId = new Map(data.entities.map((entity) => [entity.id, entity]));
  const nestedTypeIds = new Set(
    data.relations.flatMap((relation) => {
      if (relation.kind !== "contains") return [];
      const parent = byId.get(relation.from);
      const child = byId.get(relation.to);
      return parent?.kind === "type" && child?.kind === "type"
        ? [child.id]
        : [];
    }),
  );
  const children = new Map<string, KnowledgeEntity>();
  for (const relation of data.relations) {
    if (
      relation.from !== entityId ||
      (relation.kind !== "contains" && relation.kind !== "declares")
    ) {
      continue;
    }
    const child = byId.get(relation.to);
    if (
      child?.kind === "type" &&
      relation.kind === "declares" &&
      nestedTypeIds.has(child.id)
    ) {
      continue;
    }
    if (child) children.set(child.id, child);
  }

  return [...children.values()].sort(
    (left, right) =>
      PROJECT_MAP_STRUCTURE_KIND_PRIORITY[left.kind] -
        PROJECT_MAP_STRUCTURE_KIND_PRIORITY[right.kind] ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

export function projectMapBreadcrumbs(
  data: ProjectMapData,
  entityId: string,
): KnowledgeEntity[] {
  const byId = new Map(data.entities.map((entity) => [entity.id, entity]));
  const selected = byId.get(entityId);
  if (!selected) return [];

  interface ParentCandidate {
    parent: KnowledgeEntity;
    relationKind: "contains" | "declares";
  }

  const parentPriority = ({
    parent,
    relationKind,
  }: ParentCandidate): number => {
    if (relationKind === "contains" && parent.kind === "type") return 0;
    return relationKind === "declares" ? 1 : 2;
  };
  const parents = new Map<string, Map<string, ParentCandidate>>();
  for (const relation of data.relations) {
    const child = byId.get(relation.to);
    const parent = byId.get(relation.from);
    if (
      !child ||
      !parent ||
      (relation.kind !== "contains" && relation.kind !== "declares") ||
      (child.kind !== "type" && relation.kind !== "contains")
    ) {
      continue;
    }
    const candidates = parents.get(child.id);
    const candidate = { parent, relationKind: relation.kind };
    const existing = candidates?.get(parent.id);
    if (!candidates) {
      parents.set(child.id, new Map([[parent.id, candidate]]));
    } else if (
      !existing ||
      parentPriority(candidate) < parentPriority(existing)
    ) {
      candidates.set(parent.id, candidate);
    }
  }

  const compareParents = (left: ParentCandidate, right: ParentCandidate) =>
    parentPriority(left) - parentPriority(right) ||
    PROJECT_MAP_SCOPE_ORDER[left.parent.scope] -
      PROJECT_MAP_SCOPE_ORDER[right.parent.scope] ||
    left.parent.id.localeCompare(right.parent.id);

  const lineage = [selected];
  const visited = new Set([selected.id]);
  let current = selected;
  while (current.kind !== "project") {
    const parent = [...(parents.get(current.id)?.values() ?? [])]
      .sort(compareParents)
      .map((candidate) => candidate.parent)
      .find((candidate) => !visited.has(candidate.id));
    if (!parent) break;
    lineage.push(parent);
    visited.add(parent.id);
    current = parent;
  }

  lineage.reverse();
  if (selected.kind !== "project" && lineage[0]?.kind !== "project") {
    const project =
      byId.get(data.manifest.project.id) ??
      data.entities.find((entity) => entity.kind === "project");
    if (project && !visited.has(project.id)) lineage.unshift(project);
  }
  return lineage;
}

export function projectMapAncestorIds(
  data: ProjectMapData,
  entityId: string,
): string[] {
  return projectMapBreadcrumbs(data, entityId)
    .slice(0, -1)
    .map((entity) => entity.id);
}

export function pushProjectMapHistory(
  history: string[],
  index: number,
  id: string,
): { history: string[]; index: number } {
  if (history[index] === id) return { history, index };
  const nextHistory = [...history.slice(0, index + 1), id];
  return { history: nextHistory, index: nextHistory.length - 1 };
}

export function reconcileProjectMapHistory(
  history: string[],
  index: number,
  availableIds: Iterable<string>,
  selectedId: string | null,
): { history: string[]; index: number } {
  if (!selectedId) return { history: [], index: -1 };
  const available = new Set(availableIds);
  const nextHistory = history
    .slice(0, index + 1)
    .filter((id) => id !== selectedId && available.has(id));
  nextHistory.push(selectedId);
  return { history: nextHistory, index: nextHistory.length - 1 };
}

export function groupProjectMapFacts(
  facts: KnowledgeFact[],
): ProjectMapFactGroup[] {
  const groups = new Map<string, KnowledgeFact[]>();
  for (const fact of facts) {
    const grouped = groups.get(fact.key);
    if (grouped) grouped.push(fact);
    else groups.set(fact.key, [fact]);
  }
  return [...groups].map(([key, grouped]) => ({ key, facts: grouped }));
}

export function formatProjectMapRelation(
  kind: KnowledgeRelationKind,
  direction: "inbound" | "outbound",
): string {
  const labels: Record<
    KnowledgeRelationKind,
    Record<"inbound" | "outbound", string>
  > = {
    contains: { inbound: "Part of", outbound: "Contains" },
    declares: { inbound: "Declared in", outbound: "Declares" },
    derives: { inbound: "Derived by", outbound: "Inherits from" },
    references: { inbound: "Referenced by", outbound: "References" },
  };
  return labels[kind][direction];
}

export function formatKnowledgeFactValue(value: KnowledgeFact["value"]): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function formatKnowledgeKind(kind: KnowledgeEntity["kind"]): string {
  return kind === "script" ? "C# script" : kind;
}
