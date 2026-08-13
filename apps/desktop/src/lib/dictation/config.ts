// Dictation: local, offline speech-to-text for the composer.
//
// Whisper runs *inside the app* (ONNX Runtime + WASM), not in the cloud:
//   - no API credits — the whole product is subscription/CLI-only on purpose;
//   - no per-OS native binary and no LLVM/cmake in the build (which is what
//     `whisper-rs` or a whisper.cpp sidecar would have cost us — and upstream
//     ships no prebuilt macOS CLI anyway);
//   - nothing leaves the machine, which matters when people dictate about
//     unreleased games.
//
// The model + runtime are vendored into `public/` by `scripts/fetch-whisper.mjs`
// and served from the app's own origin, so dictation also works offline and
// behind a firewall. If they're absent (a plain `tauri dev` with no bundle step),
// dictation reports itself unavailable rather than breaking the composer.

/** Keep in sync with MODEL_REPO in `scripts/fetch-whisper.mjs`. */
export const MODEL_ID = "onnx-community/whisper-tiny.en";

/** Where the vendored assets are served from (Vite `public/` → app origin root). */
export const MODEL_BASE = "/models/";
export const ORT_BASE = "/ort/";

/** A file that must exist if the model was vendored — used for the availability probe. */
export const MODEL_PROBE = `${MODEL_BASE}${MODEL_ID}/config.json`;

/** Whisper is trained on 16 kHz mono audio; anything else transcribes poorly. */
export const SAMPLE_RATE = 16_000;

/** Hard cap on a single dictation, so a forgotten open mic can't eat memory.
 *  Whisper itself only attends to 30s windows. */
export const MAX_SECONDS = 120;
