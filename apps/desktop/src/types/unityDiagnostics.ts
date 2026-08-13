export type UnityConsoleLevel = "Log" | "Warning" | "Error" | "Assert" | "Exception";

export interface UnityConsoleEntry {
  type: UnityConsoleLevel;
  message: string;
  stackTrace?: string;
  timestamp: number;
}

export interface UnityCompileProblem {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  type?: "error" | "warning";
}

export interface UnityCompileStatus {
  isCompiling: boolean;
  hasErrors: boolean;
  errorCount: number;
  warningCount: number;
  errors?: UnityCompileProblem[];
}

export interface UnityConsoleResult {
  logs: UnityConsoleEntry[];
  truncated: boolean;
  bufferSize: number;
}

export interface UnityPlayModeStatus {
  isPlaying: boolean;
  isPaused: boolean;
  timeScale?: number;
  frameCount?: number;
}

export interface UnityDiagnosticsSnapshot {
  compile: UnityCompileStatus;
  console: UnityConsoleResult;
  playMode: UnityPlayModeStatus;
  capturedAt: number;
}

export type UnityDiagnosticsIssue =
  | { kind: "compile"; problem: UnityCompileProblem }
  | { kind: "console"; entry: UnityConsoleEntry };
