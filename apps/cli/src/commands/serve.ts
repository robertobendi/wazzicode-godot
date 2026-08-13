import { startMcpServer } from "@uvibe/mcp-server";
import { CommandResult, GlobalOptions } from "../options.js";

export async function runServe(g: GlobalOptions): Promise<CommandResult> {
  // Stdio is grabbed by the MCP server. Anything printed to stdout would corrupt the JSON-RPC stream,
  // so log to stderr only.
  process.stderr.write(
    `Unity Vibe OS MCP server starting (project=${g.project}, mock=${g.mock})\n`
  );
  await startMcpServer({ mock: g.mock, projectPath: g.project });
  // The SDK's stdio transport keeps the event loop alive via its data listener.
  // Never resolve: the process exits when the parent client closes stdin or sends SIGTERM.
  return new Promise<CommandResult>((resolve) => {
    const stop = (code: number) => () => resolve({ exitCode: code });
    process.on("SIGINT", stop(0));
    process.on("SIGTERM", stop(0));
    process.stdin.on("end", stop(0));
    process.stdin.on("close", stop(0));
  });
}
