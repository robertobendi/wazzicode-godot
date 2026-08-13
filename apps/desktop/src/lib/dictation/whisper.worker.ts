/// <reference lib="webworker" />
//
// Whisper inference, off the main thread.
//
// Transcribing even a few seconds of speech pegs a core for ~1s; on the UI thread
// that would freeze the composer mid-keystroke. The worker also lets the model
// (~44MB) stay resident between dictations, so only the first one pays load cost.
//
// Everything is pinned to local assets — `allowRemoteModels: false` means a
// misconfiguration fails loudly here rather than silently phoning a CDN.

import { env, pipeline } from "@huggingface/transformers";
import { MODEL_BASE, MODEL_ID, ORT_BASE } from "./config";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODEL_BASE;

const wasmBackend = env.backends.onnx.wasm;
if (wasmBackend) {
  wasmBackend.wasmPaths = ORT_BASE;
  // Multi-threaded ORT needs SharedArrayBuffer, which needs cross-origin
  // isolation (COOP/COEP) that a Tauri webview doesn't provide. Ask for one
  // thread rather than let ORT fail over noisily.
  wasmBackend.numThreads = 1;
}

export type WorkerRequest =
  | { type: "warmup"; id: number }
  | { type: "transcribe"; id: number; pcm: Float32Array };

export type WorkerResponse =
  | { type: "ready"; id: number }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id: number; message: string };

type Asr = Awaited<ReturnType<typeof pipeline<"automatic-speech-recognition">>>;

let asrPromise: Promise<Asr> | null = null;

/** Load once, reuse for every later dictation. */
function load(): Promise<Asr> {
  if (!asrPromise) {
    asrPromise = pipeline("automatic-speech-recognition", MODEL_ID, {
      dtype: "q8",
      device: "wasm",
    });
  }
  return asrPromise;
}

function reply(msg: WorkerResponse) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "warmup") {
      await load();
      reply({ type: "ready", id: msg.id });
      return;
    }
    if (msg.type === "transcribe") {
      const asr = await load();
      // No `language`/`task` options: whisper-*.en is English-only and rejects
      // them outright.
      const out = (await asr(msg.pcm)) as { text?: string } | { text?: string }[];
      const text = Array.isArray(out) ? (out[0]?.text ?? "") : (out.text ?? "");
      reply({ type: "result", id: msg.id, text: text.trim() });
    }
  } catch (err) {
    reply({
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
