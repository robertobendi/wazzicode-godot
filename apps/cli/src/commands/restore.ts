import { listSnapshots, restoreSnapshot } from "@gvibe/safety";
import { markBrainDirty } from "@gvibe/project-brain";
import type { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";

export async function runRestore(
  options: GlobalOptions,
  parsed: ParsedArgs,
): Promise<CommandResult> {
  const id = parsed.positional[0];
  if (parsed.positional.length > 1) {
    return { exitCode: 2, stderr: "Usage: gvibe restore [snapshot-id]\n" };
  }

  if (!id) {
    const snapshots = await listSnapshots(options.project);
    const data = snapshots.map(({ id: snapshotId, createdAt, files, absent }) => ({
      id: snapshotId,
      createdAt,
      files,
      absent,
    }));
    if (options.json) {
      return { exitCode: 0, stdout: `${JSON.stringify({ snapshots: data }, null, 2)}\n` };
    }
    if (data.length === 0) return { exitCode: 0, stdout: "No snapshots found.\n" };
    return {
      exitCode: 0,
      stdout: data.map((snapshot) =>
        `${snapshot.id}  ${new Date(snapshot.createdAt).toISOString()}  ${snapshot.files.length + snapshot.absent.length} path(s)`
      ).join("\n") + "\n",
    };
  }

  try {
    const restored = await restoreSnapshot(options.project, id);
    let maintenanceWarning: string | undefined;
    try {
      await markBrainDirty(options.project, `gvibe_restore: ${id}`);
    } catch (error) {
      maintenanceWarning = `The restore succeeded, but the project map could not be marked stale: ${error instanceof Error ? error.message : String(error)}`;
    }
    const data = { id, ...restored };
    return options.json
      ? { exitCode: 0, stdout: `${JSON.stringify({ ...data, ...(maintenanceWarning ? { warning: maintenanceWarning } : {}) }, null, 2)}\n` }
      : {
          exitCode: 0,
          stdout: `Restored ${id}: ${restored.restored.length} file(s), removed ${restored.removed.length}; undo snapshot ${restored.undoSnapshotId}.\n`,
          ...(maintenanceWarning ? { stderr: `${maintenanceWarning}\n` } : {}),
        };
  } catch (error) {
    return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
}
