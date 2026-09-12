// Mirrors the Rust payloads in src-tauri/src/gitsync.rs (serde camelCase).

export interface SyncStep {
  id: string;
  ok: boolean;
  detail: string;
}

export interface SyncReport {
  ok: boolean;
  branch: string;
  upstream: string | null;
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  fastForward: boolean;
  steps: SyncStep[];
  summary: string;
}
