// Fetch the local dictation assets into `public/` so the packaged app can
// transcribe speech OFFLINE, with no API credits and no per-OS native binary.
//
// Why bundled rather than downloaded at runtime:
//   - Employees may be behind a firewall, and the app shouldn't need
//     huggingface.co reachable just to use the mic.
//   - A Tauri webview is not a guaranteed "secure context", so the browser Cache
//     API that transformers.js would normally persist the model in may not
//     survive a restart — meaning a 40MB re-download on every launch.
//   - It keeps the app's CSP closed: no remote `connect-src` at all.
//
// Two things get vendored:
//   1. onnx-community/whisper-tiny.en — the quantized (q8) Whisper model.
//   2. onnxruntime-web's .wasm — the inference runtime, which transformers.js
//      otherwise pulls from a CDN.
//
// Both land in gitignored dirs, exactly like the Node sidecar. If they're
// missing the app still builds and runs; dictation just reports itself
// unavailable (see `useDictation.ts`), so a plain `tauri dev` needs no 40MB
// download to get going.
//
// Run: pnpm --filter @uvibe/desktop bundle:whisper

import { createRequire } from "node:module";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..");
const PUBLIC = path.join(DESKTOP, "public");

/** Keep in sync with MODEL_ID in `src/lib/dictation/config.ts`. */
const MODEL_REPO = "onnx-community/whisper-tiny.en";
const MODEL_DIR = path.join(PUBLIC, "models", MODEL_REPO);

// `dtype: "q8"` in transformers.js resolves to the `*_quantized.onnx` weights.
// Only the merged decoder is needed (it subsumes decoder_with_past).
const MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "vocab.json",
  "merges.txt",
  "normalizer.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

const ORT_DIR = path.join(PUBLIC, "ort");

async function main() {
  await fetchModel();
  await copyOnnxRuntime();
  console.log("\n✅ Dictation assets ready. `pnpm --filter @uvibe/desktop build` will bundle them.");
}

async function fetchModel() {
  console.log(`Fetching ${MODEL_REPO} → public/models/`);
  for (const file of MODEL_FILES) {
    const dest = path.join(MODEL_DIR, file);
    if (await exists(dest)) {
      console.log(`  · ${file} (cached)`);
      continue;
    }
    const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/${file}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`could not fetch ${file}: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    console.log(`  ✓ ${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
}

/**
 * transformers.js defaults `wasmPaths` to a CDN. Vendor the .wasm next to the
 * app instead and point at it (`config.ts`), so inference needs no network.
 */
async function copyOnnxRuntime() {
  console.log("\nVendoring onnxruntime-web wasm → public/ort/");
  const require = createRequire(import.meta.url);
  // onnxruntime-web is a *transitive* dep (of transformers.js), and pnpm doesn't
  // hoist those — so resolve it from transformers' own package root, not ours.
  const transformersEntry = require.resolve("@huggingface/transformers", {
    paths: [DESKTOP],
  });
  const transformersRoot = findPkgRoot(transformersEntry);
  const ortEntry = require.resolve("onnxruntime-web", {
    paths: [transformersRoot, DESKTOP],
  });
  const ortDist = path.join(findPkgRoot(ortEntry), "dist");

  // Copy ONLY the runtime variants the wasm backend actually loads. The dist dir
  // also ships asyncify/jspi/webgl/training builds — vendoring all of them adds
  // ~90MB to the installer for code that never executes.
  //
  // `.jsep.*` is the unified WebGPU+WASM build ORT loads by default; the plain
  // `ort-wasm-simd-threaded.*` is its non-jsep fallback. The paired `.mjs` is the
  // JS glue each `.wasm` needs, so they must travel together.
  const KEEP = new Set([
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
  ]);

  const names = (await fs.readdir(ortDist)).filter((f) => KEEP.has(f));
  const missing = [...KEEP].filter((k) => !names.includes(k));
  if (missing.length) {
    throw new Error(
      `onnxruntime-web changed its dist layout — missing ${missing.join(", ")} in ${ortDist}. ` +
        `Update KEEP in this script.`,
    );
  }

  await fs.rm(ORT_DIR, { recursive: true, force: true }); // drop any previous over-copy
  await fs.mkdir(ORT_DIR, { recursive: true });
  let bytes = 0;
  for (const name of names) {
    const src = path.join(ortDist, name);
    await fs.copyFile(src, path.join(ORT_DIR, name));
    bytes += (await fs.stat(src)).size;
  }
  console.log(`  ✓ ${names.length} files, ${(bytes / 1e6).toFixed(0)} MB`);
}

/** Walk up from a resolved entry point to the package root (the dir with package.json). */
function findPkgRoot(entry) {
  let dir = path.dirname(entry);
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find package root for ${entry}`);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
