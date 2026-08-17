import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { ScriptEditResult, ScriptFindResult, ScriptReadResult, ScriptShaResult, VerifyResult } from "@gvibe/core";
import { resolveProjectPath } from "@gvibe/safety";
import type { ToolDef } from "../registry.js";
import { reportProgress } from "../progress.js";
import { err, ok, timed } from "./_helpers.js";

const TEXT_EXTENSIONS = new Set([".gd", ".gdshader", ".tscn", ".tres", ".cfg", ".json", ".md", ".txt", ".cs"]);
const SCRIPT_EXTENSIONS = new Set([".gd", ".gdshader", ".cs"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const PathShape = { path: z.string().describe("Project path (res://... or project-relative).") };

export const godotReadScript: ToolDef<typeof PathShape & { startLine: z.ZodOptional<z.ZodNumber>; endLine: z.ZodOptional<z.ZodNumber> }, ScriptReadResult> = {
  name: "godot_read_script",
  description: "Reads a bounded Godot text resource and returns its sha256. Use the hash as an edit precondition.",
  requires: ["filesystem"],
  inputShape: { ...PathShape, startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() },
  async run(args, ctx) {
    try {
      const file = await resolveTextPath(ctx.projectPath, args.path);
      const raw = await fs.readFile(file);
      if (raw.byteLength > MAX_FILE_BYTES) return err("INVALID_ARGUMENT", `File exceeds ${MAX_FILE_BYTES} bytes.`, { source: "filesystem" });
      const contents = raw.toString("utf8");
      const lines = contents.split(/\r?\n/);
      const start = args.startLine ?? 1;
      const end = args.endLine ?? lines.length;
      return ok({ path: toResPath(ctx.projectPath, file), contents: lines.slice(start - 1, end).join("\n"), sha256: sha(raw), lineCount: lines.length, sizeBytes: raw.byteLength, truncated: start > 1 || end < lines.length }, { source: "filesystem", durationMs: 0, projectPath: ctx.projectPath });
    } catch (error) {
      return fileError(error, ctx.projectPath);
    }
  },
};

export const godotGetScriptSha: ToolDef<typeof PathShape, ScriptShaResult> = {
  name: "godot_get_script_sha",
  description: "Returns the current sha256, byte count, and line count without transferring file contents.",
  requires: ["filesystem"],
  inputShape: PathShape,
  async run(args, ctx) {
    try {
      const file = await resolveTextPath(ctx.projectPath, args.path);
      const raw = await fs.readFile(file);
      return ok({ path: toResPath(ctx.projectPath, file), exists: true, sha256: sha(raw), sizeBytes: raw.byteLength, lineCount: raw.toString("utf8").split(/\r?\n/).length }, { source: "filesystem", durationMs: 0, projectPath: ctx.projectPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok({ path: args.path, exists: false, sha256: "", sizeBytes: 0, lineCount: 0 }, { source: "filesystem", durationMs: 0 });
      return fileError(error, ctx.projectPath);
    }
  },
};

const FindShape = { ...PathShape, pattern: z.string(), ignoreCase: z.boolean().optional(), maxResults: z.number().int().min(1).max(500).optional() };
export const godotFindInFile: ToolDef<typeof FindShape, ScriptFindResult> = {
  name: "godot_find_in_file",
  description: "Regex-searches one Godot text resource and returns exact line/column matches.",
  requires: ["filesystem"],
  inputShape: FindShape,
  async run(args, ctx) {
    try {
      const file = await resolveTextPath(ctx.projectPath, args.path, SCRIPT_EXTENSIONS);
      const contents = await fs.readFile(file, "utf8");
      const regex = new RegExp(args.pattern, args.ignoreCase ? "giu" : "gu");
      const limit = args.maxResults ?? 100;
      const matches: ScriptFindResult["matches"] = [];
      const lines = contents.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        regex.lastIndex = 0;
        for (const match of lines[i].matchAll(regex)) {
          matches.push({ line: i + 1, column: (match.index ?? 0) + 1, match: match[0], lineText: lines[i] });
          if (matches.length >= limit) break;
          if (match[0].length === 0) break;
        }
      }
      return ok({ path: toResPath(ctx.projectPath, file), pattern: args.pattern, matchCount: matches.length, matches, truncated: matches.length >= limit }, { source: "filesystem", durationMs: 0 });
    } catch (error) {
      return fileError(error, ctx.projectPath);
    }
  },
};

const CreateShape = { ...PathShape, contents: z.string(), overwrite: z.boolean().optional(), preview: z.boolean().optional() };
export const godotCreateScript: ToolDef<typeof CreateShape, ScriptEditResult> = {
  name: "godot_create_script",
  description: "Creates a .gd, .gdshader, or .cs script. Preview is supported; existing files require overwrite:true.",
  requires: ["filesystem"],
  write: true,
  writeTarget: "script",
  inputShape: CreateShape,
  async run(args, ctx) {
    try {
      const file = await resolveTextPath(ctx.projectPath, args.path, SCRIPT_EXTENSIONS);
      let before: Buffer | null = null;
      try { before = await fs.readFile(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (before && !args.overwrite) return err("INVALID_ARGUMENT", "File exists; pass overwrite:true after reading it.", { source: "filesystem" });
      const next = Buffer.from(args.contents, "utf8");
      if (!args.preview) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const mode = before ? (await fs.stat(file)).mode : undefined;
        await atomicWriteFile(file, next, mode);
      }
      return ok({ applied: !args.preview, changed: !before || !before.equals(next), summary: `${args.preview ? "Previewed" : "Created"} ${toResPath(ctx.projectPath, file)}`, path: toResPath(ctx.projectPath, file), sha256Before: before ? sha(before) : undefined, sha256After: sha(next), createdPath: before ? undefined : toResPath(ctx.projectPath, file), undoable: false }, { source: "filesystem", durationMs: 0 });
    } catch (error) { return fileError(error, ctx.projectPath); }
  },
};

const RangeEdit = z.object({ startLine: z.number().int().min(1), startCol: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional(), endCol: z.number().int().min(1).optional(), newText: z.string() });
const EditShape = { ...PathShape, edits: z.array(RangeEdit).min(1).max(100), preconditionSha256: z.string().optional(), preview: z.boolean().optional() };
export const godotApplyTextEdits: ToolDef<typeof EditShape, ScriptEditResult> = {
  name: "godot_apply_text_edits",
  description: "Atomically applies disjoint 1-based line/column edits to a Godot text resource, guarded by an optional sha256 precondition.",
  requires: ["filesystem"],
  write: true,
  writeTarget: "script",
  inputShape: EditShape,
  async run(args, ctx) {
    try {
      const file = await resolveTextPath(ctx.projectPath, args.path, SCRIPT_EXTENSIONS);
      const before = await fs.readFile(file);
      const beforeSha = sha(before);
      if (args.preconditionSha256 && args.preconditionSha256 !== beforeSha) return err("UNSAVED_CHANGES", "File changed since it was read; refresh and rebase the edits.", { source: "filesystem" }, { expected: args.preconditionSha256, actual: beforeSha });
      const text = before.toString("utf8");
      const offsets = lineOffsets(text);
      const edits = args.edits.map((edit) => ({ start: pointOffset(text, offsets, edit.startLine, edit.startCol ?? 1), end: pointOffset(text, offsets, edit.endLine ?? edit.startLine, edit.endCol ?? edit.startCol ?? 1), newText: edit.newText })).sort((a, b) => b.start - a.start);
      for (let i = 0; i < edits.length; i++) {
        if (edits[i].end < edits[i].start || (i > 0 && edits[i].end > edits[i - 1].start)) throw new Error("Edit ranges overlap or are reversed.");
      }
      let next = text;
      for (const edit of edits) next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
      const changed = next !== text;
      if (changed && !args.preview) await atomicWriteFile(file, Buffer.from(next, "utf8"), (await fs.stat(file)).mode);
      return ok({ applied: !args.preview, changed, summary: `${args.preview ? "Previewed" : "Applied"} ${edits.length} edit(s) to ${toResPath(ctx.projectPath, file)}`, path: toResPath(ctx.projectPath, file), sha256Before: beforeSha, sha256After: sha(Buffer.from(next)), editCount: edits.length, undoable: false }, { source: "filesystem", durationMs: 0 });
    } catch (error) { return fileError(error, ctx.projectPath); }
  },
};

const VerifyShape = { godotBinary: z.string().optional().describe("Godot executable; defaults to godot."), timeoutMs: z.number().int().min(1_000).max(300_000).optional() };
export const godotVerify: ToolDef<typeof VerifyShape, VerifyResult> = {
  name: "godot_verify",
  description: "Runs a real headless Godot import gate, then --check-only on every project GDScript. It reports project tests and any C#/.NET compilation it did not perform as unverified.",
  requires: ["filesystem"],
  inputShape: VerifyShape,
  async run(args, ctx) {
    const binary = args.godotBinary ?? process.env.GODOT_BIN ?? "godot";
    const timeout = args.timeoutMs ?? 120_000;
    const projectPath = path.resolve(ctx.projectPath);
    const { result, durationMs } = await timed(async () => {
      reportProgress(ctx, 0, "Importing the project headlessly…");
      const imported = await run(binary, ["--headless", "--path", projectPath, "--import", "--quit"], projectPath, timeout);
      const scripts = await listFiles(projectPath, ".gd", { followSymbolicLinks: true });
      const csharpScripts = await listFiles(projectPath, ".cs", { followSymbolicLinks: true });
      const csharpProjects = await listFiles(projectPath, ".csproj", { followSymbolicLinks: true });
      const failures: Array<{ path: string; output: string }> = [];
      reportProgress(ctx, 1, `Import finished; checking ${scripts.length} GDScript file(s)…`, scripts.length + 1);
      for (const [index, script] of scripts.entries()) {
        const checked = await run(binary, ["--headless", "--path", projectPath, "--script", script, "--check-only"], projectPath, timeout);
        if (checked.exitCode !== 0) failures.push({ path: toResPath(projectPath, script), output: checked.output.slice(-8_000) });
        reportProgress(ctx, index + 2, `Checked script ${index + 1}/${scripts.length}`, scripts.length + 1);
      }
      const importOk = imported.exitCode === 0 && !/SCRIPT ERROR|Parse Error|ERROR:/i.test(imported.output);
      const warnings: string[] = [];
      const hasCsharp = csharpScripts.length > 0 || csharpProjects.length > 0;
      const csharpMessage = hasCsharp
        ? `C#/.NET verification was not performed: found ${csharpScripts.length} .cs file(s) and ${csharpProjects.length} .csproj file(s), but this run did not invoke a .NET-capable Godot build or the dotnet compiler.`
        : "No C# scripts or project files were found.";
      if (hasCsharp) warnings.push(csharpMessage);
      return {
        verdict: !importOk || failures.length > 0 ? "fail" as const : hasCsharp ? "unverified" as const : "pass" as const,
        import: { ok: importOk, command: `${binary} --headless --path <project> --import --quit`, exitCode: imported.exitCode, output: imported.output.slice(-12_000) },
        scripts: { checked: scripts.length, failed: failures.length, failures },
        csharp: { status: hasCsharp ? "unverified" as const : "not_present" as const, scripts: csharpScripts.length, projects: csharpProjects.length, message: csharpMessage },
        tests: { status: "not_configured" as const, message: "No project test runner was invoked. Import and --check-only validate resources and GDScript syntax; they are not unit tests." },
        warnings,
      };
    });
    return ok(result, { source: "filesystem", durationMs, projectPath }, [
      ...(result.verdict === "fail" ? ["Godot verification failed; inspect import and script failures."] : []),
      ...result.warnings,
    ]);
  },
};

async function atomicWriteFile(file: string, contents: Buffer, mode?: number): Promise<void> {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let ownsTemp = false;
  try {
    const handle = await fs.open(temp, "wx", mode ?? 0o666);
    ownsTemp = true;
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== undefined) await fs.chmod(temp, mode);
    await fs.rename(temp, file);
    ownsTemp = false;
  } catch (error) {
    if (ownsTemp) {
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // Preserve the original write error.
      }
    }
    throw error;
  }
}

async function resolveTextPath(projectPath: string, input: string, extensions = TEXT_EXTENSIONS): Promise<string> {
  const resolved = await resolveProjectPath(projectPath, input);
  if (!extensions.has(path.extname(resolved.absolute).toLowerCase())) throw new Error(`Unsupported text resource extension '${path.extname(resolved.absolute)}'.`);
  return resolved.absolute;
}
function toResPath(projectPath: string, file: string): string { return `res://${path.relative(path.resolve(projectPath), file).split(path.sep).join("/")}`; }
function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function lineOffsets(text: string): number[] { const out = [0]; for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1); return out; }
function pointOffset(text: string, offsets: number[], line: number, column: number): number { if (line < 1 || line > offsets.length) throw new Error(`Line ${line} is outside the file.`); const start = offsets[line - 1]; const end = line < offsets.length ? offsets[line] - 1 : text.length; const result = start + column - 1; if (result < start || result > end) throw new Error(`Column ${column} is outside line ${line}.`); return result; }
async function listFiles(root: string, extension: string, options: { followSymbolicLinks?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const realRoot = await fs.realpath(root);
  const insideRoot = (candidate: string) => candidate === realRoot || candidate.startsWith(realRoot + path.sep);
  async function walk(dir: string) {
    const real = await fs.realpath(dir);
    if (!insideRoot(real) || seen.has(real)) return;
    seen.add(real);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if ([".git", ".godot", ".godot-vibe", "node_modules"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isSymbolicLink() && options.followSymbolicLinks) {
        let realTarget: string;
        try {
          realTarget = await fs.realpath(full);
        } catch {
          continue;
        }
        if (!insideRoot(realTarget)) continue;
        const stat = await fs.stat(full);
        if (stat.isDirectory()) await walk(full);
        else if (stat.isFile() && path.extname(entry.name) === extension) out.push(full);
      } else if (entry.isFile() && path.extname(entry.name) === extension) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}
function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> { return new Promise((resolve) => { const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let output = ""; const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.on("data", (chunk) => { output += String(chunk); }); child.on("error", (error) => { clearTimeout(timer); resolve({ exitCode: 127, output: error.message }); }); child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output }); }); }); }
function fileError(error: unknown, projectPath: string) { const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "RESOURCE_NOT_FOUND" : "INVALID_ARGUMENT"; return err(code, error instanceof Error ? error.message : String(error), { source: "filesystem", projectPath }); }
