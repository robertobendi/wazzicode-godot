import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types/chat";
import { collectGodotDiagnostics } from "./godotDiagnostics";

function message(result: unknown): ChatMessage {
  const raw = JSON.stringify({ ok: true, data: result });
  return {
    id: "message",
    role: "assistant",
    text: "",
    streaming: false,
    attachments: [],
    createdAt: 1,
    activities: [
      {
        id: "verify",
        toolUseId: "verify",
        name: "mcp__godot-vibe-os__godot_verify",
        friendlyLabel: "Verifying the Godot project",
        status: "ok",
        resultRaw: raw,
        resultText: raw,
        startedAt: 10,
        endedAt: 11,
      },
    ],
  };
}

describe("collectGodotDiagnostics", () => {
  it("parses verified import and GDScript checks without inventing tests", () => {
    const result = collectGodotDiagnostics([
      message({
        verdict: "pass",
        import: { ok: true, output: "imported" },
        scripts: { checked: 4, failed: 0, failures: [] },
        csharp: { status: "not_present", scripts: 0, projects: 0, message: "No C# files." },
        tests: { status: "not_configured", message: "No runner." },
      }),
    ]);
    expect(result?.verdict).toBe("pass");
    expect(result?.checks.map((check) => check.label)).toEqual([
      "Headless import",
      "GDScript syntax",
      "C#/.NET",
      "Project tests",
    ]);
    expect(result?.tests.status).toBe("not_configured");
  });

  it("does not present an unchecked C# project as passing", () => {
    const result = collectGodotDiagnostics([
      message({
        verdict: "unverified",
        import: { ok: true },
        scripts: { checked: 1, failed: 0, failures: [] },
        csharp: { status: "unverified", scripts: 1, projects: 1, message: "C#/.NET verification was not performed." },
      }),
    ]);
    expect(result?.verdict).toBe("unverified");
    expect(result?.checks.find((check) => check.id === "csharp")?.verdict).toBe("unverified");
  });

  it("surfaces script failures and asks only for another verification", () => {
    const result = collectGodotDiagnostics([
      message({
        verdict: "fail",
        import: { ok: true },
        scripts: {
          checked: 2,
          failed: 1,
          failures: [{ path: "res://player.gd", output: "Parse Error" }],
        },
      }),
    ]);
    expect(result?.verdict).toBe("fail");
    expect(result?.problems[0]).toMatchObject({ path: "res://player.gd" });
    expect(result?.fixPrompt).toContain("godot_verify");
  });

  it("does not turn malformed success envelopes into a passing verification", () => {
    const malformed = message({ verdict: "pass", import: {}, scripts: {} });
    expect(collectGodotDiagnostics([malformed])?.verdict).toBe("unknown");
  });
});
