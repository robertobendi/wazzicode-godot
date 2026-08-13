// Mirrors the Rust `ProjectInfo` struct in
// src-tauri/src/commands/project.rs (serde camelCase).

export interface ProjectInfo {
  ok: boolean;
  name: string;
  path: string;
  godotVersion: string | null;
  hasProjectFile: boolean;
  addonInstalled: boolean;
  vibeInitialized: boolean;
  brainReady: boolean;
  safetyMode: string | null;
}
