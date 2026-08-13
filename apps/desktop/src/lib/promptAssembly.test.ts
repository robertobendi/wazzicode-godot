import { describe, expect, it } from "vitest";
import { assemblePrompt, instructionFor } from "./promptAssembly";
import type { Attachment, ResourceKind } from "@/types/chat";

function att(kind: ResourceKind, path: string): Attachment {
  return { id: `${kind}-${path}`, path, name: path, kind };
}

describe("instructionFor", () => {
  it("phrases each kind distinctly", () => {
    expect(instructionFor("image", "/p/a.png")).toContain("Look at the image");
    expect(instructionFor("image", "/p/a.png")).toContain("Read tool");
    expect(instructionFor("model", "/p/h.fbx")).toContain("unity_import_asset");
    expect(instructionFor("audio", "/p/s.wav")).toContain("unity_import_asset");
    expect(instructionFor("text", "/p/n.md")).toContain("for extra context");
    expect(instructionFor("other", "/p/x.bin")).toContain("/p/x.bin");
  });

  it("embeds the absolute path in quotes", () => {
    expect(instructionFor("image", "/abs/path.png")).toContain('"/abs/path.png"');
  });
});

describe("assemblePrompt", () => {
  it("passes through verbatim with no attachments", () => {
    expect(assemblePrompt("make the cube red", [])).toBe("make the cube red");
    expect(assemblePrompt("", [])).toBe("");
  });

  it("appends a single attachment under the divider", () => {
    const out = assemblePrompt("use this", [att("image", "/p/a.png")]);
    expect(out).toBe(
      'use this\n\n--- Attached resources ---\nLook at the image at "/p/a.png" (use your Read tool to view it).',
    );
  });

  it("lists multiple attachments of mixed kinds, one per line", () => {
    const out = assemblePrompt("build a level", [
      att("image", "/p/ref.png"),
      att("model", "/p/tree.fbx"),
      att("text", "/p/notes.md"),
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("build a level");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("--- Attached resources ---");
    expect(lines[3]).toContain('"/p/ref.png"');
    expect(lines[4]).toContain("unity_import_asset");
    expect(lines[4]).toContain('"/p/tree.fbx"');
    expect(lines[5]).toContain('"/p/notes.md"');
  });

  it("emits just the attachments section when text is empty", () => {
    const out = assemblePrompt("", [att("model", "/p/tree.fbx")]);
    expect(out.startsWith("--- Attached resources ---\n")).toBe(true);
    expect(out).toContain('"/p/tree.fbx"');
  });
});
