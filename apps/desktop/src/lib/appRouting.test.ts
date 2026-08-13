import { describe, expect, it } from "vitest";
import { authenticationBackend } from "./appRouting";

describe("app authentication routing", () => {
  it("keeps the project shell mounted during ordinary backend switches", () => {
    expect(authenticationBackend("claude", false)).toBeNull();
    expect(authenticationBackend("codex", false)).toBeNull();
  });

  it("opens only the explicitly requested backend authentication flow", () => {
    expect(authenticationBackend("claude", true)).toBe("claude");
    expect(authenticationBackend("codex", true)).toBe("codex");
  });
});
