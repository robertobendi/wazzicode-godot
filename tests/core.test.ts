import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  makeError,
  isErrorCode,
  makeBridgeRequest,
  PROTOCOL_VERSION,
  BRIDGE_METHODS,
  GameObjectSchema,
  SceneHierarchySchema,
  ProjectSummarySchema,
} from "@uvibe/core";

describe("core/envelope", () => {
  it("produces ok envelopes with default meta", () => {
    const env = ok({ a: 1 }, { source: "mock" });
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data).toEqual({ a: 1 });
      expect(env.meta.source).toBe("mock");
      expect(env.meta.detailLevel).toBe("normal");
      expect(env.warnings).toEqual([]);
    }
  });

  it("produces err envelopes with stable codes", () => {
    const env = err("UNITY_NOT_CONNECTED");
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("UNITY_NOT_CONNECTED");
      expect(env.error.recoverable).toBe(true);
      expect(typeof env.error.suggestedAction).toBe("string");
    }
  });

  it("rejects unknown error codes via isErrorCode", () => {
    expect(isErrorCode("UNITY_NOT_CONNECTED")).toBe(true);
    expect(isErrorCode("FAKE_CODE")).toBe(false);
  });

  it("makeError returns metadata for every defined code", () => {
    const codes = [
      "UNITY_NOT_CONNECTED",
      "UNITY_COMPILING",
      "OBJECT_NOT_FOUND",
      "INVALID_ARGUMENT",
      "BRIDGE_TIMEOUT",
      "MALFORMED_BRIDGE_RESPONSE",
      "TOOL_NOT_IMPLEMENTED",
      "INTERNAL_ERROR",
    ] as const;
    for (const c of codes) {
      const d = makeError(c);
      expect(d.code).toBe(c);
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.suggestedAction.length).toBeGreaterThan(0);
    }
  });
});

describe("core/protocol", () => {
  it("makeBridgeRequest stamps protocol version and a uuid-like id", () => {
    const r = makeBridgeRequest(BRIDGE_METHODS.systemHealth);
    expect(r.version).toBe(PROTOCOL_VERSION);
    expect(r.method).toBe("system.health");
    expect(typeof r.id).toBe("string");
    expect(r.id.length).toBeGreaterThan(4);
    expect(r.params).toEqual({});
  });

  it("BRIDGE_METHODS exposes the MVP method names", () => {
    expect(Object.values(BRIDGE_METHODS)).toEqual(
      expect.arrayContaining([
        "system.health",
        "system.summary",
        "scene.getOpenScenes",
        "scene.getHierarchy",
        "selection.inspect",
        "console.getLogs",
        "compile.status",
      ])
    );
  });
});

describe("core/schemas", () => {
  it("ProjectSummarySchema accepts well-formed mock", () => {
    const r = ProjectSummarySchema.safeParse({
      unityVersion: "2022.3.42f1",
      projectPath: "/x",
      packages: [{ name: "com.unity.x", version: "1.0.0" }],
    });
    expect(r.success).toBe(true);
  });

  it("GameObjectSchema requires path/name/transform", () => {
    const bad = GameObjectSchema.safeParse({ name: "x" });
    expect(bad.success).toBe(false);
    const good = GameObjectSchema.safeParse({
      name: "Player",
      path: "/Player",
      activeSelf: true,
      activeInHierarchy: true,
      tag: "Untagged",
      layer: "Default",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        localScale: { x: 1, y: 1, z: 1 },
      },
      components: [],
    });
    expect(good.success).toBe(true);
  });

  it("SceneHierarchySchema validates nested children", () => {
    const r = SceneHierarchySchema.safeParse({
      scene: "Assets/Scenes/Sample.unity",
      roots: [
        {
          name: "Root",
          path: "/Root",
          active: true,
          childCount: 1,
          children: [
            { name: "Child", path: "/Root/Child", active: true, childCount: 0 },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});
