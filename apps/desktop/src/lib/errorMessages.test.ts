import { describe, expect, it } from "vitest";
import { screenshotErrorMessage } from "./errorMessages";

describe("screenshotErrorMessage", () => {
  it("turns verified Unity capture failures into actionable guidance", () => {
    expect(
      screenshotErrorMessage(
        "OBJECT_NOT_FOUND: No GameObject is selected. Select an object in the Hierarchy and retry.",
        "selected",
      ),
    ).toBe("Select a GameObject in Unity's Hierarchy, then try again.");
    expect(
      screenshotErrorMessage("OBJECT_NOT_FOUND: No suitable Camera found.", "game"),
    ).toBe("Add or enable a Camera in the active scene, then try again.");
    expect(
      screenshotErrorMessage(
        "OBJECT_NOT_FOUND: No SceneView is currently open in the editor.",
        "scene",
      ),
    ).toBe("Open Unity's Scene view, then try again.");
  });

  it("keeps shared bridge recovery messages", () => {
    expect(screenshotErrorMessage("UNITY_RELOADING", "game")).toContain(
      "recompiling",
    );
  });
});
