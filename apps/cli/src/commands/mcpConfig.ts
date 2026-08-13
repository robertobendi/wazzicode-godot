import { existsSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectPath } from "@gvibe/safety";
import type { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";
interface Entry { command: string; args: string[]; env: Record<string, string> }
export async function runMcpConfig(options: GlobalOptions, parsed: ParsedArgs): Promise<CommandResult> {
  const entry = buildEntry(path.resolve(options.project), options.mock, parsed.flags.bare === true);
  if (parsed.flags.target === "codex") return { exitCode: 0, stdout: codex(entry) };
  const config = { mcpServers: { "godot-vibe-os": entry } };
  if (parsed.flags.write !== true) return { exitCode: 0, stdout: JSON.stringify(config, null, 2) + "\n" };

  const displayFile = path.join(options.project, ".mcp.json");
  try {
    const file = (await resolveProjectPath(options.project, ".mcp.json")).absolute;
    const current = await readMcpConfig(file);
    current.mcpServers = { ...(current.mcpServers ?? {}), "godot-vibe-os": entry };
    await writeJsonAtomically(file, current);
    return { exitCode: 0, stdout: options.json ? JSON.stringify({ wrote: file, config: current }, null, 2) + "\n" : `Wrote ${file}\n` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stderr: `Refusing to update ${displayFile}: ${message}\n` };
  }
}

type McpConfig = Record<string, unknown> & { mcpServers?: Record<string, unknown> };

async function readMcpConfig(file: string): Promise<McpConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`existing file could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`existing file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("existing file must contain a JSON object");
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error("existing mcpServers value must be a JSON object");
  }
  return parsed as McpConfig;
}

async function writeJsonAtomically(file: string, value: McpConfig): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function buildEntry(project: string, mock: boolean, bare: boolean): Entry { const env: Record<string, string> = { GVIBE_PROJECT: project }; if (mock) env.GVIBE_MOCK = "1"; if (bare) return { command: "gvibe", args: ["serve"], env }; let dir = path.dirname(fileURLToPath(import.meta.url)); for (let i = 0; i < 12; i++) { const candidate = path.join(dir, "apps", "cli", "bin", "gvibe"); if (existsSync(candidate)) return { command: process.execPath, args: [candidate, "serve"], env }; const parent = path.dirname(dir); if (parent === dir) break; dir = parent; } return { command: "gvibe", args: ["serve"], env }; }
function codex(entry: Entry): string { return [`[mcp_servers.godot_vibe_os]`, `command = ${JSON.stringify(entry.command)}`, `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`, `startup_timeout_sec = 30`, `tool_timeout_sec = 300`, "", `[mcp_servers.godot_vibe_os.env]`, ...Object.entries(entry.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), ""].join("\n"); }
