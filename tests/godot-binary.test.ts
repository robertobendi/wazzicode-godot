import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGodotBinary } from "@gvibe/mcp-server";

/**
 * `"godot"` on PATH is the Linux assumption. On macOS and Windows people install the editor as an
 * app bundle / a folder of files, so every tool that shelled out to a bare `godot` failed with
 * ENOENT on a machine where Godot was plainly installed — including godot_verify, the call that
 * decides whether a change works.
 */

let dir: string;
let fake: string;
const originalPath = process.env.PATH;
const originalBin = process.env.GODOT_BIN;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gvibe-godot-bin-"));
  fake = path.join(dir, "godot");
  await fs.writeFile(fake, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(fake, 0o755);
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalBin === undefined) delete process.env.GODOT_BIN;
  else process.env.GODOT_BIN = originalBin;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("resolveGodotBinary", () => {
  it("uses an explicit absolute path that exists", () => {
    expect(resolveGodotBinary(fake)).toBe(fake);
  });

  it("resolves a bare name through PATH, the way a shell would", () => {
    process.env.PATH = dir;
    delete process.env.GODOT_BIN;
    expect(resolveGodotBinary("godot")).toBe(fake);
  });

  it("prefers GODOT_BIN over whatever is on PATH", async () => {
    const pinned = path.join(dir, "godot-pinned");
    await fs.writeFile(pinned, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(pinned, 0o755);
    process.env.PATH = dir;
    process.env.GODOT_BIN = pinned;
    expect(resolveGodotBinary()).toBe(pinned);
  });

  it("keeps looking when an explicit path does not exist, instead of failing on it", () => {
    process.env.PATH = dir;
    delete process.env.GODOT_BIN;
    // The point: a stale or guessed path must not strand a machine that does have Godot.
    expect(resolveGodotBinary("/nowhere/godot")).toBe(fake);
  });
});
