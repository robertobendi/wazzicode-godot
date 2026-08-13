import { ensureBrainCurrent, generateBrain } from "@uvibe/project-brain";
import { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";

export async function runBrain(
  g: GlobalOptions,
  parsed?: ParsedArgs
): Promise<CommandResult> {
  const ensure = parsed?.flags.ensure === true || parsed?.flags.ensure === "true";
  const ensured = ensure ? await ensureBrainCurrent(g.project) : null;
  const result = ensured ?? await generateBrain({ projectPath: g.project, write: true });
  if (g.json) {
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" };
  }
  const lines: string[] = [];
  lines.push("Unity Vibe OS — brain");
  lines.push(`project: ${g.project}`);
  lines.push(`unity:   ${result.brain.engine.unityVersion ?? "(unknown)"}`);
  lines.push(`pipeline:${result.brain.engine.renderPipeline ?? "(unknown)"}  input:${result.brain.engine.inputSystem ?? "(unknown)"}`);
  lines.push(`scenes:  ${result.brain.assets.scenes.length}  prefabs:${result.brain.assets.prefabs.length}  scripts:${result.brain.assets.scripts.length}`);
  const { coverage } = result.knowledgeBase.manifest;
  lines.push(`map:     ${coverage.counts.entities} entities  ${coverage.counts.relations} relations`);
  lines.push(
    `coverage:${coverage.complete ? "complete" : coverage.truncated ? "truncated" : "incomplete"}  files:${coverage.scanned}/${coverage.discovered}  errors:${coverage.errors.length}`
  );
  if (ensured) {
    lines.push(`freshness:${ensured.reason}  refreshed:${ensured.refreshed ? "yes" : "no"}`);
  }
  lines.push("written:");
  for (const w of result.written) lines.push(`  - ${w}`);
  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}
