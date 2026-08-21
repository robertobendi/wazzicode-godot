import { PRODUCT_NAME, PRODUCT_VERSION } from "@gvibe/core";
import { asGlobal, parseArgs, type CommandResult, type ParsedArgs } from "./options.js";
import { runBrain } from "./commands/brain.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runInstallAddon } from "./commands/installAddon.js";
import { runLock, runUnlock } from "./commands/access.js";
import { runMcpConfig } from "./commands/mcpConfig.js";
import { runServe } from "./commands/serve.js";
import { runSetup } from "./commands/setup.js";
import { runUpdate } from "./commands/update.js";
import { runRestore } from "./commands/restore.js";

const HELP = `${PRODUCT_NAME} v${PRODUCT_VERSION}

Usage: gvibe <command> [--project=<path>] [--mock] [--json]

Commands:
  setup                       Init, install+enable addon, map project, write MCP config, diagnose.
  init                        Create .godot-vibe config/conventions and agent guidance.
  install-addon [--source]    Copy and enable addons/godot_vibe_os.
  brain [--ensure]            Build or reconcile the Godot-native project map.
  serve                       Start the MCP server over stdio.
  doctor                      Diagnose project, addon, bridge, map, and git state.
  mcp-config [--write]        Print/write Claude JSON; --target=codex prints TOML.
  lock | unlock               Disable or enable project writes.
  update [--dry-run]          Re-sync this project's install with the running build: refresh a
                              drifted addon copy, re-render the AGENTS.md/CLAUDE.md block, and
                              report a .mcp.json whose paths no longer resolve.
  restore [snapshot-id]       List or restore recoverable file snapshots.
  help                        Show this help.

Globals:
  --project=<path>   Godot project root (default: $GVIBE_PROJECT or cwd).
  --mock             Use deterministic mock editor state.
  --json             Emit structured output where supported.
`;
type Handler = (options: ReturnType<typeof asGlobal>, parsed: ParsedArgs) => Promise<CommandResult>;
const COMMANDS: Record<string, Handler> = { setup: runSetup, init: runInit, "install-addon": runInstallAddon, brain: runBrain, serve: runServe, doctor: runDoctor, "mcp-config": runMcpConfig, lock: runLock, unlock: runUnlock, restore: runRestore, update: runUpdate };
export async function dispatch(argv: string[]): Promise<CommandResult> { const parsed = parseArgs(argv); const options = asGlobal(parsed); if (parsed.command === "help" || parsed.flags.help === true) return { exitCode: 0, stdout: HELP }; const handler = COMMANDS[parsed.command]; return handler ? handler(options, parsed) : { exitCode: 2, stderr: `Unknown command: ${parsed.command}\n${HELP}` }; }
export async function main(argv: string[]): Promise<void> { try { const result = await dispatch(argv); if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); process.exit(result.exitCode); } catch (error) { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exit(1); } }
export { runBrain, runDoctor, runInit, runInstallAddon, runLock, runMcpConfig, runRestore, runServe, runSetup, runUnlock };
