// Fetch the official Node.js LTS runtime for a target triple and extract ONLY
// the `node` binary into src-tauri/binaries/node-<target-triple>[.exe], the
// naming Tauri's `externalBin` expects. That binary is what launches the bundled
// uvibe.cjs MCP server on employees' machines (no Node install required).
//
// Usage:
//   node scripts/fetch-node-sidecar.mjs                     # host triple
//   node scripts/fetch-node-sidecar.mjs --target <triple>   # cross-fetch for CI
//
// Cached: an already-present binary is left as-is (delete it to re-fetch).

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// Pin a specific LTS so every app release ships an identical, audited runtime.
const NODE_VERSION = "20.18.1";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const binariesDir = path.join(desktopRoot, "src-tauri", "binaries");

// Map Rust target triples → Node dist platform slug + archive kind.
const TRIPLES = {
  "aarch64-apple-darwin": { slug: "darwin-arm64", kind: "tar" },
  "x86_64-apple-darwin": { slug: "darwin-x64", kind: "tar" },
  "x86_64-pc-windows-msvc": { slug: "win-x64", kind: "zip" },
  "x86_64-unknown-linux-gnu": { slug: "linux-x64", kind: "tar" },
};

function hostTriple() {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (p === "win32") return "x86_64-pc-windows-msvc";
  if (p === "linux") return "x86_64-unknown-linux-gnu";
  throw new Error(`unsupported host platform: ${p}/${a}`);
}

function parseTarget(argv) {
  const i = argv.indexOf("--target");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return hostTriple();
}

async function download(url, dest) {
  console.log(`[sidecar] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

async function main() {
  const target = parseTarget(process.argv.slice(2));
  const map = TRIPLES[target];
  if (!map) {
    throw new Error(
      `unknown target triple: ${target}\nknown: ${Object.keys(TRIPLES).join(", ")}`,
    );
  }
  const isWin = map.kind === "zip";
  const outName = isWin ? `node-${target}.exe` : `node-${target}`;
  const outPath = path.join(binariesDir, outName);

  mkdirSync(binariesDir, { recursive: true });
  if (existsSync(outPath)) {
    console.log(`[sidecar] cached: ${path.relative(desktopRoot, outPath)} (delete to re-fetch)`);
    return;
  }

  const base = `node-v${NODE_VERSION}-${map.slug}`;
  const ext = isWin ? "zip" : "tar.gz";
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${base}.${ext}`;

  const tmp = path.join(os.tmpdir(), `uvibe-node-${target}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const archive = path.join(tmp, `node.${ext}`);
  try {
    await download(url, archive);

    // copy+chmod rather than rename: the OS temp dir can live on a different
    // drive than the workspace (C: vs D: on GitHub's Windows runners), where
    // rename fails with EXDEV.
    if (isWin) {
      // Extract just node.exe (junk-paths, -j) from the archive.
      const inner = `${base}/node.exe`;
      execFileSync("unzip", ["-j", "-o", archive, inner, "-d", tmp], { stdio: "inherit" });
      copyFileSync(path.join(tmp, "node.exe"), outPath);
    } else {
      // Extract just <base>/bin/node from the gzip tarball.
      const inner = `${base}/bin/node`;
      execFileSync("tar", ["-xzf", archive, "-C", tmp, inner], { stdio: "inherit" });
      copyFileSync(path.join(tmp, base, "bin", "node"), outPath);
      chmodSync(outPath, 0o755);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`[sidecar] wrote ${path.relative(desktopRoot, outPath)}  (Node ${NODE_VERSION}, ${target})`);
}

main().catch((e) => {
  console.error(`[sidecar] ${e.message ?? e}`);
  process.exit(1);
});
