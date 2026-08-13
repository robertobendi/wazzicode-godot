import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectWriteLockError, withProjectWriteLock } from "@gvibe/safety";

const CHILD_MODE = process.env.GVIBE_WRITE_LOCK_CHILD === "1";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (CHILD_MODE) return;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

if (CHILD_MODE) {
  describe("project write lock child", () => {
    it("increments the shared counter inside the filesystem lock", async () => {
      const project = requiredEnv("GVIBE_WRITE_LOCK_PROJECT");
      const childId = requiredEnv("GVIBE_WRITE_LOCK_CHILD_ID");
      const readyDir = path.join(project, "ready");
      await writeFile(path.join(readyDir, childId), "ready\n", { flag: "wx" });
      await waitForPeers(readyDir, 2, 5_000);

      await withProjectWriteLock(project, async () => {
        const counter = path.join(project, "counter.txt");
        const events = path.join(project, "events.txt");
        await appendFile(events, `start:${childId}\n`, "utf8");
        const before = Number(await readFile(counter, "utf8"));
        await delay(150);
        await writeFile(counter, String(before + 1), "utf8");
        await appendFile(events, `end:${childId}\n`, "utf8");
      }, {
        operation: `child-${childId}`,
        timeoutMs: 5_000,
        staleMs: 500,
        pollMs: 10,
      });
    });
  });
} else {
  describe("cross-process project write lock", () => {
    it("serializes two real Node processes for the same project", async () => {
      const project = await temporaryProject();
      await mkdir(path.join(project, "ready"));
      await writeFile(path.join(project, "counter.txt"), "0", "utf8");
      await writeFile(path.join(project, "events.txt"), "", "utf8");

      await Promise.all([runChild(project, "a"), runChild(project, "b")]);

      expect(await readFile(path.join(project, "counter.txt"), "utf8")).toBe("2");
      const events = (await readFile(path.join(project, "events.txt"), "utf8")).trim().split("\n");
      expect(events).toHaveLength(4);
      const first = events[0].slice("start:".length);
      const second = events[2].slice("start:".length);
      expect(events).toEqual([`start:${first}`, `end:${first}`, `start:${second}`, `end:${second}`]);
      expect(new Set([first, second])).toEqual(new Set(["a", "b"]));
      expect((await readdir(path.join(project, ".godot-vibe"))).some((entry) => entry.startsWith("write.lock"))).toBe(false);
    });

    it("recovers a same-host lock whose owner process exited", async () => {
      const project = await temporaryProject();
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      const deadPid = child.pid;
      expect(deadPid).toBeTypeOf("number");
      await once(child, "exit");
      await writeOwner(project, {
        pid: deadPid!,
        hostname: os.hostname(),
        createdAt: Date.now(),
        token: "dead-owner-token-0123456789abcdef",
        operation: "dead-write",
      });

      let ran = false;
      await withProjectWriteLock(project, async () => {
        ran = true;
      }, { timeoutMs: 500, staleMs: 100, pollMs: 5 });
      expect(ran).toBe(true);
      await expect(access(lockDirectory(project))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("recovers missing metadata only after its grace period", async () => {
      const project = await temporaryProject();
      const lock = lockDirectory(project);
      await mkdir(lock, { recursive: true });
      const old = new Date(Date.now() - 1_000);
      await utimes(lock, old, old);

      await withProjectWriteLock(project, async () => undefined, {
        timeoutMs: 500,
        staleMs: 100,
        pollMs: 5,
      });
      await expect(access(lock)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not reclaim corrupt metadata until its grace period expires", async () => {
      const project = await temporaryProject();
      const lock = lockDirectory(project);
      await mkdir(lock, { recursive: true });
      await writeFile(path.join(lock, "owner.json"), "{ broken", "utf8");

      await expect(withProjectWriteLock(project, async () => undefined, {
        timeoutMs: 40,
        staleMs: 200,
        pollMs: 5,
      })).rejects.toMatchObject<ProjectWriteLockError>({ kind: "timeout" });
      await access(lock);

      const old = new Date(Date.now() - 1_000);
      await utimes(lock, old, old);
      await withProjectWriteLock(project, async () => undefined, {
        timeoutMs: 500,
        staleMs: 200,
        pollMs: 5,
      });
      await expect(access(lock)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("never steals a live or foreign valid holder", async () => {
      for (const holder of [
        { pid: process.pid, hostname: os.hostname(), operation: "live-write" },
        { pid: 1, hostname: `${os.hostname()}-other`, operation: "foreign-write" },
      ]) {
        const project = await temporaryProject();
        const lock = await writeOwner(project, {
          ...holder,
          createdAt: Date.now() - 10_000,
          token: `valid-owner-token-${holder.operation}`,
        });
        const old = new Date(Date.now() - 10_000);
        await utimes(lock, old, old);

        await expect(withProjectWriteLock(project, async () => undefined, {
          timeoutMs: 60,
          staleMs: 100,
          pollMs: 5,
        })).rejects.toMatchObject<ProjectWriteLockError>({
          kind: "timeout",
          holder: expect.objectContaining({ operation: holder.operation }),
        });
        await access(lock);
      }
    });

    it("releases both filesystem and FIFO ownership after an operation fails", async () => {
      const project = await temporaryProject();
      await expect(withProjectWriteLock(project, async () => {
        throw new Error("operation failed");
      })).rejects.toThrow("operation failed");

      await expect(withProjectWriteLock(project, async () => "next")).resolves.toBe("next");
      await expect(access(lockDirectory(project))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("bounds time spent waiting in the in-process FIFO", async () => {
      const project = await temporaryProject();
      let releaseFirst = (): void => undefined;
      const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const first = withProjectWriteLock(project, () => firstCanFinish);
      await waitForFile(path.join(lockDirectory(project), "owner.json"), 1_000);

      await expect(withProjectWriteLock(project, async () => undefined, {
        timeoutMs: 40,
      })).rejects.toMatchObject<ProjectWriteLockError>({ kind: "timeout" });
      releaseFirst();
      await first;
      await expect(withProjectWriteLock(project, async () => "next")).resolves.toBe("next");
    });

    it("uses the canonical project identity for path aliases", async () => {
      if (process.platform === "win32") return;
      const project = await temporaryProject();
      const aliasParent = await temporaryProject();
      const alias = path.join(aliasParent, "project-alias");
      await symlink(project, alias, "dir");
      let running = 0;
      let maxRunning = 0;
      const operation = async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await delay(30);
        running--;
      };

      await Promise.all([
        withProjectWriteLock(project, operation),
        withProjectWriteLock(alias, operation),
      ]);
      expect(maxRunning).toBe(1);
    });
  });
}

async function temporaryProject(): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), "gvibe-write-lock-test-"));
  temporaryDirectories.push(project);
  return project;
}

function lockDirectory(project: string): string {
  return path.join(project, ".godot-vibe", "write.lock");
}

async function writeOwner(project: string, owner: Record<string, unknown>): Promise<string> {
  const lock = lockDirectory(project);
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
  return lock;
}

async function waitForPeers(directory: string, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await readdir(directory)).length < count) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the peer lock process.");
    await delay(10);
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}.`);
    await delay(5);
  }
}

function runChild(project: string, childId: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const vitestDirectory = path.dirname(require.resolve("vitest/package.json"));
  const vitestCli = path.join(vitestDirectory, "vitest.mjs");
  const testFile = path.resolve("tests/write-lock.test.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, "run", testFile], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: "1",
        GVIBE_WRITE_LOCK_CHILD: "1",
        GVIBE_WRITE_LOCK_PROJECT: project,
        GVIBE_WRITE_LOCK_CHILD_ID: childId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lock child ${childId} exited ${code}.\n${stdout}\n${stderr}`));
    });
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in child mode.`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
