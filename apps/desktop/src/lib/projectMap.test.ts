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
      schemaVersion: 2,
      generatedAt: 1,
      project: {
        id: "project:sample",
        path: ".",
        name: "Sample",
        isGodotProject: true,
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
          addonScripts: 0,
          scenes: 0,
          resources: 0,
          shaders: 0,
          entities: 2,
          relations: 1,
        },
        scopes: {
          firstParty: {
            root: "res://",
            discovered: 4,
            scanned: 3,
            scripts: 1,
          },
          addons: {
            root: "res://addons",
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
        name: "player",
        path: "res://player.gd",
        scope: "first-party",
        facts: [],
      },
      {
        id: "class:player",
        kind: "class",
        name: "Player",
        path: "res://player.gd",
        scope: "first-party",
        facts: [],
      },
    ],
    relations: [
      {
        id: "declares:player",
        kind: "declares",
        from: "script:player",
        to: "class:player",
        provenance: { source: "gdscript-text", path: "res://player.gd" },
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
    entity("script:player", "script", { name: "player" }),
    entity("script:addon-player", "script", {
      name: "addon_player",
      scope: "addon",
    }),
    entity("class:player", "class", { name: "Player" }),
    entity("module:cycle-a", "module", { name: "Cycle A" }),
    entity("module:cycle-b", "module", { name: "Cycle B" }),
    entity("scene:loose", "scene", { name: "Loose" }),
  ];
  data.relations = [
    relation("contains:module", "contains", "project:sample", "module:gameplay"),
    relation("contains:script", "contains", "module:gameplay", "script:player"),
    relation("declares:player", "declares", "script:player", "class:player"),
    relation(
      "declares:addon-player",
      "declares",
      "script:addon-player",
      "class:player",
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
    expect(script.outbound[0].neighbor?.id).toBe("class:player");

    const type = projectMapConnections(data, "class:player");
    expect(type.inbound[0].neighbor?.id).toBe("script:player");
    expect(type.outbound).toHaveLength(0);
  });

  it("projects structural and dependency relations onto four directional arms", () => {
    const data = sampleMap();
    data.entities = [
      entity("selected", "class"),
      entity("north:contains", "module"),
      entity("north:declares", "script"),
      entity("south:contains", "class"),
      entity("south:declares", "class"),
      entity("west:extends", "class"),
      entity("west:references", "class"),
      entity("east:extends", "class"),
      entity("east:references", "class"),
    ];
    data.relations = [
      relation("north:contains", "contains", "north:contains", "selected"),
      relation("north:declares", "declares", "north:declares", "selected"),
      relation("south:contains", "contains", "selected", "south:contains"),
      relation("south:declares", "declares", "selected", "south:declares"),
      relation("west:extends", "extends", "west:extends", "selected"),
      relation(
        "west:references",
        "references",
        "west:references",
        "selected",
      ),
      relation("east:extends", "extends", "selected", "east:extends"),
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
      west: ["west:extends", "west:references"],
      east: ["east:extends", "east:references"],
    });
  });

  it("coalesces neighbors and orders their relations by kind and id", () => {
    const data = sampleMap();
    const neighbor = entity("container", "script");
    data.entities = [entity("selected", "class"), neighbor];
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
      entity("selected", "class"),
      entity("id:z", "class", { name: "alpha" }),
      entity("id:a", "class", { name: "Alpha" }),
      entity("id:b", "class", { name: "beta" }),
      entity("id:c", "class", { name: "aardvark" }),
    ];
    data.relations = [
      relation("reference:b", "references", "selected", "id:b"),
      relation("derive:z", "extends", "selected", "id:z"),
      relation("reference:c", "references", "selected", "id:c"),
      relation("derive:a", "extends", "selected", "id:a"),
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
      entity("module:a", "module", { name: "res://" }),
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
    data.entities = [entity("selected", "class"), entity("valid", "class")];
    data.relations = [
      relation("valid", "extends", "selected", "valid"),
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
      entity("class:a", "class"),
    ];

    expect(projectMapFacetCounts(entities)).toEqual({
      all: 4,
      project: 1,
      module: 0,
      scene: 0,
      resource: 0,
      script: 2,
      class: 1,
      shader: 0,
      addon: 0,
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
      entity("class:b", "class"),
      entity("script:a", "script"),
      entity("project", "project"),
      entity("class:a", "class"),
      entity("module", "module"),
    ]);

    const groups = groupProjectMapHits(allHits);
    expect(groups.map(({ kind, label }) => [kind, label])).toEqual([
      ["project", "project"],
      ["module", "module"],
      ["script", "script"],
      ["class", "class"],
    ]);
    expect(groups.at(-1)?.hits).toEqual([allHits[0], allHits[3]]);
  });

  it("builds class breadcrumbs through its script and folder", () => {
    expect(
      projectMapBreadcrumbs(navigationMap(), "class:player").map(
        (item) => item.id,
      ),
    ).toEqual([
      "project:sample",
      "module:gameplay",
      "script:player",
      "class:player",
    ]);
  });

  it("uses contains for nested classes while preferring declares for normal classes", () => {
    const data = navigationMap();
    data.entities.push(
      entity("class:outer", "class", { name: "Outer" }),
      entity("class:nested", "class", { name: "Nested" }),
      entity("class:normal", "class", { name: "Normal" }),
    );
    data.relations.push(
      relation("declares:outer", "declares", "script:player", "class:outer"),
      relation("contains:nested", "contains", "class:outer", "class:nested"),
      relation("declares:nested", "declares", "script:player", "class:nested"),
      relation("declares:normal", "declares", "script:player", "class:normal"),
    );

    expect(
      projectMapBreadcrumbs(data, "class:nested").map((item) => item.id),
    ).toEqual([
      "project:sample",
      "module:gameplay",
      "script:player",
      "class:outer",
      "class:nested",
    ]);
    expect(
      projectMapBreadcrumbs(data, "class:normal").map((item) => item.id),
    ).toEqual([
      "project:sample",
      "module:gameplay",
      "script:player",
      "class:normal",
    ]);
    expect(projectMapAncestorIds(data, "class:nested")).toEqual([
      "project:sample",
      "module:gameplay",
      "script:player",
      "class:outer",
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
    ["extends", "inbound", "Extended by"],
    ["extends", "outbound", "Extends"],
    ["references", "inbound", "Referenced by"],
    ["references", "outbound", "References"],
  ] as const)("formats %s %s relations", (kind, direction, label) => {
    expect(formatProjectMapRelation(kind, direction)).toBe(label);
  });

  it("searches names, paths, and facts case-insensitively", () => {
    const entities = [
      entity("class:camera", "class", { name: "CameraRig" }),
      entity("script:combat", "script", {
        name: "utility",
        path: "res://combat/utility.gd",
        facts: [fact("function", "func spawn_enemy()")],
      }),
    ];

    expect(localProjectMapHits(entities, "CAMERA")[0].entity.id).toBe(
      "class:camera",
    );
    expect(localProjectMapHits(entities, "combat")[0].entity.id).toBe(
      "script:combat",
    );
    expect(localProjectMapHits(entities, "function")[0].entity.id).toBe(
      "script:combat",
    );
    expect(localProjectMapHits(entities, "spawn")[0].entity.id).toBe(
      "script:combat",
    );
  });

  it("requires every search token to match", () => {
    const entities = [
      entity("script:combat", "script", {
        name: "utility",
        path: "res://combat/utility.gd",
        facts: [fact("function", "func spawn_enemy()")],
      }),
      entity("script:other", "script", {
        name: "combat",
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
      entity("path", "class", { name: "Other", path: "res://player.gd" }),
      entity("fact", "class", {
        name: "OtherFact",
        facts: [fact("role", "Player")],
      }),
      entity("contains", "class", { name: "SuperPlayer" }),
      entity("prefix", "class", { name: "PlayerController" }),
      entity("addon", "class", { name: "Player", scope: "addon" }),
      entity("first-party:b", "class", { name: "Player" }),
      entity("first-party:a", "class", { name: "Player" }),
    ];

    expect(
      localProjectMapHits(entities, "player").map(({ entity: item }) => item.id),
    ).toEqual([
      "first-party:a",
      "first-party:b",
      "addon",
      "prefix",
      "contains",
      "path",
      "fact",
    ]);
  });

  it("caps empty and populated local search results", () => {
    const entities = [
      entity("a", "class", { name: "Match A" }),
      entity("b", "class", { name: "Match B" }),
      entity("c", "class", { name: "Match C" }),
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
      entity("addon", "addon", { name: "Addon" }),
      entity("class", "class", { name: "Class" }),
      entity("script:z", "script", { name: "zeta" }),
      entity("script:a", "script", { name: "alpha" }),
      entity("resource", "resource", { name: "Resource" }),
      entity("scene", "scene", { name: "Scene" }),
      entity("module", "module", { name: "Module" }),
    ];
    data.relations = [
      ...data.entities
        .slice(1)
        .map((item) => relation(`contains:${item.id}`, "contains", "root", item.id)),
      relation("declares:class", "declares", "root", "class"),
    ];

    expect(projectMapChildren(data, "root").map((item) => item.id)).toEqual([
      "module",
      "scene",
      "resource",
      "script:a",
      "script:z",
      "class",
      "addon",
    ]);
  });

  it("places nested classes only under their containing class", () => {
    const data = navigationMap();
    data.entities.push(
      entity("class:outer", "class", { name: "Outer" }),
      entity("class:nested", "class", { name: "Nested" }),
    );
    data.relations.push(
      relation("declares:outer", "declares", "script:player", "class:outer"),
      relation("declares:nested", "declares", "script:player", "class:nested"),
      relation("contains:nested", "contains", "class:outer", "class:nested"),
    );

    expect(
      projectMapChildren(data, "script:player").map((item) => item.id),
    ).toEqual(["class:outer", "class:player"]);
    expect(
      projectMapChildren(data, "class:outer").map((item) => item.id),
    ).toEqual(["class:nested"]);
  });

  it("deduplicates current history entries and truncates forward branches", () => {
    const history = ["project", "script", "class"];
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
    const firstMember = fact("function", "func move()");
    const base = fact("baseClass", "CharacterBody2D");
    const secondMember = fact("function", "func jump()");

    expect(groupProjectMapFacts([firstMember, base, secondMember])).toEqual([
      { key: "function", facts: [firstMember, secondMember] },
      { key: "baseClass", facts: [base] },
    ]);
  });
});
