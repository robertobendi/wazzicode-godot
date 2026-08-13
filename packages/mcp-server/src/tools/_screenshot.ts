import { promises as fs } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import {
  BridgeMethod,
  ErrorCode,
  ScreenshotResult,
  ToolEnvelope,
  err,
  isErrorCode,
  ok,
  timed,
} from "@uvibe/core";
import { BridgeClient } from "@uvibe/bridge-client";

export interface ScreenshotCallOptions {
  width?: number;
  height?: number;
  save?: boolean;
}

/**
 * Calls a screenshot bridge method, parses the result, optionally writes the image to
 * `.unity-vibe/screenshots/<ISO>.{png,jpg}`, and returns a typed envelope.
 */
export async function screenshotCall(
  bridge: BridgeClient,
  method: BridgeMethod,
  params: Record<string, unknown>,
  ctxProjectPath: string,
  opts: { save: boolean }
): Promise<ToolEnvelope<ScreenshotResult>> {
  const { result, durationMs } = await timed(() => bridge.call<ScreenshotResult>(method, params));
  if (!result.ok) {
    const code: ErrorCode = isErrorCode(result.error.code) ? result.error.code : "INTERNAL_ERROR";
    return err(code, result.error.message, {
      source: bridge.source,
      durationMs,
    }, result.error.details);
  }

  const mimeType = result.result.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
  const data: ScreenshotResult = {
    source: result.result.source,
    width: result.result.width,
    height: result.result.height,
    mimeType,
    pngBase64: result.result.pngBase64,
    cameraName: result.result.cameraName,
    subject: result.result.subject,
  };

  if (opts.save) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = path.join(ctxProjectPath, ".unity-vibe", "screenshots");
      await fs.mkdir(dir, { recursive: true });
      const ext = mimeType === "image/jpeg" ? "jpg" : "png";
      const file = path.join(dir, `${stamp}_${data.source}.${ext}`);
      await fs.writeFile(file, Buffer.from(data.pngBase64, "base64"));
      data.savedTo = file;
    } catch {
      // Saving is best-effort; never fail the tool because of it.
    }
  }

  return ok(data, {
    source: bridge.source,
    durationMs,
    unityVersion: result.meta?.unityVersion,
    projectPath: result.meta?.projectPath,
  });
}
