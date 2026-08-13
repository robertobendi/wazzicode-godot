import { describe, expect, it } from "vitest";
import {
  filterProjectMapHits,
  formatKnowledgeFactValue,
  formatProjectMapRelation,
  groupProjectMapFacts,
  groupProjectMapHits,
  localProjectMapHits,
  projectMapAncestorIds,
  projectMapBreadcrumbs,
  projectMapChildren,
  projectMapConnections,
  projectMapCoveragePercent,
  projectMapFacetCounts,
  projectMapNeighborhood,
  pushProjectMapHistory,
  reconcileProjectMapHistory,
} from "./projectMap";
import type {
  KnowledgeEntity,
  KnowledgeEntityKind,
  KnowledgeFact,
  KnowledgeRelation,
  KnowledgeRelationKind,
  ProjectMapData,
  ProjectMapSearchHit,
} from "@/types/projectMap";

function entity(
  id: string,
  kind: KnowledgeEntityKind,
  options: {
    name?: string;
    path?: string;
    scope?: KnowledgeEntity["scope"];
    facts?: KnowledgeFact[];
  } = {},
): KnowledgeEntity {
  return {
    id,
    kind,
    name: options.name ?? id,
    path: options.path,
    scope: options.scope ?? (kind === "project" ? "project" : "first-party"),
    facts: options.facts ?? [],
  };
}

function fact(key: string, value: KnowledgeFact["value"]): KnowledgeFact {
  return {
    key,
    value,
    provenance: { source: "derived", path: "." },
    observedAt: 1,
  };
}

function relation(
  id: string,
  kind: KnowledgeRelationKind,
  from: string,
  to: string,
): KnowledgeRelation {
  return {
    id,
    kind,
    from,
    to,
    provenance: { source: "derived", path: "." },
    observedAt: 1,
  };
}

function hits(entities: KnowledgeEntity[]): ProjectMapSearchHit[] {
  return entities.map((item, score) => ({ entity: item, score }));
}

function sampleMap(): ProjectMapData {
  return {
    ageMs: 10,
    manifest: {
      schemaVersion: 1,
      generatedAt: 1,
      project: {
        id: "project:sample",
        path: ".",
        name: "Sample",
        isUnityProject: true,
      },
      coverage: {
        cap: 100,
        discovered: 4,
        scanned: 3,
        complete: false,
        truncated: true,
        errors: [],
        counts: {
          files: 4,
          firstPartyScripts: 1,
          packageScripts: 0,
          scenes: 0,
          prefabs: 0,
          entities: 2,
          relations: 1,
        },
        scopes: {
          firstParty: {
            root: "Assets",
            discovered: 4,
            scanned: 3,
            scripts: 1,
          },
          packages: {
            root: "Packages",
            discovered: 0,
            scanned: 0,
            scripts: 0,
          },
        },
      },
      fingerprint: {
        algorithm: "sha256",
        source: "source",
        content: "content",
      },
      dirty: { value: false, reasons: [] },
    },
    entities: [
      {
        id: "script:player",
        kind: "script",
        name: "Player.cs",
        path: "Assets/Player.cs",
        scope: "first-party",
        facts: [],
      },
      {
        id: "type:player",
        kind: "type",
        name: "Player",
        path: "Assets/Player.cs",
        scope: "first-party",
        facts: [],
      },
    ],
    relations: [
      {
        id: "declares:player",
        kind: "declares",
        from: "script:player",
        to: "type:player",
        provenance: { source: "csharp-text", path: "Assets/Player.cs" },
        observedAt: 1,
      },
    ],
  };
}

function navigationMap(): ProjectMapData {
  const data = sampleMap();
  data.entities = [
    entity("project:sample", "project", { name: "Sample" }),
    entity("module:gameplay", "module", { name: "Gameplay" }),
    entity("script:player", "script", { name: "Player.cs" }),
    entity("script:package-player", "script", {
      name: "PackagePlayer.cs",
      scope: "package",
    }),
    entity("type:player", "type", { name: "Player" }),
    entity("module:cycle-a", "module", { name: "Cycle A" }),
    entity("module:cycle-b", "module", { name: "Cycle B" }),
    entity("scene:loose", "scene", { name: "Loose" }),
  ];
  data.relations = [
    relation("contains:module", "contains", "project:sample", "module:gameplay"),
    relation("contains:script", "contains", "module:gameplay", "script:player"),
    relation("declares:player", "declares", "script:player", "type:player"),
    relation(
      "declares:package-player",
      "declares",
      "script:package-player",
      "type:player",
    ),
    relation("cycle:a-b", "contains", "module:cycle-a", "module:cycle-b"),
    relation("cycle:b-a", "contains", "module:cycle-b", "module:cycle-a"),
  ];
  return data;
}

describe("project map presentation helpers", () => {
  it("reports bounded scan coverage without hiding truncation", () => {
    expect(projectMapCoveragePercent(sampleMap())).toBe(75);
  });

  it("groups directed relationships around the selected entity", () => {
    const data = sampleMap();
    const script = projectMapConnections(data, "script:player");
    expect(script.inbound).toHaveLength(0);
    expect(script.outbound[0].neighbor?.id).toBe("type:player");

    const type = projectMapConnections(data, "type:player");
    expect(type.inbound[0].neighbor?.id).toBe("script:player");
    expect(type.outbound).toHaveLength(0);
  });

  it("projects structural and dependency relations onto four directional arms", () => {
    const data = sampleMap();
    data.entities = [
      entity("selected", "type"),
      entity("north:contains", "module"),
      entity("north:declares", "script"),
      entity("south:contains", "type"),
      entity("south:declares", "type"),
      entity("west:derives", "type"),
      entity("west:references", "type"),
      entity("east:derives", "type"),
      entity("east:references", "type"),
    ];
    data.relations = [
      relation("north:contains", "contains", "north:contains", "selected"),
      relation("north:declares", "declares", "north:declares", "selected"),
      relation("south:contains", "contains", "selected", "south:contains"),
      relation("south:declares", "declares", "selected", "south:declares"),
      relation("west:derives", "derives", "west:derives", "selected"),
      relation(
        "west:references",
        "references",
        "west:references",
        "selected",
      ),
      relation("east:derives", "derives", "selected", "east:derives"),
      relation(
        "east:references",
        "references",
        "selected",
        "east:references",
      ),
    ];

    const neighborhood = projectMapNeighborhood(data, "selected");
    expect(
      Object.fromEntries(
        Object.entries(neighborhood).map(([arm, value]) => [
          arm,
          value.nodes.map((node) => node.neighbor.id),
        ]),
      ),
    ).toEqual({
      north: ["north:contains", "north:declares"],
      south: ["south:contains", "south:declares"],
      west: ["west:derives", "west:references"],
      east: ["east:derives", "east:references"],
    });
  });

  it("coalesces neighbors and orders their relations by kind and id", () => {
    const data = sampleMap();
    const neighbor = entity("container", "script");
    data.entities = [entity("selected", "type"), neighbor];
    data.relations = [
      relation("z-declares", "declares", neighbor.id, "selected"),
      relation("z-contains", "contains", neighbor.id, "selected"),
      relation("a-contains", "contains", neighbor.id, "selected"),
    ];

    expect(projectMapNeighborhood(data, "selected").north.nodes).toEqual([
      {
        neighbor,
        relations: [data.relations[2], data.relations[1], data.relations[0]],
        primaryRelationKind: "contains",
      },
    ]);
  });

  it("sorts neighborhood nodes deterministically before capping each arm", () => {
    const data = sampleMap();
    data.entities = [
      entity("selected", "type"),
      entity("id:z", "type", { name: "alpha" }),
      entity("id:a", "type", { name: "Alpha" }),
      entity("id:b", "type", { name: "beta" }),
      entity("id:c", "type", { name: "aardvark" }),
    ];
    data.relations = [
      relation("reference:b", "references", "selected", "id:b"),
      relation("derive:z", "derives", "selected", "id:z"),
      relation("reference:c", "references", "selected", "id:c"),
      relation("derive:a", "derives", "selected", "id:a"),
    ];

    const forward = projectMapNeighborhood(data, "selected", 3).east;
    data.entities.reverse();
    data.relations.reverse();
    const reversed = projectMapNeighborhood(data, "selected", 3).east;

    expect(forward.nodes.map((node) => node.neighbor.id)).toEqual([
      "id:a",
      "id:z",
      "id:c",
    ]);
    expect(forward.omittedCount).toBe(1);
    expect(reversed).toEqual(forward);
  });

  it("shows structural folders before assets in dense neighborhoods", () => {
    const data = sampleMap();
    data.entities = [
      entity("project", "project"),
      entity("scene:a", "scene", { name: "0" }),
      entity("scene:b", "scene", { name: "Bootstrap" }),
      entity("module:z", "module", { name: "Scripts" }),
      entity("module:a", "module", { name: "Assets" }),
    ];
    data.relations = data.entities.slice(1).map((item) =>
      relation(`contains:${item.id}`, "contains", "project", item.id),
    );

    expect(
      projectMapNeighborhood(data, "project", 3).south.nodes.map(
        (node) => node.neighbor.id,
      ),
    ).toEqual(["module:a", "module:z", "scene:a"]);
  });

  it("ignores dangling neighborhood endpoints and empties missing selections", () => {
    const data = sampleMap();
    data.entities = [entity("selected", "type"), entity("valid", "type")];
    data.relations = [
      relation("valid", "derives", "selected", "valid"),
      relation("dangling", "references", "selected", "missing"),
      relation("self", "references", "selected", "selected"),
    ];

    expect(
      projectMapNeighborhood(data, "selected").east.nodes.map(
        (node) => node.neighbor.id,
      ),
    ).toEqual(["valid"]);
    expect(projectMapNeighborhood(data, "missing")).toEqual({
      north: { nodes: [], omittedCount: 0 },
      south: { nodes: [], omittedCount: 0 },
      west: { nodes: [], omittedCount: 0 },
      east: { nodes: [], omittedCount: 0 },
    });
  });

  it("renders structured fact values compactly", () => {
    expect(formatKnowledgeFactValue(["Player", "Mover"])).toBe(
      "Player, Mover",
    );
    expect(formatKnowledgeFactValue(true)).toBe("Yes");
  });

  it("counts every facet and includes every entity in all", () => {
    const entities = [
      entity("project", "project"),
      entity("script:a", "script"),
      entity("script:b", "script"),
      entity("type:a", "type"),
    ];

    expect(projectMapFacetCounts(entities)).toEqual({
      all: 4,
      project: 1,
      module: 0,
      scene: 0,
      prefab: 0,
      script: 2,
      type: 1,
      package: 0,
    });
  });

  it("filters hits without changing server order or scores", () => {
    const allHits = [
      { entity: entity("scene", "scene"), score: 90 },
      { entity: entity("script:b", "script"), score: 40 },
      { entity: entity("script:a", "script"), score: 80 },
    ];

    expect(filterProjectMapHits(allHits, "all")).toBe(allHits);
    expect(filterProjectMapHits(allHits, "script")).toEqual([
      allHits[1],
      allHits[2],
    ]);
  });

  it("groups hits in browsing order while preserving order within groups", () => {
    const allHits = hits([
      entity("type:b", "type"),
      entity("script:a", "script"),
      entity("project", "project"),
      entity("type:a", "type"),
      entity("module", "module"),
    ]);

    const groups = groupProjectMapHits(allHits);
    expect(groups.map(({ kind, label }) => [kind, label])).toEqual([
      ["project", "project"],
      ["module", "module"],
      ["script", "C# script"],
      ["type", "type"],
    ]);
    expect(groups.at(-1)?.hits).toEqual([allHits[0], allHits[3]]);
  });

  it("builds type breadcrumbs through its script and module", () => {
    expect(
      projectMapBreadcrumbs(navigationMap(), "type:player").map(
        (item) => item.id,
      ),
    ).toEqual([
      "project:sample",
      "module:gameplay",
      "script:player",
      "type:player",
    ]);
  });

  it("uses contains for nested types while preferring declares for normal types", () => {
    const data = navigationMap();
    data.entities.push(
      entity("type:outer", "type", { name: "Outer" }),
      entity("type:nested", "type", { name: "Nested" }),
      entity("type:normal", "type", { name: "Normal" }),
    );
    data.relations.push(
      relation("declares:outer", "declares", "script:player", "type:outer"),
      relation("contains:nested", "contains", "type:outer", "type:nested"),
      relation("declares:nested", "declares", "script:player", "type:nested"),
      relation("declares:normal", "declares", "script:player", "type:normal"),
    );

    expect(
      projectMapBreadcrumbs(data, "type:nested").map((item) => item.id),
    ).toEqual([
      "project:sample",
      "module:gameplay",
      "script:player",
      "type:outer",
      "type:nested",
    ]);
    expect(
      projectMapBreadcrumbs(data, "type:normal").map((item) => item.id),
    ).toEqual([
      "project:sample",
      "module:gameplay",
      "script:player",
      "type:normal",
    ]);
    expect(projectMapAncestorIds(data, "type:nested")).toEqual([
      "project:sample",
      "module:gameplay",
      "script:player",
      "type:outer",
    ]);
  });

  it("keeps breadcrumbs cycle-safe and anchors disconnected entities", () => {
    const data = navigationMap();
    expect(
      projectMapBreadcrumbs(data, "module:cycle-a").map((item) => item.id),
    ).toEqual(["project:sample", "module:cycle-b", "module:cycle-a"]);
    expect(
      projectMapBreadcrumbs(data, "scene:loose").map((item) => item.id),
    ).toEqual(["project:sample", "scene:loose"]);
    expect(projectMapBreadcrumbs(data, "missing")).toEqual([]);
  });

  it.each([
    ["contains", "inbound", "Part of"],
    ["contains", "outbound", "Contains"],
    ["declares", "inbound", "Declared in"],
    ["declares", "outbound", "Declares"],
    ["derives", "inbound", "Derived by"],
    ["derives", "outbound", "Inherits from"],
    ["references", "inbound", "Referenced by"],
    ["references", "outbound", "References"],
  ] as const)("formats %s %s relations", (kind, direction, label) => {
    expect(formatProjectMapRelation(kind, direction)).toBe(label);
  });

  it("searches names, paths, and facts case-insensitively", () => {
    const entities = [
      entity("type:camera", "type", { name: "CameraRig" }),
      entity("script:combat", "script", {
        name: "Utility.cs",
        path: "Assets/Combat/Utility.cs",
        facts: [fact("memberSignature", "Spawn Enemy")],
      }),
    ];

    expect(localProjectMapHits(entities, "CAMERA")[0].entity.id).toBe(
      "type:camera",
    );
    expect(localProjectMapHits(entities, "combat")[0].entity.id).toBe(
      "script:combat",
    );
    expect(localProjectMapHits(entities, "membersignature")[0].entity.id).toBe(
      "script:combat",
    );
    expect(localProjectMapHits(entities, "spawn")[0].entity.id).toBe(
      "script:combat",
    );
  });

  it("requires every search token to match", () => {
    const entities = [
      entity("script:combat", "script", {
        name: "Utility.cs",
        path: "Assets/Combat/Utility.cs",
        facts: [fact("memberSignature", "Spawn Enemy")],
      }),
      entity("script:other", "script", {
        name: "Combat.cs",
      }),
    ];

    expect(
      localProjectMapHits(entities, "combat spawn").map(
        ({ entity: item }) => item.id,
      ),
    ).toEqual(["script:combat"]);
  });

  it("ranks name matches before paths and facts with deterministic ties", () => {
    const entities = [
      entity("path", "type", { name: "Other", path: "Assets/Player.cs" }),
      entity("fact", "type", {
        name: "OtherFact",
        facts: [fact("role", "Player")],
      }),
      entity("contains", "type", { name: "SuperPlayer" }),
      entity("prefix", "type", { name: "PlayerController" }),
      entity("package", "type", { name: "Player", scope: "package" }),
      entity("first-party:b", "type", { name: "Player" }),
      entity("first-party:a", "type", { name: "Player" }),
    ];

    expect(
      localProjectMapHits(entities, "player").map(({ entity: item }) => item.id),
    ).toEqual([
      "first-party:a",
      "first-party:b",
      "package",
      "prefix",
      "contains",
      "path",
      "fact",
    ]);
  });

  it("caps empty and populated local search results", () => {
    const entities = [
      entity("a", "type", { name: "Match A" }),
      entity("b", "type", { name: "Match B" }),
      entity("c", "type", { name: "Match C" }),
    ];

    expect(localProjectMapHits(entities, "", 2)).toEqual([
      { entity: entities[0], score: 0 },
      { entity: entities[1], score: 0 },
    ]);
    expect(localProjectMapHits(entities, "match", 1)).toHaveLength(1);
  });

  it("returns deduplicated children in structural order", () => {
    const data = sampleMap();
    data.entities = [
      entity("root", "project"),
      entity("package", "package", { name: "Package" }),
      entity("type", "type", { name: "Type" }),
      entity("script:z", "script", { name: "Zeta.cs" }),
      entity("script:a", "script", { name: "Alpha.cs" }),
      entity("prefab", "prefab", { name: "Prefab" }),
      entity("scene", "scene", { name: "Scene" }),
      entity("module", "module", { name: "Module" }),
    ];
    data.relations = [
      ...data.entities
        .slice(1)
        .map((item) => relation(`contains:${item.id}`, "contains", "root", item.id)),
      relation("declares:type", "declares", "root", "type"),
    ];

    expect(projectMapChildren(data, "root").map((item) => item.id)).toEqual([
      "module",
      "scene",
      "prefab",
      "script:a",
      "script:z",
      "type",
      "package",
    ]);
  });

  it("places nested types only under their containing type", () => {
    const data = navigationMap();
    data.entities.push(
      entity("type:outer", "type", { name: "Outer" }),
      entity("type:nested", "type", { name: "Nested" }),
    );
    data.relations.push(
      relation("declares:outer", "declares", "script:player", "type:outer"),
      relation("declares:nested", "declares", "script:player", "type:nested"),
      relation("contains:nested", "contains", "type:outer", "type:nested"),
    );

    expect(
      projectMapChildren(data, "script:player").map((item) => item.id),
    ).toEqual(["type:outer", "type:player"]);
    expect(
      projectMapChildren(data, "type:outer").map((item) => item.id),
    ).toEqual(["type:nested"]);
  });

  it("deduplicates current history entries and truncates forward branches", () => {
    const history = ["project", "script", "type"];
    expect(pushProjectMapHistory(history, 1, "script")).toEqual({
      history,
      index: 1,
    });
    expect(pushProjectMapHistory(history, 1, "scene")).toEqual({
      history: ["project", "script", "scene"],
      index: 2,
    });
  });

  it("drops missing and forward history when map data is reconciled", () => {
    expect(
      reconcileProjectMapHistory(
        ["project", "removed", "script", "forward"],
        2,
        ["project", "script", "forward"],
        "script",
      ),
    ).toEqual({ history: ["project", "script"], index: 1 });

    expect(
      reconcileProjectMapHistory(
        ["project", "removed"],
        1,
        ["project"],
        "project",
      ),
    ).toEqual({ history: ["project"], index: 0 });
    expect(reconcileProjectMapHistory([], -1, [], null)).toEqual({
      history: [],
      index: -1,
    });
  });

  it("groups repeated facts without changing their first-occurrence order", () => {
    const firstMember = fact("memberSignature", "Move()");
    const role = fact("role", "Controller");
    const secondMember = fact("memberSignature", "Jump()");

    expect(groupProjectMapFacts([firstMember, role, secondMember])).toEqual([
      { key: "memberSignature", facts: [firstMember, secondMember] },
      { key: "role", facts: [role] },
    ]);
  });
});
