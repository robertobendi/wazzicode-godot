import { promises as fs } from "node:fs";
import path from "node:path";

export interface ResolvedProjectPath {
  absolute: string;
  relative: string;
}

export async function resolveProjectPath(
  projectPath: string,
  requested: string,
  options: { followFinalSymlink?: boolean } = {}
): Promise<ResolvedProjectPath> {
  const relative = requested.startsWith("res://") ? requested.slice(6) : requested;
  if (path.isAbsolute(relative)) {
    throw new Error("Paths must be project-relative or use res://.");
  }

  const root = path.resolve(projectPath);
  const absolute = path.resolve(root, relative);
  if (absolute === root || !absolute.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the Godot project: ${requested}`);
  }

  const realRoot = await fs.realpath(root);
  let probe = options.followFinalSymlink === false ? path.dirname(absolute) : absolute;
  for (;;) {
    try {
      const realProbe = await fs.realpath(probe);
      if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
        throw new Error(`Path resolves outside the Godot project: ${requested}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }

  return { absolute, relative: path.relative(root, absolute) };
}
