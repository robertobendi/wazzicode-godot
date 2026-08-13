// Microphone → 16 kHz mono Float32 PCM, which is exactly what Whisper consumes.
//
// We deliberately do NOT use MediaRecorder: it produces compressed webm/opus,
// which we'd then have to decode (and no browser decoder gives you 16 kHz mono
// directly). Capturing raw PCM from an AudioContext pinned to 16 kHz skips the
// encode/decode round-trip and any ffmpeg-shaped dependency entirely.

import { MAX_SECONDS, SAMPLE_RATE } from "./config";

export interface Recording {
  /** Stop the mic and return everything captured, as 16 kHz mono PCM. */
  stop: () => Promise<Float32Array>;
  /** Abandon the take: stop the mic, keep nothing. */
  cancel: () => void;
}

export class MicUnavailableError extends Error {}

/**
 * Start capturing. Throws [`MicUnavailableError`] if there's no microphone or the
 * user/OS denied access — the caller turns that into a plain-language message.
 */
export async function startRecording(): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (e) {
    throw new MicUnavailableError(
      e instanceof Error ? e.message : "microphone unavailable",
    );
  }

  // Ask the browser to resample to Whisper's rate for us. Chromium honours this;
  // if a platform ever ignores it we resample below rather than transcribe
  // gibberish, since a wrong rate silently produces confident nonsense.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);

  // ScriptProcessorNode is deprecated in favour of AudioWorklet, but it needs no
  // separate module file (which a strict CSP makes awkward to load), and every
  // Chromium-based webview we ship on still supports it. The work per callback is
  // a single array copy, so the main-thread cost the deprecation warns about
  // doesn't bite here.
  const BUFFER = 4096;
  const node = ctx.createScriptProcessor(BUFFER, 1, 1);

  const chunks: Float32Array[] = [];
  let total = 0;
  const maxSamples = MAX_SECONDS * ctx.sampleRate;

  node.onaudioprocess = (e) => {
    if (total >= maxSamples) return;
    // The event buffer is reused by the engine — copy, don't retain.
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    total += input.length;
  };

  source.connect(node);
  // ScriptProcessor only fires while connected to a destination. Route it through
  // a muted gain node so nothing is played back to the user (otherwise they hear
  // themselves).
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);

  let stopped = false;
  const teardown = () => {
    if (stopped) return;
    stopped = true;
    node.onaudioprocess = null;
    source.disconnect();
    node.disconnect();
    mute.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void ctx.close();
  };

  return {
    async stop() {
      const rate = ctx.sampleRate;
      teardown();
      const pcm = concat(chunks, total);
      return rate === SAMPLE_RATE ? pcm : resample(pcm, rate, SAMPLE_RATE);
    },
    cancel: teardown,
  };
}

function concat(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Linear resample. Only a fallback — Chromium gives us 16 kHz directly. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

/** Rough loudness of the most recent audio, for a level meter. 0…1. */
export function rms(buf: Float32Array): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}
