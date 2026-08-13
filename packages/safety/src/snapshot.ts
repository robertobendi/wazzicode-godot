import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Snapshot system. MVP scope:
 *  - createSnapshot copies a list of files into .unity-vibe/snapshots/<timestamp>/.
 *  - listSnapshots / restoreSnapshot are designed and partially implemented.
 *  - Write tools are not yet exposed; this module is exercised when they land.
 */

export interface Snapshot {
  id: string;
  createdAt: number;
  rootDir: string;
  files: string[];
}

export async function createSnapshot(projectPath: string, files: string[]): Promise<Snapshot> {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(projectPath, ".unity-vibe", "snapshots", id);
  await fs.mkdir(root, { recursive: true });
  const stored: string[] = [];
  for (const rel of files) {
    const src = path.join(projectPath, rel);
    try {
      const buf = await fs.readFile(src);
      const dst = path.join(root, rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.writeFile(dst, buf);
      stored.push(rel);
    } catch {
      // Skip files that don't yet exist; record absence in manifest.
    }
  }
  const manifest = {
    id,
    createdAt: Date.now(),
    files: stored,
  };
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { id, createdAt: manifest.createdAt, rootDir: root, files: stored };
}

export async function listSnapshots(projectPath: string): Promise<Snapshot[]> {
  const dir = path.join(projectPath, ".unity-vibe", "snapshots");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Snapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const m = JSON.parse(raw) as { id: string; createdAt: number; files: string[] };
        out.push({ id: m.id, createdAt: m.createdAt, rootDir: path.dirname(manifestPath), files: m.files });
      } catch {
        // ignore malformed snapshot dirs
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function restoreSnapshot(projectPath: string, id: string): Promise<{ restored: string[] }> {
  const root = path.join(projectPath, ".unity-vibe", "snapshots", id);
  const manifestPath = path.join(root, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const m = JSON.parse(raw) as { files: string[] };
  const restored: string[] = [];
  for (const rel of m.files) {
    const src = path.join(root, rel);
    const dst = path.join(projectPath, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    restored.push(rel);
  }
  return { restored };
}
