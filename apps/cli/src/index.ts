import { PRODUCT_NAME, PRODUCT_VERSION } from "@uvibe/core";
import { asGlobal, parseArgs, ParsedArgs, CommandResult } from "./options.js";
import { runInit } from "./commands/init.js";
import { runServe } from "./commands/serve.js";
import { runBrain } from "./commands/brain.js";
import { runDoctor } from "./commands/doctor.js";
import { runVerify } from "./commands/verify.js";
import { runMcpConfig } from "./commands/mcpConfig.js";
import { runGsdAuto } from "./commands/gsdAuto.js";
import { runInstallUnityPackage } from "./commands/installUnityPackage.js";
import { runSetup } from "./commands/setup.js";
import { runAutonomy } from "./commands/autonomy.js";

const HELP = `${PRODUCT_NAME} v${PRODUCT_VERSION}

Usage: uvibe <command> [--project=<path>] [--mock] [--json]

Commands:
  setup                      One-shot: init + install-unity-package + brain + write .mcp.json + doctor.
  init                       Create .unity-vibe/ scaffold plus Claude (CLAUDE.md) and Codex (AGENTS.md) guidance.
  serve                      Start the MCP server over stdio (use this in Claude Code MCP config).
  brain [--ensure]           Build the project map; --ensure reuses it when the source fingerprint is current.
  doctor                     Health check: MCP server, Unity bridge, brain, git, config.
  verify [--mock]            Run MVP acceptance checks against the mock bridge.
  mcp-config [--write]       Print or write .mcp.json. Use --write for the project-local file Claude Code auto-discovers.
                             --target=codex prints the [mcp_servers.*] TOML block (and the "codex mcp add" line) for the Codex CLI.
  install-unity-package      Install com.uvibe.os into a Unity project (--mode=copy|manifest|symlink; copy is default & portable).
  gsd-auto                   Detect GSD CLI / show internal planning workflow status.
  help                       Show this help.

Globals:
  --project=<path>    Unity project directory (default: $UVIBE_PROJECT or cwd).
  --mock              Use the in-memory mock bridge (no Unity Editor needed).
  --json              Emit JSON output where supported.
`;

export type CommandHandler = (g: ReturnType<typeof asGlobal>, parsed: ParsedArgs) => Promise<CommandResult>;

const COMMANDS: Record<string, CommandHandler> = {
  setup: runSetup,
  init: runInit,
  serve: runServe,
  brain: runBrain,
  doctor: runDoctor,
  verify: runVerify,
  "mcp-config": runMcpConfig,
  autonomy: runAutonomy,
  "install-unity-package": runInstallUnityPackage,
  "gsd-auto": runGsdAuto,
};

export async function dispatch(argv: string[]): Promise<CommandResult> {
  const parsed = parseArgs(argv);
  const g = asGlobal(parsed);
  if (parsed.command === "help" || parsed.flags.help === true) {
    return { exitCode: 0, stdout: HELP };
  }
  const handler = COMMANDS[parsed.command];
  if (!handler) {
    return { exitCode: 2, stderr: `unknown command: ${parsed.command}\n${HELP}` };
  }
  return handler(g, parsed);
}

export async function main(argv: string[]): Promise<void> {
  try {
    const r = await dispatch(argv);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exitCode);
  } catch (e: unknown) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(msg + "\n");
    process.exit(1);
  }
}

export {
  runSetup,
  runInit,
  runServe,
  runBrain,
  runDoctor,
  runVerify,
  runMcpConfig,
  runGsdAuto,
  runInstallUnityPackage,
  runAutonomy,
};
