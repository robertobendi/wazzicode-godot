export const PRODUCT_NAME = "Unity Vibe OS";
export const PRODUCT_VERSION = "0.5.2";
export const PROTOCOL_VERSION = "1.0";
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 38578;
export const DEFAULT_MCP_PORT = 38577;

/**
 * Discovery file written by the Unity bridge on start, relative to the project root.
 * Lives under Library/ (Unity-ignored, per-machine) so the MCP server can find the
 * actual bound port and verify project identity even when the port was auto-selected
 * (e.g. a second Unity Editor instance fell back to a different port).
 */
export const BRIDGE_DISCOVERY_REL = "Library/UnityVibeOS/bridge.json";

export interface BridgeDiscovery {
  port: number;
  host: string;
  projectPath: string;
  unityVersion: string;
  pid: number;
  protocolVersion: string;
  startedAt: number;
}

/**
 * Payload of the bridge's GET /health route. Served off Unity's main thread from mirrored
 * state, so it answers even when the editor loop is frozen — the liveness fields let clients
 * distinguish "Unity is stalled in the background" from "Unity is busy". The editor* fields
 * are absent on Unity packages older than the keep-awake driver.
 */
export interface BridgeHealth {
  status: string;
  unityVersion?: string;
  projectPath?: string;
  uptimeMs?: number;
  /** Milliseconds since the editor main loop last ticked. */
  editorTickAgeMs?: number;
  /** Whether the "Keep Unity awake (background)" driver is enabled. */
  keepAwakeEnabled?: boolean;
  /** Focus state as of the last editor tick (stale while the loop is frozen). */
  wasFocused?: boolean;
  isCompiling?: boolean;
  isPlaying?: boolean;
}

/**
 * The editor loop normally ticks many times per second (the keep-awake waker guarantees
 * ≤100ms latency); anything past this is a frozen loop, not a busy one.
 */
export const EDITOR_STALL_THRESHOLD_MS = 5_000;
