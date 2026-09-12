import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { initialDraft, reduceStream } from "./streamMapper";

/**
 * Live contract test for the OpenCode pipeline: spawn the real CLI exactly the
 * way the app does (`opencode run --format json …`), then push its stdout
 * through the same reducer the webview uses. It is skipped when `opencode` isn't
 * installed, and it skips (rather than fails) when the provider can't be reached
 * — the stream *shape* is what's under test, not the model.
 */
function opencodeAvailable(): boolean {
  try {
    return spawnSync("opencode", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const AVAILABLE = opencodeAvailable();

describe.skipIf(!AVAILABLE)("opencode pipeline (live)", () => {
  it(
    "reduces a real `opencode run --format json` turn",
    (ctx) => {
      const result = spawnSync(
        "opencode",
        [
          "run",
          "--format",
          "json",
          "--pure",
          "-m",
          "opencode/big-pickle",
          "Reply with exactly: pipeline-ok",
        ],
        { encoding: "utf8", timeout: 120_000, env: { ...process.env } },
      );

      const lines = (result.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (result.status !== 0 || lines.length === 0) {
        ctx.skip();
        return;
      }

      let draft = initialDraft();
      for (const line of lines) {
        try {
          draft = reduceStream(draft, JSON.parse(line));
        } catch {
          // Non-JSON chatter is ignored by the real pipeline too.
        }
      }

      expect(draft.sessionId).toMatch(/^ses_/);
      expect(draft.text.toLowerCase()).toContain("pipeline-ok");
      // A step_finish line means the turn was priced / token-counted.
      expect(draft.cost !== undefined || draft.tokens !== undefined).toBe(true);
    },
    130_000,
  );
});
