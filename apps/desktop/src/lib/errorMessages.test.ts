import { describe, expect, it } from "vitest";
import { mapErrorMessage, screenshotErrorMessage } from "./errorMessages";

describe("mapErrorMessage", () => {
  it("names the CLI and the PATH trap when the binary can't be found", () => {
    for (const raw of [
      "spawn claude ENOENT",
      "No such file or directory (os error 2)",
      "program not found",
      "The system cannot find the path specified. (os error 3)",
    ]) {
      const msg = mapErrorMessage(raw, "claude");
      expect(msg).toContain("Claude Code CLI wasn't found");
      expect(msg).toContain("not visible to desktop apps");
    }
    expect(mapErrorMessage("spawn codex ENOENT", "codex")).toContain(
      "ChatGPT Codex CLI wasn't found",
    );
  });

  it("still reports an expired session as an auth problem", () => {
    expect(mapErrorMessage("401 Unauthorized", "claude")).toContain("Re-pair");
  });
});

describe("screenshotErrorMessage", () => {
  it("turns Godot capture failures into actionable guidance", () => {
    expect(screenshotErrorMessage("CAPTURE_UNAVAILABLE", "3d")).toBe(
      "Open the 3D workspace in the Godot editor, then try again.",
    );
  });

  it("keeps bridge recovery messages", () => {
    expect(screenshotErrorMessage("GODOT_RELOADING", "2d")).toContain(
      "restarting",
    );
  });
});
