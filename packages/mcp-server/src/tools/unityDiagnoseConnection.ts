import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  BRIDGE_DISCOVERY_REL,
  BRIDGE_METHODS,
  EDITOR_STALL_THRESHOLD_MS,
  PRODUCT_VERSION,
  PROTOCOL_VERSION,
  type BridgeDiscovery,
  type BridgeHealth,
  type BridgeResponse,
} from "@uvibe/core";
import { readBridgeDiscovery } from "@uvibe/bridge-client";
import { ToolDef } from "../registry.js";
import { ok } from "./_helpers.js";

const InputShape = {};

type ConnectionState =
  | "connected"
  | "editor_stalled"
  | "reloading"
  | "not_connected"
  | "identity_mismatch"
  | "protocol_mismatch";

interface PackageInfo {
  detected: boolean;
  path?: string;
  version?: string;
  manifestRef?: string;
  matchesServer?: boolean;
}

export interface ConnectionDiagnostic {
  state: ConnectionState;
  server: {
    version: string;
    protocolVersion: string;
    projectPath: string;
  };
  unityPackage: PackageInfo;
  discovery: BridgeDiscovery | null;
  health: BridgeHealth | null;
  rpc: {
    ok: boolean;
    error?: { code: string; message: string };
  };
  findings: string[];
  nextAction: string;
}

export const unityDiagnoseConnection: ToolDef<typeof InputShape, ConnectionDiagnostic> = {
  name: "unity_diagnose_connection",
  description:
    "Diagnoses the complete MCP-to-Unity connection in one read-only call: MCP and installed Unity-package versions, discovery file/port/PID/protocol, off-main-thread liveness, RPC reachability, editor stalls, and project identity. Returns a concrete state and next action even when Unity RPC is unavailable.",
  requires: ["unity_bridge", "filesystem"],
  inputShape: InputShape,
  async run(_args, ctx) {
    const [unityPackage, health, rpc] = await Promise.all([
      findUnityPackage(ctx.projectPath),
      ctx.bridge.health?.() ?? Promise.resolve(null),
      ctx.bridge.call(BRIDGE_METHODS.systemHealth),
    ]);
    const discovery = readBridgeDiscovery(ctx.projectPath);
    const findings: string[] = [];

    if (!unityPackage.detected) {
      findings.push("The UnityVibeOS package was not found in this project.");
    } else if (unityPackage.matchesServer === false) {
      findings.push(
        `The MCP server is ${PRODUCT_VERSION}, but the installed Unity package is ${unityPackage.version}.`
      );
    }

    if (!discovery) {
      findings.push(`No ${BRIDGE_DISCOVERY_REL} discovery file exists.`);
    } else if (
      discovery.protocolVersion &&
      discovery.protocolVersion !== PROTOCOL_VERSION
    ) {
      findings.push(
        `Bridge protocol ${discovery.protocolVersion} does not match MCP protocol ${PROTOCOL_VERSION}.`
      );
    }

    if (
      health?.projectPath &&
      !samePath(health.projectPath, ctx.projectPath)
    ) {
      findings.push(
        `The responding Unity Editor has '${health.projectPath}' open, not '${ctx.projectPath}'.`
      );
    }

    const stalled =
      typeof health?.editorTickAgeMs === "number" &&
      health.editorTickAgeMs > EDITOR_STALL_THRESHOLD_MS &&
      health.wasFocused === false;
    if (stalled) {
      findings.push(
        `Unity's editor loop has not ticked for ${Math.round(health.editorTickAgeMs! / 1000)}s while unfocused.`
      );
    } else if (health && health.editorTickAgeMs === undefined) {
      findings.push(
        "The Unity package does not expose editor-loop liveness; it predates background-stall diagnostics."
      );
    } else if (health?.keepAwakeEnabled === false) {
      findings.push("Keep Unity awake (background) is disabled.");
    }

    const state = diagnoseState(ctx.projectPath, discovery, health, rpc, stalled);
    const nextAction = actionFor(state, unityPackage, health);
    if (findings.length === 0) findings.push("Discovery, liveness, identity, and RPC checks passed.");

    return ok(
      {
        state,
        server: {
          version: PRODUCT_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          projectPath: ctx.projectPath,
        },
        unityPackage,
        discovery,
        health,
        rpc: rpc.ok
          ? { ok: true }
          : { ok: false, error: { code: rpc.error.code, message: rpc.error.message } },
        findings,
        nextAction,
      },
      { source: ctx.bridge.source, durationMs: 0 },
      unityPackage.matchesServer === false
        ? ["Update the embedded UnityVibeOS package so it matches this MCP server."]
        : []
    );
  },
};

function diagnoseState(
  projectPath: string,
  discovery: BridgeDiscovery | null,
  health: BridgeHealth | null,
  rpc: BridgeResponse,
  stalled: boolean
): ConnectionState {
  if (
    health?.projectPath &&
    !samePath(health.projectPath, projectPath)
  ) {
    return "identity_mismatch";
  }
  if (!rpc.ok && rpc.error.code === "PROJECT_IDENTITY_MISMATCH") {
    return "identity_mismatch";
  }
  if (
    discovery?.protocolVersion &&
    discovery.protocolVersion !== PROTOCOL_VERSION
  ) {
    return "protocol_mismatch";
  }
  if (stalled) return "editor_stalled";
  if (rpc.ok) return "connected";
  if (rpc.error.code === "UNITY_RELOADING" || health !== null) return "reloading";
  return "not_connected";
}

function actionFor(
  state: ConnectionState,
  unityPackage: PackageInfo,
  health: BridgeHealth | null
): string {
  if (!unityPackage.detected) {
    return "Install the UnityVibeOS package into this Unity project.";
  }
  if (unityPackage.matchesServer === false) {
    return "Reinstall the embedded UnityVibeOS package from this app/repository, then let Unity reload scripts.";
  }
  switch (state) {
    case "connected":
      return health?.keepAwakeEnabled === false
        ? "Enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background) before leaving Unity unfocused."
        : "No connection repair is needed.";
    case "editor_stalled":
      return "Focus the Unity window or enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background).";
    case "reloading":
      return "Wait for Unity's script reload to finish, then retry once.";
    case "identity_mismatch":
      return "Open this project in Unity, or point the MCP session at the project currently open in the responding Editor.";
    case "protocol_mismatch":
      return "Update the embedded UnityVibeOS package and MCP server together.";
    case "not_connected":
      return "Open this project in Unity and wait for the UnityVibeOS bridge to create its discovery file.";
  }
}

async function findUnityPackage(projectPath: string): Promise<PackageInfo> {
  const packagesDir = path.join(projectPath, "Packages");
  const manifestPath = path.join(packagesDir, "manifest.json");
  let manifestRef: string | undefined;
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    const value = manifest.dependencies?.["com.uvibe.os"];
    if (typeof value === "string") manifestRef = value;
  } catch {
    // A missing/malformed manifest is itself represented by the package not being found.
  }

  const candidates = [
    path.join(packagesDir, "com.uvibe.os"),
    path.join(projectPath, "Assets", "UnityVibeOS"),
    path.join(projectPath, "unity", "UnityVibeOS"),
  ];
  if (manifestRef?.startsWith("file:")) {
    try {
      const raw = decodeURIComponent(manifestRef.slice("file:".length));
      candidates.unshift(path.isAbsolute(raw) ? raw : path.resolve(packagesDir, raw));
    } catch {
      // Leave an invalid file reference visible in manifestRef without resolving it.
    }
  }

  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(candidate, "package.json"), "utf8")
      ) as { name?: unknown; version?: unknown };
      if (manifest.name !== "com.uvibe.os") continue;
      const version = typeof manifest.version === "string" ? manifest.version : undefined;
      return {
        detected: true,
        path: candidate,
        version,
        manifestRef,
        matchesServer: version === undefined ? undefined : version === PRODUCT_VERSION,
      };
    } catch {
      // Try the next supported install location.
    }
  }
  return { detected: Boolean(manifestRef), manifestRef };
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) =>
    path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}
