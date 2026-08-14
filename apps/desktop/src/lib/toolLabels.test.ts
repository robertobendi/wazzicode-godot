import { describe, expect, it } from "vitest";
import { codexMcpName, toolLabel } from "./toolLabels";

describe("Godot tool labels", () => {
  it("maps focused Godot tools for people, not protocols", () => {
    expect(toolLabel("mcp__godot-vibe-os__godot_get_scene_tree")).toBe(
      "Reading the scene tree",
    );
    expect(toolLabel("mcp__godot-vibe-os__godot_capture_3d_view")).toBe(
      "Capturing the 3D editor",
    );
    expect(
      toolLabel("mcp__godot-vibe-os__godot_get_filesystem_status"),
    ).toBe("Checking Godot resources");
    expect(toolLabel("mcp__godot-vibe-os__godot_read_script")).toBe(
      "Reading a Godot text resource",
    );
    expect(toolLabel("mcp__godot-vibe-os__godot_debug_run")).toBe(
      "Observing runtime evidence",
    );
  });

  it("normalizes Codex's server key", () => {
    expect(codexMcpName("godot_vibe_os", "godot_verify")).toBe(
      "mcp__godot-vibe-os__godot_verify",
    );
  });
});
