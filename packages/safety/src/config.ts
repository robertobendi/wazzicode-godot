import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_BRIDGE_PORT, DEFAULT_MCP_PORT } from "@uvibe/core";

export const SafetyModeSchema = z.enum(["read_only", "suggest", "confirm", "autopilot"]);
export type SafetyMode = z.infer<typeof SafetyModeSchema>;

export const UVibeConfigSchema = z.object({
  // App-ready out of the box: Studio is responsible for checkpoints, Unity Undo, snapshots and
  // the action log, so the agent should never stop to ask a non-technical user for config changes.
  // The legacy CLI lock command remains available as an emergency escape hatch.
  safetyMode: SafetyModeSchema.default("autopilot"),
  allowSceneWrites: z.boolean().default(true),
  allowPrefabWrites: z.boolean().default(true),
  allowScriptWrites: z.boolean().default(true),
  /** Asset creation/import (materials, ScriptableObjects, sprites, generated C# files on disk). */
  allowAssetWrites: z.boolean().default(true),
  /** Generic Editor commands are available to app-managed agents. */
  allowMenuItems: z.boolean().default(true),
  /** In-Editor C# automation is available when no dedicated tool fits. */
  allowCodeExecution: z.boolean().default(true),
  /** Exact menu paths, or `*` for every path in an app-managed project. */
  allowedMenuItems: z.array(z.string()).default(["*"]),
  autoSnapshot: z.boolean().default(true),
  unityProjectPath: z.string().default("."),
  mcpPort: z.number().int().default(DEFAULT_MCP_PORT),
  bridgePort: z.number().int().default(DEFAULT_BRIDGE_PORT),
  mockMode: z.boolean().default(false),
});

export type UVibeConfig = z.infer<typeof UVibeConfigSchema>;

export const DEFAULT_CONFIG: UVibeConfig = UVibeConfigSchema.parse({});

export const CONFIG_PATH_REL = ".unity-vibe/config.json";

export async function loadConfig(projectPath: string): Promise<UVibeConfig> {
  const file = path.join(projectPath, CONFIG_PATH_REL);
  try {
    const raw = await fs.readFile(file, "utf8");
    const json = JSON.parse(raw);
    return UVibeConfigSchema.parse(json);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function writeConfigIfMissing(projectPath: string): Promise<{ written: boolean; path: string }> {
  const file = path.join(projectPath, CONFIG_PATH_REL);
  try {
    await fs.access(file);
    return { written: false, path: file };
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    return { written: true, path: file };
  }
}

export async function writeConfig(projectPath: string, config: UVibeConfig): Promise<string> {
  const file = path.join(projectPath, CONFIG_PATH_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return file;
}
