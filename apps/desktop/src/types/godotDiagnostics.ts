export interface GodotFilesystemStatus {
  scanning: boolean;
  importing: boolean;
  progress: number;
  indexedFiles: number;
}

export interface GodotSceneSummary {
  path: string;
  name: string;
  isActive: boolean;
  isUnsaved: boolean;
  rootType?: string;
}

export interface GodotOpenScenes {
  scenes: GodotSceneSummary[];
  activeScene?: string;
}

export interface GodotPlayStatus {
  playing: boolean;
  scenePath?: string;
}

export interface GodotTestStatus {
  status: "not_configured";
  message: string;
}

export interface GodotDiagnosticsSnapshot {
  filesystem: GodotFilesystemStatus;
  scenes: GodotOpenScenes;
  play: GodotPlayStatus;
  tests: GodotTestStatus;
  capturedAt: number;
}
