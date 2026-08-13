import { ErrorCode, ErrorDetail, makeError } from "./errors.js";

export type DetailLevel = "summary" | "normal" | "full";
export type ToolSource = "unity_bridge" | "project_brain" | "filesystem" | "git" | "mock";

export interface ToolMeta {
  source: ToolSource;
  durationMs: number;
  detailLevel: DetailLevel;
  unityVersion?: string;
  projectPath?: string;
}

export interface ToolEnvelopeOk<T> {
  ok: true;
  data: T;
  warnings: string[];
  meta: ToolMeta;
}

export interface ToolEnvelopeErr {
  ok: false;
  error: ErrorDetail;
  meta: Partial<ToolMeta>;
}

export type ToolEnvelope<T> = ToolEnvelopeOk<T> | ToolEnvelopeErr;

export interface OkOptions extends Partial<ToolMeta> {
  source: ToolSource;
}

export function ok<T>(data: T, opts: OkOptions, warnings: string[] = []): ToolEnvelopeOk<T> {
  return {
    ok: true,
    data,
    warnings,
    meta: {
      source: opts.source,
      durationMs: opts.durationMs ?? 0,
      detailLevel: opts.detailLevel ?? "normal",
      ...(opts.unityVersion !== undefined ? { unityVersion: opts.unityVersion } : {}),
      ...(opts.projectPath !== undefined ? { projectPath: opts.projectPath } : {}),
    },
  };
}

export function err(
  code: ErrorCode,
  message?: string,
  meta: Partial<ToolMeta> = {},
  details?: Record<string, unknown>
): ToolEnvelopeErr {
  return {
    ok: false,
    error: makeError(code, message, details),
    meta,
  };
}

export async function timed<T>(fn: () => Promise<T> | T): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}
