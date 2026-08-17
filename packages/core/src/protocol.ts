import { PROTOCOL_VERSION } from "./version.js";

export const BRIDGE_METHODS = {
  systemHealth: "system.health",
  systemSummary: "system.summary",
  sceneGetOpenScenes: "scene.getOpenScenes",
  sceneGetTree: "scene.getTree",
  selectionInspect: "selection.inspect",
  filesystemStatus: "filesystem.status",
  filesystemScan: "filesystem.scan",
  resourceGetDependencies: "resource.getDependencies",
  reflectQuery: "reflect.query",
  viewportCapture2D: "viewport.capture2D",
  viewportCapture3D: "viewport.capture3D",
  sceneOpen: "scene.open",
  sceneSave: "scene.save",
  editSetProperty: "edit.setProperty",
  editCreateNode: "edit.createNode",
  editDeleteNode: "edit.deleteNode",
  editReparentNode: "edit.reparentNode",
  editInstantiateScene: "edit.instantiateScene",
  playRun: "play.run",
  playStop: "play.stop",
  playStatus: "play.status",
  debugSnapshot: "debug.snapshot",
  debugCaptureFrames: "debug.captureFrames",
} as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS];
export type WriteTarget = "scene" | "resource" | "script" | "project_settings" | "editor";

export interface BridgeRequest<P = Record<string, unknown>> {
  id: string;
  version: string;
  method: BridgeMethod;
  params: P;
}

export interface BridgeResponseMeta {
  godotVersion: string;
  projectPath: string;
  durationMs: number;
}

export interface BridgeResponseOk<T = unknown> {
  id: string;
  ok: true;
  result: T;
  error: null;
  meta: BridgeResponseMeta;
}

export interface BridgeResponseErr {
  id: string;
  ok: false;
  result: null;
  error: { code: string; message: string; details?: Record<string, unknown> };
  meta: Partial<BridgeResponseMeta>;
}

export type BridgeResponse<T = unknown> = BridgeResponseOk<T> | BridgeResponseErr;

export function makeBridgeRequest<P extends Record<string, unknown>>(
  method: BridgeMethod,
  params?: P,
): BridgeRequest<P> {
  return {
    id: randomId(),
    version: PROTOCOL_VERSION,
    method,
    params: (params ?? ({} as P)) as P,
  };
}

function randomId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
