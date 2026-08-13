import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { appendAction } from "./actionLog.js";
import { resolveProjectPath } from "./projectPath.js";
import { withProjectWriteLock } from "./writeLock.js";

export interface Snapshot {
  id: string;
  createdAt: number;
  rootDir: string;
  files: string[];
  absent: string[];
}

interface SnapshotManifest {
  id: string;
  createdAt: number;
  files: string[];
  absent: string[];
}

export async function createSnapshot(projectPath: string, files: string[]): Promise<Snapshot> {
  const { id, root } = await createExclusiveSnapshotRoot(projectPath);
  try {
    const stored: string[] = [];
    const absent: string[] = [];
    for (const requested of files) {
      const source = await resolveProjectPath(projectPath, requested);
      try {
        const contents = await fs.readFile(source.absolute);
        const destination = await resolveProjectPath(root, source.relative);
        await fs.mkdir(path.dirname(destination.absolute), { recursive: true });
        await fs.writeFile(destination.absolute, contents);
        stored.push(source.relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        absent.push(source.relative);
      }
    }

    const manifest: SnapshotManifest = {
      id,
      createdAt: Date.now(),
      files: stored,
      absent,
    };
    await writeManifestAtomically(root, manifest);
    return { id, createdAt: manifest.createdAt, rootDir: root, files: stored, absent };
  } catch (error) {
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch {
      // Preserve the snapshot error that blocked the write.
    }
    throw error;
  }
}

export async function listSnapshots(projectPath: string): Promise<Snapshot[]> {
  try {
    const location = await resolveProjectPath(projectPath, ".godot-vibe/snapshots");
    const entries = await fs.readdir(location.absolute, { withFileTypes: true });
    const out: Snapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const root = (await resolveProjectPath(projectPath, `.godot-vibe/snapshots/${entry.name}`)).absolute;
        const manifest = parseManifest(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
        out.push({
          id: manifest.id,
          createdAt: manifest.createdAt,
          rootDir: root,
          files: manifest.files,
          absent: manifest.absent,
        });
      } catch {
        // A malformed, incomplete, or escaped snapshot directory is not restorable.
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export interface SnapshotRestoreResult {
  restored: string[];
  removed: string[];
  undoSnapshotId: string;
}

export async function restoreSnapshot(projectPath: string, id: string): Promise<SnapshotRestoreResult> {
  return withProjectWriteLock(projectPath, () => restoreSnapshotLocked(projectPath, id));
}

async function restoreSnapshotLocked(projectPath: string, id: string): Promise<SnapshotRestoreResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid snapshot id.");
  const root = (await resolveProjectPath(projectPath, `.godot-vibe/snapshots/${id}`)).absolute;
  const manifest = parseManifest(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.id !== id) throw new Error("Snapshot manifest id does not match its directory.");

  const entries = [...manifest.files, ...manifest.absent];
  if (entries.length === 0) throw new Error("Snapshot contains no recoverable paths.");
  const normalizedEntries = new Set<string>();
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (
      entry.startsWith("res://") ||
      path.isAbsolute(entry) ||
      path.normalize(entry) !== entry ||
      normalized === ".godot-vibe" ||
      normalized.startsWith(".godot-vibe/") ||
      normalized === ".godot" ||
      normalized.startsWith(".godot/") ||
      normalized === ".git" ||
      normalized.startsWith(".git/")
    ) {
      throw new Error(`Snapshot manifest contains an invalid project path: ${entry}`);
    }
    const resolved = await resolveProjectPath(projectPath, entry, { followFinalSymlink: false });
    if (normalizedEntries.has(resolved.relative)) {
      throw new Error(`Snapshot manifest contains duplicate paths: ${entry}`);
    }
    normalizedEntries.add(resolved.relative);
  }

  const writes: Array<{ relative: string; destination: string; contents: Buffer; mode: number }> = [];
  const removals: Array<{ relative: string; destination: string; exists: boolean }> = [];

  for (const relative of manifest.files) {
    const source = await resolveProjectPath(root, relative);
    const sourceStat = await fs.lstat(source.absolute);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Snapshot source is not a regular file: ${relative}`);
    }
    const destination = await resolveProjectPath(projectPath, relative, { followFinalSymlink: false });
    const destinationStat = await lstatIfPresent(destination.absolute);
    if (destinationStat?.isSymbolicLink() || (destinationStat && !destinationStat.isFile())) {
      throw new Error(`Snapshot destination is not a regular file path: ${relative}`);
    }
    writes.push({
      relative,
      destination: destination.absolute,
      contents: await fs.readFile(source.absolute),
      mode: destinationStat ? destinationStat.mode & 0o777 : 0o644,
    });
  }
  for (const relative of manifest.absent) {
    const destination = await resolveProjectPath(projectPath, relative, { followFinalSymlink: false });
    const destinationStat = await lstatIfPresent(destination.absolute);
    if (destinationStat?.isSymbolicLink() || (destinationStat && !destinationStat.isFile())) {
      throw new Error(`Snapshot removal target is not a regular file path: ${relative}`);
    }
    removals.push({ relative, destination: destination.absolute, exists: destinationStat !== null });
  }

  const undo = await createSnapshot(projectPath, entries);
  try {
    for (const write of writes) {
      await publishFileAtomically(write.destination, write.contents, write.mode);
    }
    for (const removal of removals) {
      if (removal.exists) await fs.rm(removal.destination);
    }
  } catch (error) {
    throw new Error(
      `Snapshot restore failed; undo snapshot ${undo.id} preserves the pre-restore state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = {
    restored: writes.map(({ relative }) => relative),
    removed: removals.filter(({ exists }) => exists).map(({ relative }) => relative),
    undoSnapshotId: undo.id,
  };
  try {
    await appendAction(projectPath, {
      timestamp: Date.now(),
      tool: "gvibe_restore",
      args: { id },
      result: "ok",
      snapshotId: result.undoSnapshotId,
      notes: `restored ${id}`,
    });
  } catch {
    // The restore already succeeded; do not report a false failure for maintenance state.
  }
  return result;
}

async function createExclusiveSnapshotRoot(projectPath: string): Promise<{ id: string; root: string }> {
  const parent = (await resolveProjectPath(projectPath, ".godot-vibe/snapshots")).absolute;
  await fs.mkdir(parent, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    const timestamp = new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
    const id = `${timestamp}-${randomBytes(8).toString("hex")}`;
    const root = (await resolveProjectPath(projectPath, `.godot-vibe/snapshots/${id}`)).absolute;
    try {
      await fs.mkdir(root);
      return { id, root };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique snapshot directory.");
}

async function writeManifestAtomically(root: string, manifest: SnapshotManifest): Promise<void> {
  const temp = path.join(root, `.manifest.${randomBytes(8).toString("hex")}.tmp`);
  let ownsTemp = false;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    ownsTemp = true;
    try {
      await handle.writeFile(JSON.stringify(manifest, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, path.join(root, "manifest.json"));
    ownsTemp = false;
  } catch (error) {
    if (ownsTemp) {
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // Preserve the manifest publication error.
      }
    }
    throw error;
  }
}

function parseManifest(raw: string): SnapshotManifest {
  const value = JSON.parse(raw) as Partial<SnapshotManifest>;
  if (
    typeof value.id !== "string" ||
    typeof value.createdAt !== "number" ||
    !Array.isArray(value.files) ||
    !value.files.every((entry) => typeof entry === "string") ||
    (value.absent !== undefined &&
      (!Array.isArray(value.absent) || !value.absent.every((entry) => typeof entry === "string")))
  ) {
    throw new Error("Malformed snapshot manifest.");
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    files: value.files,
    absent: value.absent ?? [],
  };
}

async function lstatIfPresent(file: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function publishFileAtomically(destination: string, contents: Buffer, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let ownsTemp = false;
  try {
    const handle = await fs.open(temp, "wx", mode);
    ownsTemp = true;
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, destination);
    ownsTemp = false;
  } catch (error) {
    if (ownsTemp) {
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // Preserve the publication error.
      }
    }
    throw error;
  }
}
