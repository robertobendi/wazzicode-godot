import { describe, expect, it } from "vitest";
import { screenshotErrorMessage } from "./errorMessages";

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
