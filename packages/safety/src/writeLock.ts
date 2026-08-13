import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectPath } from "./projectPath.js";

const projectTails = new Map<string, Promise<void>>();

export const PROJECT_WRITE_LOCK_TIMEOUT_MS = 150_000;
export const PROJECT_WRITE_LOCK_STALE_MS = 30_000;
const PROJECT_WRITE_LOCK_POLL_MS = 40;

export interface ProjectWriteLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  operation?: string;
}

export interface ProjectWriteLockHolder {
  pid: number;
  hostname: string;
  createdAt: number;
  operation?: string;
}

interface ProjectWriteLockOwner extends ProjectWriteLockHolder {
  token: string;
}

export class ProjectWriteLockError extends Error {
  readonly kind: "timeout" | "unavailable";
  readonly holder?: ProjectWriteLockHolder;

  constructor(
    kind: "timeout" | "unavailable",
    message: string,
    holder?: ProjectWriteLockHolder,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectWriteLockError";
    this.kind = kind;
    this.holder = holder;
  }
}

export async function withProjectWriteLock<T>(
  projectPath: string,
  operation: () => Promise<T>,
  options: ProjectWriteLockOptions = {},
): Promise<T> {
  const timeoutMs = boundedDuration(options.timeoutMs, PROJECT_WRITE_LOCK_TIMEOUT_MS, 1, 15 * 60_000, "timeoutMs");
  const deadline = Date.now() + timeoutMs;
  const resolved = path.resolve(projectPath);
  let key: string;
  try {
    key = await fs.realpath(resolved);
  } catch {
    key = resolved;
  }

  const previous = projectTails.get(key) ?? Promise.resolve();
  let releaseQueue = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  projectTails.set(key, tail);

  let releaseFilesystem: (() => Promise<void>) | undefined;
  try {
    await waitForQueue(previous.catch(() => undefined), timeoutMs);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ProjectWriteLockError(
        "timeout",
        "Timed out waiting for another write in this Godot Vibe process to finish.",
      );
    }
    releaseFilesystem = await acquireFilesystemLock(key, { ...options, timeoutMs: remaining });
    return await operation();
  } finally {
    try {
      try {
        await releaseFilesystem?.();
      } catch (error) {
        throw new ProjectWriteLockError(
          "unavailable",
          `The project write finished, but its lock could not be released: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          error,
        );
      }
    } finally {
      releaseQueue();
      if (projectTails.get(key) === tail) projectTails.delete(key);
    }
  }
}

async function acquireFilesystemLock(
  projectPath: string,
  options: ProjectWriteLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = boundedDuration(options.timeoutMs, PROJECT_WRITE_LOCK_TIMEOUT_MS, 1, 15 * 60_000, "timeoutMs");
  const staleMs = boundedDuration(options.staleMs, PROJECT_WRITE_LOCK_STALE_MS, 100, 15 * 60_000, "staleMs");
  const pollMs = boundedDuration(options.pollMs, PROJECT_WRITE_LOCK_POLL_MS, 5, 1_000, "pollMs");
  let lockPath: string;
  let ownerPath: string;
  try {
    [lockPath, ownerPath] = await Promise.all([
      resolveProjectPath(projectPath, ".godot-vibe/write.lock").then(({ absolute }) => absolute),
      resolveProjectPath(projectPath, ".godot-vibe/write.lock/owner.json").then(({ absolute }) => absolute),
    ]);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    throw unavailable(projectPath, error);
  }

  const deadline = Date.now() + timeoutMs;
  const localHostname = os.hostname();
  const token = randomUUID();
  for (;;) {
    const owner: ProjectWriteLockOwner = {
      pid: process.pid,
      hostname: localHostname,
      createdAt: Date.now(),
      token,
      ...(options.operation ? { operation: options.operation.slice(0, 128) } : {}),
    };
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await writeOwner(ownerPath, owner);
      } catch (error) {
        await removeLockDirectory(lockPath);
        throw error;
      }
      const heartbeatMs = Math.max(50, Math.min(2_000, Math.floor(staleMs / 3)));
      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lockPath, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        const currentOwner = await readOwner(ownerPath);
        if (currentOwner?.token !== token) return;
        const releasedPath = `${lockPath}.released.${token}`;
        try {
          await fs.rename(lockPath, releasedPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        await removeLockDirectory(releasedPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw unavailable(projectPath, error);
      }
      try {
        if (await recoverStaleLock(lockPath, ownerPath, staleMs, localHostname)) continue;
      } catch (recoveryError) {
        throw unavailable(projectPath, recoveryError);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const holder = publicHolder(await readOwner(ownerPath));
        throw new ProjectWriteLockError(
          "timeout",
          holder?.operation
            ? `Timed out waiting for '${holder.operation}' to finish writing this project.`
            : "Timed out waiting for another Godot Vibe process to finish writing this project.",
          holder,
        );
      }
      await delay(Math.min(pollMs, remaining));
    }
  }
}

async function recoverStaleLock(
  lockPath: string,
  ownerPath: string,
  staleMs: number,
  localHostname: string,
): Promise<boolean> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  const owner = await readOwner(ownerPath);
  if (owner) {
    if (owner.hostname !== localHostname || processIsAlive(owner.pid)) return false;
  } else if (Date.now() - stat.mtimeMs <= staleMs) {
    return false;
  }

  const claim = await acquireReclaimClaim(lockPath, staleMs, localHostname);
  if (!claim) return false;
  const currentOwner = await readOwner(ownerPath);
  if (currentOwner && (currentOwner.hostname !== localHostname || processIsAlive(currentOwner.pid))) {
    await releaseOwnedFile(path.join(lockPath, "reclaim.json"), claim.token);
    return false;
  }

  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await fs.rename(lockPath, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "EEXIST";
  }
  await removeLockDirectory(stalePath);
  return true;
}

async function acquireReclaimClaim(
  lockPath: string,
  staleMs: number,
  localHostname: string,
): Promise<ProjectWriteLockOwner | null> {
  const claimPath = path.join(lockPath, "reclaim.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    const claim: ProjectWriteLockOwner = {
      pid: process.pid,
      hostname: localHostname,
      createdAt: Date.now(),
      token: randomUUID(),
      operation: "write-lock-recovery",
    };
    try {
      await writeOwner(claimPath, claim);
      return claim;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code !== "EEXIST") throw error;
    }

    const existing = await readOwner(claimPath);
    if (existing) {
      if (existing.hostname !== localHostname || processIsAlive(existing.pid)) return null;
    } else {
      let claimStat: import("node:fs").Stats;
      try {
        claimStat = await fs.stat(claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Date.now() - claimStat.mtimeMs <= staleMs) return null;
    }

    const retiredClaim = `${claimPath}.stale.${randomUUID()}`;
    try {
      await fs.rename(claimPath, retiredClaim);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") continue;
      throw error;
    }
    await fs.rm(retiredClaim, { force: true, maxRetries: 3, retryDelay: 50 });
  }
  return null;
}

async function releaseOwnedFile(file: string, token: string): Promise<void> {
  const owner = await readOwner(file);
  if (owner?.token !== token) return;
  const released = `${file}.released.${token}`;
  try {
    await fs.rename(file, released);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await fs.rm(released, { force: true, maxRetries: 3, retryDelay: 50 });
}

async function writeOwner(ownerPath: string, owner: ProjectWriteLockOwner): Promise<void> {
  const handle = await fs.open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOwner(ownerPath: string): Promise<ProjectWriteLockOwner | null> {
  try {
    const value = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Partial<ProjectWriteLockOwner>;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      typeof value.hostname !== "string" ||
      value.hostname.length === 0 ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      typeof value.token !== "string" ||
      value.token.length < 16 ||
      (value.operation !== undefined && typeof value.operation !== "string")
    ) {
      return null;
    }
    return {
      pid: value.pid,
      hostname: value.hostname,
      createdAt: value.createdAt,
      token: value.token,
      ...(value.operation ? { operation: value.operation } : {}),
    } as ProjectWriteLockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function publicHolder(owner: ProjectWriteLockOwner | null): ProjectWriteLockHolder | undefined {
  if (!owner) return undefined;
  return {
    pid: owner.pid,
    hostname: owner.hostname,
    createdAt: owner.createdAt,
    ...(owner.operation ? { operation: owner.operation } : {}),
  };
}

function unavailable(projectPath: string, cause: unknown): ProjectWriteLockError {
  if (cause instanceof ProjectWriteLockError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ProjectWriteLockError(
    "unavailable",
    `Could not acquire the project write lock for '${projectPath}': ${message}`,
    undefined,
    cause,
  );
}

async function removeLockDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || !Number.isInteger(result) || result < min || result > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForQueue(previous: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new ProjectWriteLockError(
        "timeout",
        "Timed out waiting for another write in this Godot Vibe process to finish.",
      ));
    }, timeoutMs);
    previous.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
