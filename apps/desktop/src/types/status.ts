// Mirrors the Rust `StatusUpdate` / `BridgeState` in src-tauri/src/bridge.rs.

export type BridgeState =
  | "disconnected"
  | "reloading"
  | "identity_mismatch"
  | "connected";

export interface StatusUpdate {
  state: BridgeState;
  compiling: boolean;
  playMode: boolean;
  friendly: string;
}
