import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { TestRunResult } from "@gvibe/core";
import { resolveProjectPath } from "@gvibe/safety";
import type { ToolDef } from "../registry.js";
import { err, ok } from "./_helpers.js";

const MAX_CAPTURED_BYTES = 96 * 1024;
const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = MAX_CAPTURED_BYTES - HEAD_BYTES;
const RUNNER_PATH = "res://tests/run_tests.gd";

const TestRunShape = {
  godotBinary: z.string().optional().describe("Godot executable; defaults to GODOT_BIN or godot."),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
};

export const godotTestRun: ToolDef<typeof TestRunShape, TestRunResult> = {
  name: "godot_test_run",
  description: "Runs a real project-owned GDScript test runner in a bounded headless Godot process and reports its observed exit result.",
  requires: ["filesystem"],
  inputShape: TestRunShape,
  async run(args, ctx) {
    try {
      const projectPath = await fs.realpath(path.resolve(ctx.projectPath));
      const runner = await resolveProjectPath(projectPath, RUNNER_PATH);
      const runnerStat = await fs.stat(runner.absolute);
      if (!runnerStat.isFile()) {
        return err("INVALID_ARGUMENT", "The project test runner must be a regular file.", {
          source: "filesystem",
          projectPath,
        });
      }

      const runnerPath = `res://${runner.relative.split(path.sep).join("/")}`;
      const binary = args.godotBinary ?? process.env.GODOT_BIN ?? "godot";
      const timeoutMs = args.timeoutMs ?? 120_000;
      const commandArgs = ["--headless", "--path", projectPath, "--script", runner.absolute];
      const startedAt = Date.now();
      const processResult = await runBounded(binary, commandArgs, projectPath, timeoutMs);
      const durationMs = Date.now() - startedAt;
      const verdict = processResult.timedOut
        ? "timeout" as const
        : processResult.exitCode === 0
          ? "pass" as const
          : "fail" as const;
      const result: TestRunResult = {
        verdict,
        runnerPath,
        command: `${binary} --headless --path <project> --script ${runnerPath}`,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        durationMs,
        output: processResult.output,
        outputBytes: processResult.outputBytes,
        outputTruncated: processResult.outputTruncated,
      };
      return ok(result, { source: "filesystem", durationMs, projectPath }, [
        ...(verdict === "fail" ? [`Project tests failed with exit code ${processResult.exitCode ?? "unknown"}.`] : []),
        ...(verdict === "timeout" ? [`Project tests exceeded the ${timeoutMs} ms timeout and were terminated.`] : []),
        ...(processResult.outputTruncated ? [`Test output was clipped after ${MAX_CAPTURED_BYTES} captured bytes.`] : []),
      ]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "RESOURCE_NOT_FOUND"
        : "INVALID_ARGUMENT";
      return err(code, error instanceof Error ? error.message : String(error), {
        source: "filesystem",
        projectPath: ctx.projectPath,
      });
    }
  },
};

interface BoundedProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
}

function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<BoundedProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string) => {
      let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (head.byteLength < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - head.byteLength, bytes.byteLength);
        head = Buffer.concat([head, bytes.subarray(0, take)]);
        bytes = bytes.subarray(take);
      }
      if (bytes.byteLength > 0) {
        tail = Buffer.concat([tail, bytes]);
        if (tail.byteLength > TAIL_BYTES) tail = tail.subarray(tail.byteLength - TAIL_BYTES);
      }
    };

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const storedBytes = head.byteLength + tail.byteLength;
      const outputTruncated = outputBytes > storedBytes;
      const omitted = outputBytes - storedBytes;
      const output = outputTruncated
        ? `${head.toString("utf8")}\n... ${omitted} output bytes omitted ...\n${tail.toString("utf8")}`
        : Buffer.concat([head, tail]).toString("utf8");
      resolve({ exitCode, signal, timedOut, output, outputBytes, outputTruncated });
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      append(error.message);
      finish(127, null);
    });
    child.once("close", (code, signal) => finish(code, signal));

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
  });
}
