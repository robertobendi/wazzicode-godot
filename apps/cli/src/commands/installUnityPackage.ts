import { promises as fs, existsSync as fsExistsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";

const PACKAGE_NAME = "com.uvibe.os";

export async function runInstallUnityPackage(g: GlobalOptions, parsed: ParsedArgs): Promise<CommandResult> {
  // Default to an embedded copy: portable across machines (no absolute paths, no GitHub auth),
  // auto-discovered by Unity. "embed" is an alias of "copy". manifest/symlink remain available.
  const modeRaw = typeof parsed.flags.mode === "string" ? parsed.flags.mode : "copy";
  const mode = (modeRaw === "embed" ? "copy" : modeRaw) as "manifest" | "symlink" | "copy";

  // Prefer an explicit --source (how the desktop app points at its bundled copy,
  // which lives outside the monorepo tree); only auto-locate when it's absent.
  const explicitSource = typeof parsed.flags.source === "string" ? parsed.flags.source : null;
  const sourceArg = explicitSource ?? (await locateUnityPackageSource());
  if (!sourceArg) {
    return {
      exitCode: 1,
      stderr:
        "Could not locate unity/UnityVibeOS in this monorepo. Run from a checkout of the wazzicode-unity repo, or pass --source=<path>.\n",
    };
  }

  if (!(await dirExists(g.project))) {
    return { exitCode: 1, stderr: `project path does not exist: ${g.project}\n` };
  }
  const projectPackages = path.join(g.project, "Packages");
  if (!(await dirExists(projectPackages))) {
    return {
      exitCode: 1,
      stderr: `Not a Unity project (no Packages/ at ${g.project}). Pass --project=<unity-dir>.\n`,
    };
  }

  const lines: string[] = [];
  lines.push(`Source:  ${sourceArg}`);
  lines.push(`Target:  ${g.project}`);
  lines.push(`Mode:    ${mode}`);
  lines.push("");

  const manifestPath = path.join(projectPackages, "manifest.json");

  if (mode === "manifest") {
    if (!(await fileExists(manifestPath))) {
      return { exitCode: 1, stderr: `Packages/manifest.json missing at ${manifestPath}\n` };
    }
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { dependencies?: Record<string, string>; testables?: string[] };
    manifest.dependencies = manifest.dependencies ?? {};
    // Prefer a path RELATIVE to Packages/ so the entry resolves on any clone; fall back to an
    // absolute path only when the source lives on a different drive (then it is machine-specific).
    const [canonicalPackages, canonicalSource] = await Promise.all([
      fs.realpath(projectPackages),
      fs.realpath(sourceArg),
    ]);
    const rel = relativeFileUrl(canonicalPackages, canonicalSource);
    const ref = rel ?? pathToFileUrl(canonicalSource);
    manifest.dependencies[PACKAGE_NAME] = ref;
    manifest.testables = manifest.testables ?? [];
    if (!manifest.testables.includes(PACKAGE_NAME)) manifest.testables.push(PACKAGE_NAME);
    await fs.writeFile(manifestPath, formatJsonLike(raw, manifest), "utf8");
    lines.push(`Wrote ${manifestPath}`);
    lines.push(`  "${PACKAGE_NAME}": "${ref}"`);
    if (!rel) {
      lines.push("");
      lines.push("WARNING: emitted an ABSOLUTE path (source is on a different drive than the project).");
      lines.push("It will NOT resolve on other machines. For a shared/team project use the default");
      lines.push("--mode=copy, which embeds a portable copy under Packages/.");
    }
  } else if (mode === "symlink" || mode === "copy") {
    // Place the package under Packages/<name>, where Unity auto-discovers it as an embedded
    // package — no manifest entry, no absolute paths. Also strip any stale com.uvibe.os entry
    // (e.g. a prior absolute `file:` install) that would fail to resolve on a teammate's machine.
    const dest = path.join(projectPackages, PACKAGE_NAME);
    const removed = await removeManifestEntry(manifestPath, PACKAGE_NAME);
    if (await pathExists(dest)) await fs.rm(dest, { recursive: true, force: true });

    if (mode === "symlink") {
      await fs.symlink(sourceArg, dest, "dir");
      lines.push(`symlinked ${dest} → ${sourceArg}`);
      lines.push("(symlink targets this machine only; use --mode=copy for a shareable project.)");
    } else {
      await copyDir(sourceArg, dest);
      lines.push(`Embedded a portable copy at ${dest}`);
      lines.push(`  (copied from ${sourceArg}; commit Packages/${PACKAGE_NAME}/ with your project).`);
    }
    if (removed) {
      lines.push(`Removed stale manifest entry "${PACKAGE_NAME}": "${removed}".`);
      lines.push("  (That absolute path is why the package failed to resolve on other machines.)");
    }
  } else {
    return { exitCode: 2, stderr: `unknown --mode=${mode}. Use copy|manifest|symlink (copy is default).\n` };
  }

  lines.push("");
  lines.push("Next: open the Unity project. The bridge auto-starts at 127.0.0.1:38578.");
  lines.push("Verify with: uvibe doctor --project=" + g.project);

  if (g.json) {
    return { exitCode: 0, stdout: JSON.stringify({ source: sourceArg, target: g.project, mode }, null, 2) + "\n" };
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

function formatJsonLike(raw: string, value: unknown): string {
  const body = raw.replace(/\r?\n$/, "");
  const indent = raw.match(/\r?\n([ \t]+)"/)?.[1] ?? (body.includes("\n") ? 2 : undefined);
  const trailingNewline = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
  const formatted = JSON.stringify(value, null, indent);
  return (raw.includes("\r\n") ? formatted.replace(/\n/g, "\r\n") : formatted) + trailingNewline;
}

async function locateUnityPackageSource(): Promise<string | null> {
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "unity", "UnityVibeOS");
    if (fsExistsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
    else if (e.isSymbolicLink()) {
      const target = await fs.readlink(s);
      await fs.symlink(target, d);
    }
  }
}

function pathToFileUrl(absPath: string): string {
  // Absolute `file:` URL. Machine-specific — only used as a last resort (cross-drive); prefer
  // relativeFileUrl, or the default copy/embed which needs no path at all.
  return "file:" + absPath.split(path.sep).join("/");
}

/**
 * A `file:` URL relative to the project's Packages/ folder (how Unity resolves manifest file:
 * paths). Portable across clones. Returns null when no relative path exists (different drive).
 */
function relativeFileUrl(packagesDir: string, sourceAbs: string): string | null {
  const rel = path.relative(packagesDir, sourceAbs);
  if (!rel || path.isAbsolute(rel)) return null;
  return "file:" + rel.split(path.sep).join("/");
}

/**
 * Remove a dependency from Packages/manifest.json if present. Returns the old value (so the
 * caller can report it) or null. Used to clear a stale absolute-path entry before embedding.
 */
async function removeManifestEntry(manifestPath: string, name: string): Promise<string | null> {
  if (!(await fileExists(manifestPath))) return null;
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { dependencies?: Record<string, string> };
    if (manifest.dependencies && Object.prototype.hasOwnProperty.call(manifest.dependencies, name)) {
      const old = manifest.dependencies[name];
      delete manifest.dependencies[name];
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      return old;
    }
  } catch {
    // Leave a malformed manifest untouched; the embed still works (auto-discovery).
  }
  return null;
}
