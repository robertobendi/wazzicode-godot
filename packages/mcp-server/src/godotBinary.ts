import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Find the Godot editor executable.
 *
 * `"godot"` on PATH is the Linux/package-manager assumption, and it is wrong for the way most
 * people install Godot on macOS and Windows: drag `Godot.app` to /Applications, or unzip
 * `Godot.exe` somewhere. Those users have Godot installed and every tool that shells out to it
 * still fails with ENOENT — including `godot_verify`, which is the call that decides whether their
 * change works.
 *
 * Order: an explicit argument, then `GODOT_BIN`, then PATH, then the standard install locations
 * for the platform. Returns `"godot"` as a last resort so the caller's error message is the
 * familiar "not found" rather than something invented.
 */

const PATH_NAMES = process.platform === "win32" ? ["godot.exe", "Godot.exe"] : ["godot", "godot4"];

function usable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fromPath(names: readonly string[] = PATH_NAMES): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

/** Where each platform's installer actually puts it. */
function wellKnown(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    // Inside an .app bundle the executable name varies by build (Godot, Godot_mono).
    const bundles = [
      "/Applications/Godot.app",
      "/Applications/Godot_mono.app",
      path.join(home, "Applications", "Godot.app"),
      path.join(home, "Applications", "Godot_mono.app"),
    ];
    return bundles.flatMap((bundle) =>
      ["Godot", "Godot_mono"].map((exe) => path.join(bundle, "Contents", "MacOS", exe))
    );
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return [
      path.join(programFiles, "Godot", "Godot.exe"),
      path.join(localAppData, "Programs", "Godot", "Godot.exe"),
    ];
  }
  return ["/usr/local/bin/godot", "/usr/bin/godot", path.join(home, ".local", "bin", "godot")];
}

export function resolveGodotBinary(explicit?: string): string {
  if (explicit) {
    if (path.isAbsolute(explicit)) {
      if (usable(explicit)) return explicit;
    } else {
      // A bare name ("godot") is a hint, not a location — resolve it like the shell would, then
      // keep looking. Our own tool descriptions used to suggest exactly this value, so treating
      // it as a hard requirement would strand every Mac that has Godot.app but no PATH shim.
      const named = fromPath([explicit]);
      if (named) return named;
    }
  }
  const fromEnv = process.env.GODOT_BIN;
  if (fromEnv && usable(fromEnv)) return fromEnv;
  const onPath = fromPath();
  if (onPath) return onPath;
  for (const candidate of wellKnown()) {
    if (usable(candidate)) return candidate;
  }
  // Nothing found: hand back what was asked for so the spawn error names it.
  return explicit ?? "godot";
}
