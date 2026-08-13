import { describe, it, expect } from "vitest";
import { gateTool, writeTargetOf, UVibeConfigSchema } from "@uvibe/safety";

const cfg = (over: Record<string, unknown> = {}) => UVibeConfigSchema.parse(over);

describe("safety/policy", () => {
  it("allows non-write tools regardless of mode", () => {
    expect(gateTool(cfg({ safetyMode: "read_only" }), "unity_get_scene_hierarchy").allowed).toBe(true);
  });

  it("read_only blocks every write tool", () => {
    for (const tool of ["unity_set_serialized_field", "unity_add_component", "unity_save_scene"]) {
      const d = gateTool(cfg({ safetyMode: "read_only" }), tool);
      expect(d.allowed, tool).toBe(false);
      expect(d.errorCode).toBe("SAFETY_MODE_BLOCKED");
    }
  });

  it("suggest mode proposes but does not apply", () => {
    expect(gateTool(cfg({ safetyMode: "suggest" }), "unity_add_component").allowed).toBe(false);
  });

  it("confirm/autopilot honor per-target flags", () => {
    // Scene writes off → blocked even in autopilot.
    expect(gateTool(cfg({ safetyMode: "autopilot", allowSceneWrites: false }), "unity_set_serialized_field").allowed).toBe(false);
    // Scene writes on → allowed.
    expect(gateTool(cfg({ safetyMode: "autopilot", allowSceneWrites: true }), "unity_set_serialized_field").allowed).toBe(true);
    expect(gateTool(cfg({ safetyMode: "confirm", allowSceneWrites: true }), "unity_save_scene").allowed).toBe(true);
  });

  it("classifies write targets explicitly (regression: no substring matching)", () => {
    // The old substring gate matched 'scene' in unity_save_scene but missed set_serialized_field.
    expect(writeTargetOf("unity_save_scene")).toBe("scene");
    expect(writeTargetOf("unity_set_serialized_field")).toBe("scene");
    expect(writeTargetOf("unity_create_prefab_variant")).toBe("prefab");
    expect(writeTargetOf("unity_get_scene_hierarchy")).toBeUndefined();
  });

  it("prefab writes need allowPrefabWrites", () => {
    expect(gateTool(cfg({ safetyMode: "autopilot", allowPrefabWrites: false }), "unity_create_prefab_variant").allowed).toBe(false);
    expect(gateTool(cfg({ safetyMode: "autopilot", allowPrefabWrites: true }), "unity_create_prefab_variant").allowed).toBe(true);
  });

  it("classifies the new write tools (layout/prefab/asset/editor)", () => {
    expect(writeTargetOf("unity_set_transform")).toBe("scene");
    expect(writeTargetOf("unity_reparent")).toBe("scene");
    expect(writeTargetOf("unity_paint_tilemap")).toBe("scene");
    expect(writeTargetOf("unity_save_prefab")).toBe("prefab");
    expect(writeTargetOf("unity_apply_prefab_instance")).toBe("prefab");
    expect(writeTargetOf("unity_import_asset")).toBe("asset");
    expect(writeTargetOf("unity_slice_sprite")).toBe("asset");
    expect(writeTargetOf("unity_animator_edit_transition")).toBe("asset");
    expect(writeTargetOf("unity_execute_menu_item")).toBe("editor");
    // Deletes are gated like their create counterparts.
    expect(writeTargetOf("unity_delete_gameobject")).toBe("scene");
    expect(writeTargetOf("unity_remove_component")).toBe("scene");
    expect(writeTargetOf("unity_delete_asset")).toBe("asset");
    // Non-write navigation/runtime tools must not be gated.
    expect(writeTargetOf("unity_open_scene")).toBeUndefined();
    expect(writeTargetOf("unity_simulate_input")).toBeUndefined();
    expect(writeTargetOf("unity_get_animator_state")).toBeUndefined();
  });

  it("asset writes need allowAssetWrites", () => {
    // Default config has allowAssetWrites=true, so asset creation is allowed under autopilot.
    expect(gateTool(cfg({ safetyMode: "autopilot" }), "unity_create_material").allowed).toBe(true);
    // Turning it off blocks asset creation even in autopilot.
    expect(gateTool(cfg({ safetyMode: "autopilot", allowAssetWrites: false }), "unity_create_material").allowed).toBe(false);
    expect(gateTool(cfg({ safetyMode: "autopilot", allowAssetWrites: false }), "unity_import_asset").allowed).toBe(false);
    // read_only blocks regardless.
    expect(gateTool(cfg({ safetyMode: "read_only", allowAssetWrites: true }), "unity_create_material").allowed).toBe(false);
  });

  it("gates delete tools by their target flags", () => {
    // Scene deletes follow allowSceneWrites.
    expect(gateTool(cfg({ safetyMode: "autopilot", allowSceneWrites: false }), "unity_delete_gameobject").allowed).toBe(false);
    expect(gateTool(cfg({ safetyMode: "autopilot", allowSceneWrites: true }), "unity_delete_gameobject").allowed).toBe(true);
    expect(gateTool(cfg({ safetyMode: "confirm", allowSceneWrites: true }), "unity_remove_component").allowed).toBe(true);
    // Asset deletes follow allowAssetWrites.
    expect(gateTool(cfg({ safetyMode: "autopilot", allowAssetWrites: false }), "unity_delete_asset").allowed).toBe(false);
    expect(gateTool(cfg({ safetyMode: "autopilot" }), "unity_delete_asset").allowed).toBe(true);
    // read_only blocks all of them.
    expect(gateTool(cfg({ safetyMode: "read_only" }), "unity_delete_gameobject").allowed).toBe(false);
  });

  it("editor menu execution needs allowMenuItems", () => {
    expect(gateTool(cfg({ safetyMode: "autopilot", allowMenuItems: false }), "unity_execute_menu_item").allowed).toBe(false);
    expect(gateTool(cfg({ safetyMode: "autopilot", allowMenuItems: true }), "unity_execute_menu_item").allowed).toBe(true);
    // read_only blocks it regardless of allowMenuItems.
    expect(gateTool(cfg({ safetyMode: "read_only", allowMenuItems: true }), "unity_execute_menu_item").allowed).toBe(false);
  });

  it("code execution is ready by default but still obeys an explicit lock", () => {
    expect(writeTargetOf("unity_execute_code")).toBe("code");
    expect(gateTool(cfg({ safetyMode: "autopilot" }), "unity_execute_code").allowed).toBe(true);
    expect(gateTool(cfg({ safetyMode: "autopilot", allowCodeExecution: false }), "unity_execute_code").allowed).toBe(false);
  });

  it("script writes need allowScriptWrites", () => {
    expect(writeTargetOf("unity_create_script")).toBe("script");
    expect(writeTargetOf("unity_apply_text_edits")).toBe("script");
    expect(writeTargetOf("unity_script_edit")).toBe("script");
    expect(gateTool(cfg({ safetyMode: "autopilot", allowScriptWrites: false }), "unity_create_script").allowed).toBe(false);
    expect(gateTool(cfg({ safetyMode: "autopilot", allowScriptWrites: true }), "unity_apply_text_edits").allowed).toBe(true);
  });
});
