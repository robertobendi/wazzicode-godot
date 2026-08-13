import { z } from "zod";
import {
  brainQueryDefaultLimit,
  ensureBrainCurrent,
  queryBrain,
  readKnowledgeBase,
  type KnowledgeEntityKind,
} from "@uvibe/project-brain";
import {
  KNOWLEDGE_RELATION_QUERY_MAX_BYTES,
  projectBrainQuery,
  projectKnowledgeManifest,
} from "../knowledgeProjection.js";
import { ToolDef } from "../registry.js";
import { err, ok, timed } from "./_helpers.js";

const ENTITY_KINDS = [
  "project",
  "package",
  "scene",
  "prefab",
  "script",
  "type",
  "module",
] as const satisfies readonly KnowledgeEntityKind[];

const InputShape = {
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe("One focused project-specific question or search phrase, such as 'what handles saving?'."),
  kinds: z
    .array(z.enum(ENTITY_KINDS))
    .max(ENTITY_KINDS.length)
    .optional()
    .describe("Optional entity kinds to search. Omit to search the whole project map."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum primary matches (default 4; relation-set queries default 20; maximum 20)."),
};

interface ProjectBrainQueryOutput {
  result: ReturnType<typeof projectBrainQuery>;
  manifest: ReturnType<typeof projectKnowledgeManifest>;
}

export const unityQueryProjectBrain: ToolDef<
  typeof InputShape,
  ProjectBrainQueryOutput
> = {
  name: "unity_query_project_brain",
  description:
    "Queries the maintained per-project knowledge map for one focused architecture, ownership, script, type, scene, prefab, package, or dependency question. Reconciles freshness first, then returns a compact bounded result with the most relevant member evidence, graph neighbor, and exact source provenance. Ask separate questions for unrelated concerns. Does not require Unity to be running.",
  requires: ["filesystem", "project_brain"],
  inputShape: InputShape,
  async run(args, ctx) {
    try {
      const { result, durationMs } = await timed(async () => {
        const queryLimit = args.limit ?? brainQueryDefaultLimit(args.query);
        await ensureBrainCurrent(ctx.projectPath);
        const [queryResult, knowledge] = await Promise.all([
          queryBrain(ctx.projectPath, {
            query: args.query,
            kinds: args.kinds,
            limit: queryLimit,
          }),
          readKnowledgeBase(ctx.projectPath),
        ]);
        if (!knowledge) throw new Error("project map was not available after refresh");
        return {
          result: projectBrainQuery(queryResult, {
            knowledge,
            queryLimit,
            ...(brainQueryDefaultLimit(args.query) === 20
              ? { maxBytes: KNOWLEDGE_RELATION_QUERY_MAX_BYTES }
              : {}),
          }),
          manifest: projectKnowledgeManifest(knowledge.manifest),
        };
      });
      return ok(result, {
        source: "project_brain",
        durationMs,
        projectPath: ctx.projectPath,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return err("INTERNAL_ERROR", `Project-map query failed: ${message}`, {
        source: "project_brain",
        projectPath: ctx.projectPath,
      });
    }
  },
};
