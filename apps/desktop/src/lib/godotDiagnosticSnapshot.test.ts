import { describe, expect, it } from "vitest";
import type { GodotDiagnosticsSnapshot } from "@/types/godotDiagnostics";
import { importState, sceneState } from "./godotDiagnosticSnapshot";

const snapshot: GodotDiagnosticsSnapshot = {
  filesystem: { scanning: false, importing: true, progress: 0.42, indexedFiles: 80 },
  scenes: {
    activeScene: "res://main.tscn",
    scenes: [
      { path: "res://main.tscn", name: "Main", isActive: true, isUnsaved: true },
      { path: "res://hud.tscn", name: "Hud", isActive: false, isUnsaved: false },
    ],
  },
  play: { playing: false },
  tests: { status: "not_configured", message: "No runner." },
  capturedAt: 1,
};

describe("Godot diagnostic snapshot", () => {
  it("summarizes open and unsaved scenes", () => {
    expect(sceneState(snapshot)).toMatchObject({ open: 2, unsaved: 1 });
  });

  it("reports import progress from real filesystem state", () => {
    expect(importState(snapshot)).toEqual({ busy: true, label: "42%" });
  });
});
