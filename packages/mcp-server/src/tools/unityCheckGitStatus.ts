import { z } from "zod";
import { ToolDef } from "../registry.js";
import { ok, err, timed } from "./_helpers.js";
import { execFile } from "node:child_process";

const InputShape = {
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export interface GitStatusResult {
  isGitRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  clean: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  files?: Array<{ path: string; status: string }>;
}

export const unityCheckGitStatus: ToolDef<typeof InputShape, GitStatusResult> = {
  name: "unity_check_git_status",
  description:
    "Reports whether the project directory is a git repository, current branch, ahead/behind upstream counts, and file change counts. Useful before any write tool to ensure changes are recoverable. Source: git.",
  requires: ["git", "filesystem"],
  inputShape: InputShape,
  async run(args, ctx) {
    const detailLevel = args.detailLevel ?? "normal";
    const { result, durationMs } = await timed(() => runGitStatus(ctx.projectPath));
    if (result.kind === "not_repo") {
      return ok(
        {
          isGitRepo: false,
          clean: true,
          staged: 0,
          unstaged: 0,
          untracked: 0,
        } satisfies GitStatusResult,
        { source: "git", durationMs, detailLevel },
        ["Project directory is not a git repository."]
      );
    }
    if (result.kind === "no_git") {
      return err("GIT_NOT_AVAILABLE", "git executable was not found.", {
        source: "git",
        durationMs,
        detailLevel,
      });
    }
    return ok(result.value, { source: "git", durationMs, detailLevel });
  },
};

type GitOutcome =
  | { kind: "ok"; value: GitStatusResult }
  | { kind: "not_repo" }
  | { kind: "no_git" };

function runGitStatus(cwd: string): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=all"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (e, stdout) => {
        if (e) {
          const errMsg = ((e as NodeJS.ErrnoException).code ?? "") + " " + (e.message ?? "");
          if (/ENOENT/.test(errMsg)) return resolve({ kind: "no_git" });
          if (/not a git repository/i.test(errMsg) || /not a git repository/i.test(stdout)) {
            return resolve({ kind: "not_repo" });
          }
          // Some git versions return non-zero with empty output for non-repo dirs.
          if (!stdout) return resolve({ kind: "not_repo" });
        }
        resolve({ kind: "ok", value: parsePorcelainV2(stdout) });
      }
    );
  });
}

function parsePorcelainV2(stdout: string): GitStatusResult {
  const result: GitStatusResult = {
    isGitRepo: true,
    clean: true,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    files: [],
  };
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      result.branch = line.substring("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      result.upstream = line.substring("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        result.ahead = Number(m[1]);
        result.behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // Tracked entry.
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const X = xy[0] ?? ".";
      const Y = xy[1] ?? ".";
      if (X !== ".") result.staged++;
      if (Y !== ".") result.unstaged++;
      const path = parts.slice(8).join(" ");
      result.files!.push({ path, status: xy });
    } else if (line.startsWith("? ")) {
      result.untracked++;
      result.files!.push({ path: line.slice(2), status: "??" });
    } else if (line.startsWith("u ")) {
      // Unmerged.
      result.unstaged++;
      const parts = line.split(" ");
      const path = parts.slice(10).join(" ");
      result.files!.push({ path, status: "U" });
    }
  }
  result.clean = result.staged === 0 && result.unstaged === 0 && result.untracked === 0;
  return result;
}
