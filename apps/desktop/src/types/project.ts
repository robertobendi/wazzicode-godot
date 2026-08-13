// Mirrors the Rust `ProjectInfo` struct in
// src-tauri/src/commands/project.rs (serde camelCase).

export interface ProjectInfo {
  ok: boolean;
  name: string;
  path: string;
  unityVersion: string | null;
  hasAssets: boolean;
  hasProjectSettings: boolean;
  uvibeInitialized: boolean;
  /** `.unity-vibe/knowledge/manifest.json` exists. */
  brainReady: boolean;
  safetyMode: string | null;
}
