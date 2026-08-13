// Revert (studio checkpoint) domain types. Mirror the Rust structs in
// src-tauri/src/gitutil.rs and commands/revert.rs (serde camelCase).

/** A saved point the project can be rolled back to, taken before a chat turn. */
export interface Checkpoint {
  /** Short git sha to restore to. */
  sha: string;
  /** First line of the prompt that triggered the turn, for a label. */
  prompt: string;
  /** Unix milliseconds the checkpoint was taken. */
  at: number;
}

/** Result of `revert_last`. */
export interface RevertResult {
  ok: boolean;
  /** The short sha the project was restored to. */
  restoredTo: string;
}
