export const PRODUCT_NAME = "Godot Vibe OS";
export const PRODUCT_VERSION = "0.2.0";
export const PROTOCOL_VERSION = "1.1";
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 38588;
export const DEFAULT_MCP_PORT = 38587;

/** Discovery written by the enabled editor addon. `.godot/` is per-machine state. */
export const BRIDGE_DISCOVERY_REL = ".godot/godot-vibe-os/bridge.json";

export interface BridgeDiscovery {
  port: number;
  host: string;
  projectPath: string;
  godotVersion: string;
  pid: number;
  protocolVersion: string;
  startedAt: number;
  token: string;
}

export interface BridgeHealth {
  status: string;
  godotVersion?: string;
  projectPath?: string;
  uptimeMs?: number;
  isPlaying?: boolean;
  filesystemScanning?: boolean;
}
