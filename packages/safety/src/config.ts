import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_BRIDGE_PORT, DEFAULT_MCP_PORT } from "@gvibe/core";
import { resolveProjectPath } from "./projectPath.js";

export const SafetyModeSchema = z.enum(["read_only", "suggest", "confirm", "autopilot"]);
export type SafetyMode = z.infer<typeof SafetyModeSchema>;

export const GVibeConfigSchema = z.object({
  safetyMode: SafetyModeSchema.default("autopilot"),
  allowSceneWrites: z.boolean().default(true),
  allowResourceWrites: z.boolean().default(true),
  allowScriptWrites: z.boolean().default(true),
  allowProjectSettingsWrites: z.boolean().default(false),
  allowEditorControl: z.boolean().default(true),
  autoSnapshot: z.boolean().default(true),
  godotProjectPath: z.string().default("."),
  mcpPort: z.number().int().default(DEFAULT_MCP_PORT),
  bridgePort: z.number().int().default(DEFAULT_BRIDGE_PORT),
  mockMode: z.boolean().default(false),
});

export type GVibeConfig = z.infer<typeof GVibeConfigSchema>;

export const DEFAULT_CONFIG: GVibeConfig = GVibeConfigSchema.parse({});
export const FAIL_CLOSED_CONFIG: GVibeConfig = {
  ...DEFAULT_CONFIG,
  safetyMode: "read_only",
  allowSceneWrites: false,
  allowResourceWrites: false,
  allowScriptWrites: false,
  allowProjectSettingsWrites: false,
  allowEditorControl: false,
  mockMode: false,
};

export const CONFIG_PATH_REL = ".godot-vibe/config.json";

export async function loadConfig(projectPath: string): Promise<GVibeConfig> {
  try {
    const file = (await resolveProjectPath(projectPath, CONFIG_PATH_REL)).absolute;
    const raw = await fs.readFile(file, "utf8");
    const json = JSON.parse(raw);
    return GVibeConfigSchema.parse(json);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    return FAIL_CLOSED_CONFIG;
  }
}

export async function writeConfigIfMissing(projectPath: string): Promise<{ written: boolean; path: string }> {
  const file = (await resolveProjectPath(projectPath, CONFIG_PATH_REL)).absolute;
  try {
    await fs.access(file);
    return { written: false, path: file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    return { written: true, path: file };
  }
}

export async function writeConfig(projectPath: string, config: GVibeConfig): Promise<string> {
  const file = (await resolveProjectPath(projectPath, CONFIG_PATH_REL)).absolute;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return file;
}
