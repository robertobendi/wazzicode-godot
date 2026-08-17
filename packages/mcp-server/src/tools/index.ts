import type { AnyToolDef } from "../registry.js";
import {
  godotCapture2DView, godotCapture3DView, godotCreateNode, godotDeleteNode,
  godotFindDependencies, godotGetFilesystemStatus, godotGetOpenScenes, godotGetPlayStatus,
  godotGetSceneTree, godotInspectSelected, godotInstantiateScene, godotOpenScene,
  godotProjectSummary, godotReflect, godotRefreshFilesystem, godotReparentNode,
  godotRunProject, godotSaveScene, godotSetProperty, godotStopProject,
} from "./godotBridge.js";
import {
  godotApplyTextEdits, godotCreateScript, godotFindInFile, godotGetScriptSha,
  godotReadScript, godotVerify,
} from "./godotFiles.js";
import {
  godotBatch, godotDiagnoseConnection, godotGenerateProjectBrain, godotOrient,
  godotQueryProjectBrain,
} from "./godotComposite.js";
import { godotDebugRun } from "./godotDebug.js";
import { godotCaptureFrames } from "./godotCaptureFrames.js";
import { godotTestRun } from "./godotTests.js";

export const allTools: AnyToolDef[] = [
  godotOrient,
  godotDiagnoseConnection,
  godotVerify,
  godotTestRun,
  godotBatch,
  godotProjectSummary,
  godotGenerateProjectBrain,
  godotQueryProjectBrain,
  godotGetOpenScenes,
  godotGetSceneTree,
  godotInspectSelected,
  godotGetFilesystemStatus,
  godotRefreshFilesystem,
  godotFindDependencies,
  godotReflect,
  godotCapture2DView,
  godotCapture3DView,
  godotOpenScene,
  godotSaveScene,
  godotSetProperty,
  godotCreateNode,
  godotDeleteNode,
  godotReparentNode,
  godotInstantiateScene,
  godotReadScript,
  godotGetScriptSha,
  godotFindInFile,
  godotCreateScript,
  godotApplyTextEdits,
  godotDebugRun,
  godotCaptureFrames,
  godotRunProject,
  godotStopProject,
  godotGetPlayStatus,
];

export {
  godotApplyTextEdits, godotBatch, godotCapture2DView, godotCapture3DView,
  godotCaptureFrames,
  godotCreateNode, godotCreateScript, godotDeleteNode, godotDiagnoseConnection,
  godotDebugRun,
  godotFindDependencies, godotFindInFile, godotGenerateProjectBrain,
  godotGetFilesystemStatus, godotGetOpenScenes, godotGetPlayStatus,
  godotGetSceneTree, godotGetScriptSha, godotInspectSelected, godotInstantiateScene,
  godotOpenScene, godotOrient, godotProjectSummary, godotQueryProjectBrain,
  godotReadScript, godotReflect, godotRefreshFilesystem, godotReparentNode,
  godotRunProject, godotSaveScene, godotSetProperty, godotStopProject, godotVerify,
  godotTestRun,
};
