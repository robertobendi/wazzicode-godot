import { describe, expect, it } from "vitest";
import type { AgentModelOption } from "@/types/agent";
import {
  CLAUDE_DEFAULT_EFFORTS,
  customModelRunOptions,
  effortsForModel,
  repairRunOptions,
  runOptionsSummary,
  strongestEffort,
} from "./modelCatalog";

const catalog: AgentModelOption[] = [
  {
    id: "gpt-a",
    label: "GPT A",
    description: null,
    defaultEffort: "medium",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gpt-b",
    label: "GPT B",
    description: null,
    defaultEffort: "high",
    efforts: ["high", "xhigh", "max"],
  },
];

const claudeCatalog: AgentModelOption[] = [
  {
    id: "opus",
    label: "Opus (latest)",
    description: null,
    defaultEffort: null,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "sonnet",
    label: "Sonnet",
    description: null,
    defaultEffort: null,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "fable",
    label: "Fable (latest)",
    description: null,
    defaultEffort: null,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "haiku",
    label: "Haiku",
    description: null,
    defaultEffort: null,
    efforts: [],
  },
];

describe("model catalog controls", () => {
  it("uses the exact Codex effort list for the selected model", () => {
    expect(effortsForModel("codex", catalog, "gpt-b")).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortsForModel("codex", catalog, null)).toEqual([]);
    expect(effortsForModel("codex", catalog, "custom-model")).toEqual([]);
  });

  it("uses only the verified Claude efforts for the selected model", () => {
    expect(effortsForModel("claude", claudeCatalog, null)).toEqual(
      CLAUDE_DEFAULT_EFFORTS,
    );
    expect(effortsForModel("claude", claudeCatalog, "opus")).toContain(
      "xhigh",
    );
    expect(effortsForModel("claude", claudeCatalog, "sonnet")).toContain(
      "xhigh",
    );
    expect(effortsForModel("claude", claudeCatalog, "fable")).toContain(
      "xhigh",
    );
    expect(effortsForModel("claude", claudeCatalog, "haiku")).toEqual([]);
    expect(effortsForModel("claude", claudeCatalog, "custom-model")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("uses the strongest supported effort when a listed model needs repair", () => {
    expect(
      repairRunOptions(
        { backend: "codex", model: " gpt-a ", effort: "xhigh" },
        catalog,
      ),
    ).toEqual({ backend: "codex", model: "gpt-a", effort: "high" });
    expect(
      repairRunOptions(
        { backend: "codex", model: "gpt-b", effort: null },
        catalog,
      ),
    ).toEqual({ backend: "codex", model: "gpt-b", effort: "max" });
    expect(
      repairRunOptions(
        { backend: "claude", model: "haiku", effort: "xhigh" },
        claudeCatalog,
      ),
    ).toEqual({ backend: "claude", model: "haiku", effort: null });
    expect(
      repairRunOptions(
        { backend: "claude", model: "claude-opus-future", effort: "xhigh" },
        claudeCatalog,
      ),
    ).toEqual({
      backend: "claude",
      model: "claude-opus-future",
      effort: "xhigh",
    });
  });

  it("preserves an explicitly selected lower supported effort", () => {
    expect(
      repairRunOptions(
        { backend: "codex", model: "gpt-b", effort: "high" },
        catalog,
      ),
    ).toEqual({ backend: "codex", model: "gpt-b", effort: "high" });
  });

  it("clears inherited thinking when entering an unverified custom model", () => {
    expect(
      customModelRunOptions(
        { backend: "claude", model: "fable", effort: "max" },
        " claude-haiku-future ",
      ),
    ).toEqual({
      backend: "claude",
      model: "claude-haiku-future",
      effort: null,
    });
    expect(
      customModelRunOptions(
        { backend: "codex", model: "gpt-a", effort: "high" },
        "",
      ),
    ).toEqual({ backend: "codex", model: null, effort: null });
  });

  it("ranks verified effort names independently of catalog order", () => {
    expect(strongestEffort(["max", "low", "ultra", "xhigh"])).toBe(
      "ultra",
    );
    expect(strongestEffort(["low", "medium", "xhigh"])).toBe("xhigh");
    expect(strongestEffort([])).toBeNull();
  });

  it("summarizes concrete defaults with friendly names", () => {
    expect(
      runOptionsSummary({ backend: "claude", model: null, effort: null }),
    ).toBe("CLI-selected model · CLI-selected thinking");
    expect(
      runOptionsSummary({ backend: "claude", model: "opus", effort: "max" }),
    ).toBe("Opus (latest) · Maximum");
    expect(
      runOptionsSummary({ backend: "claude", model: "fable", effort: "max" }),
    ).toBe("Fable (latest) · Maximum");
    expect(
      runOptionsSummary({
        backend: "codex",
        model: "gpt-5.6-sol",
        effort: "ultra",
      }),
    ).toBe("GPT-5.6-Sol · Ultra");
    expect(
      runOptionsSummary({ backend: "codex", model: "gpt-a", effort: "high" }),
    ).toBe("gpt-a · High");
  });
});
