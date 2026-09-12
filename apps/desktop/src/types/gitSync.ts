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

/**
 * Cheap probe behind the Synchronize button's attention state. `actionNeeded`
 * is what turns the button rainbow; a repo with no remote is never action-needed.
 */
export interface SyncStatus {
  isRepo: boolean;
  branch: string;
  upstream: string | null;
  hasRemote: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  diverged: boolean;
  fetchOk: boolean;
  actionNeeded: boolean;
  summary: string;
}
