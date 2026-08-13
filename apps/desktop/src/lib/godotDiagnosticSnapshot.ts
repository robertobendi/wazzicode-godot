import type {
  GodotDiagnosticsSnapshot,
  GodotSceneSummary,
} from "@/types/godotDiagnostics";

export function sceneState(snapshot: GodotDiagnosticsSnapshot | null) {
  const scenes = snapshot?.scenes.scenes ?? [];
  return {
    open: scenes.length,
    unsaved: scenes.filter((scene) => scene.isUnsaved).length,
    active: scenes.find((scene) => scene.isActive) ?? null,
  };
}

export function importState(snapshot: GodotDiagnosticsSnapshot | null) {
  if (!snapshot) return { busy: false, label: "not read" };
  const busy = snapshot.filesystem.scanning || snapshot.filesystem.importing;
  return {
    busy,
    label: busy
      ? `${Math.round(snapshot.filesystem.progress * 100)}%`
      : `${snapshot.filesystem.indexedFiles} indexed`,
  };
}

export function buildSceneQuestion(scene?: GodotSceneSummary): string {
  const target = scene?.path ?? "the active scene";
  return `Inspect ${target}. If it is not active, open it with godot_open_scene first, then use godot_get_scene_tree and godot_find_dependencies. Explain its important node branches, attached scripts, and resource dependencies, and flag any unsaved or fragile structure. Do not edit or save the project.`;
}
