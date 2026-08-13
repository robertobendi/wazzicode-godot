import { ensureBrainCurrent, generateBrain, type EnsureBrainCurrentResult } from "@gvibe/project-brain";
import type { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";
export async function runBrain(options: GlobalOptions, parsed: ParsedArgs): Promise<CommandResult> {
  try {
    const ensured = parsed.flags.ensure === true;
    const result = ensured
      ? await ensureBrainCurrent(options.project)
      : await generateBrain({ projectPath: options.project, write: true });
    const freshness = ensured ? result as EnsureBrainCurrentResult : undefined;
    const output = {
      project: options.project,
      generatedAt: result.brain.generatedAt,
      files: result.knowledgeBase.manifest.coverage.counts.files,
      entities: result.knowledgeBase.manifest.coverage.counts.entities,
      relations: result.knowledgeBase.manifest.coverage.counts.relations,
      complete: result.knowledgeBase.manifest.coverage.complete,
      written: result.written,
      ...(freshness ? { refreshed: freshness.refreshed, reason: freshness.reason } : {}),
    };
    return options.json
      ? { exitCode: 0, stdout: JSON.stringify(output, null, 2) + "\n" }
      : { exitCode: 0, stdout: `Godot project map: ${output.entities} entities, ${output.relations} relationships, ${output.files} files (${output.complete ? "complete" : "partial"})\n` };
  } catch (error) {
    return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
}
