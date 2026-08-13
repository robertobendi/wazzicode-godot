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

export const allTools: AnyToolDef[] = [
  godotOrient,
  godotDiagnoseConnection,
  godotVerify,
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
  godotRunProject,
  godotStopProject,
  godotGetPlayStatus,
];

export {
  godotApplyTextEdits, godotBatch, godotCapture2DView, godotCapture3DView,
  godotCreateNode, godotCreateScript, godotDeleteNode, godotDiagnoseConnection,
  godotFindDependencies, godotFindInFile, godotGenerateProjectBrain,
  godotGetFilesystemStatus, godotGetOpenScenes, godotGetPlayStatus,
  godotGetSceneTree, godotGetScriptSha, godotInspectSelected, godotInstantiateScene,
  godotOpenScene, godotOrient, godotProjectSummary, godotQueryProjectBrain,
  godotReadScript, godotReflect, godotRefreshFilesystem, godotReparentNode,
  godotRunProject, godotSaveScene, godotSetProperty, godotStopProject, godotVerify,
};
