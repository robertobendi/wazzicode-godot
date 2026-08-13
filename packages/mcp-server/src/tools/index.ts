import { AnyToolDef } from "../registry.js";
import { unityProjectSummary } from "./unityProjectSummary.js";
import { unityGenerateProjectBrain } from "./unityGenerateProjectBrain.js";
import { unityQueryProjectBrain } from "./unityQueryProjectBrain.js";
import { unityGetOpenScenes } from "./unityGetOpenScenes.js";
import { unityGetSceneHierarchy } from "./unityGetSceneHierarchy.js";
import { unityInspectSelected } from "./unityInspectSelected.js";
import { unityGetConsoleLogs } from "./unityGetConsoleLogs.js";
import { unityWaitForCompile } from "./unityWaitForCompile.js";
import { unityRefreshAssets } from "./unityRefreshAssets.js";
import { unityCheckGitStatus } from "./unityCheckGitStatus.js";
import { unityCaptureGameView } from "./unityCaptureGameView.js";
import { unityCaptureSceneView } from "./unityCaptureSceneView.js";
import { unityCaptureSelected } from "./unityCaptureSelected.js";
import { unityCaptureEditorWindow } from "./unityCaptureEditorWindow.js";
import { unityGetPerformanceStats } from "./unityGetPerformanceStats.js";
import { unityGetBuildSettings } from "./unityBuildSettings.js";
import { unityRunTests } from "./unityRunTests.js";
import { unitySmokeTest } from "./unitySmokeTest.js";
import { unityQa } from "./unityQa.js";
import {
  unityEnterPlayMode,
  unityExitPlayMode,
  unityStepFrame,
  unityGetPlayModeStatus,
} from "./unityPlayMode.js";
import { unityFindRuntimeObjects, unityInspectRuntimeObject } from "./unityRuntime.js";
import { unityConfigurePlayMode, unitySetRuntimeField } from "./unityRuntimeControl.js";
import {
  unityFindMissingScripts,
  unityFindMissingReferences,
  unityFindDependencies,
  unityFindReferences,
} from "./unityAssetGraph.js";
import {
  unitySetSerializedField,
  unityAddComponent,
  unityCreateGameObject,
  unitySaveScene,
  unityAssignReference,
  unityWireUiButton,
  unityInstantiatePrefab,
  unityCreateScriptableObject,
  unityCreateMaterial,
  unityCreatePrefabVariant,
  unityClearConsole,
  unityDeleteGameObject,
  unityRemoveComponent,
  unityDeleteAsset,
} from "./unityEdit.js";
import { unityOpenScene, unityLoadSceneAdditive } from "./unityScene.js";
import { unitySetTransform, unityReparent } from "./unityLayout.js";
import { unityOpenPrefab, unitySavePrefab, unityApplyPrefabInstance } from "./unityPrefab.js";
import { unitySimulateInput } from "./unitySimulateInput.js";
import {
  unityGetAnimatorState,
  unitySetAnimatorParameter,
  unityAnimatorEditTransition,
} from "./unityAnimator.js";
import { unityExecuteMenuItem } from "./unityMenu.js";
import { unityImportAsset, unitySliceSprite } from "./unityAsset.js";
import { unityPaintTilemap } from "./unityTilemap.js";
import { unityOrient } from "./unityOrient.js";
import { unityVerify } from "./unityVerify.js";
import { unityBatch } from "./unityBatch.js";
import {
  unityReadScript,
  unityGetScriptSha,
  unityFindInFile,
  unityCreateScript,
  unityApplyTextEdits,
  unityScriptEdit,
} from "./unityScript.js";
import { unityExecuteCode } from "./unityCode.js";
import { unityReflect, unityDocs } from "./unityReflect.js";
import { unityManageTools } from "./unityManageTools.js";
import { unityDiagnoseConnection } from "./unityDiagnoseConnection.js";

export const allTools: AnyToolDef[] = [
  // Context / inspection
  unityOrient,
  unityDiagnoseConnection,
  unityVerify,
  unityBatch,
  unityManageTools,
  unityProjectSummary,
  unityGenerateProjectBrain,
  unityQueryProjectBrain,
  unityGetOpenScenes,
  unityGetSceneHierarchy,
  unityInspectSelected,
  unityGetConsoleLogs,
  unityWaitForCompile,
  unityRefreshAssets,
  unityCheckGitStatus,
  // Visual
  unityCaptureGameView,
  unityCaptureSceneView,
  unityCaptureSelected,
  unityCaptureEditorWindow,
  // Performance
  unityGetPerformanceStats,
  // Tests
  unityRunTests,
  unityGetBuildSettings,
  unitySmokeTest,
  unityQa,
  // Play mode + runtime
  unityEnterPlayMode,
  unityExitPlayMode,
  unityStepFrame,
  unityGetPlayModeStatus,
  unityConfigurePlayMode,
  unityFindRuntimeObjects,
  unityInspectRuntimeObject,
  unitySetRuntimeField,
  // Asset / reference graph
  unityFindMissingScripts,
  unityFindMissingReferences,
  unityFindDependencies,
  unityFindReferences,
  // C# script editing (read)
  unityReadScript,
  unityGetScriptSha,
  unityFindInFile,
  // Anti-hallucination
  unityReflect,
  unityDocs,
  // Scene navigation (non-write)
  unityOpenScene,
  unityLoadSceneAdditive,
  unityOpenPrefab,
  // Play-test + animation
  unitySimulateInput,
  unityGetAnimatorState,
  unitySetAnimatorParameter,
  // Write (safety-gated)
  unitySetSerializedField,
  unitySetTransform,
  unityReparent,
  unityAddComponent,
  unityCreateGameObject,
  unitySaveScene,
  unityAssignReference,
  unityWireUiButton,
  unityInstantiatePrefab,
  unityPaintTilemap,
  unityDeleteGameObject,
  unityRemoveComponent,
  // C# script editing (write; script target)
  unityCreateScript,
  unityApplyTextEdits,
  unityScriptEdit,
  // In-Editor C# execution (write; code target, opt-in)
  unityExecuteCode,
  unitySavePrefab,
  unityApplyPrefabInstance,
  unityCreateScriptableObject,
  unityCreateMaterial,
  unityImportAsset,
  unitySliceSprite,
  unityDeleteAsset,
  unityCreatePrefabVariant,
  unityAnimatorEditTransition,
  unityExecuteMenuItem,
  unityClearConsole,
];

export {
  unityProjectSummary,
  unityGenerateProjectBrain,
  unityQueryProjectBrain,
  unityGetOpenScenes,
  unityGetSceneHierarchy,
  unityInspectSelected,
  unityGetConsoleLogs,
  unityWaitForCompile,
  unityRefreshAssets,
  unityCheckGitStatus,
  unityCaptureGameView,
  unityCaptureSceneView,
  unityCaptureSelected,
  unityCaptureEditorWindow,
  unityGetPerformanceStats,
  unityGetBuildSettings,
  unityRunTests,
  unitySmokeTest,
  unityQa,
  unityEnterPlayMode,
  unityExitPlayMode,
  unityStepFrame,
  unityGetPlayModeStatus,
  unityConfigurePlayMode,
  unityFindRuntimeObjects,
  unityInspectRuntimeObject,
  unitySetRuntimeField,
  unityFindMissingScripts,
  unityFindMissingReferences,
  unityFindDependencies,
  unityFindReferences,
  unitySetSerializedField,
  unityAddComponent,
  unityCreateGameObject,
  unitySaveScene,
  unityAssignReference,
  unityWireUiButton,
  unityInstantiatePrefab,
  unityCreateScriptableObject,
  unityCreateMaterial,
  unityCreatePrefabVariant,
  unityClearConsole,
  unityDeleteGameObject,
  unityRemoveComponent,
  unityDeleteAsset,
  unityOpenScene,
  unityLoadSceneAdditive,
  unitySetTransform,
  unityReparent,
  unityOpenPrefab,
  unitySavePrefab,
  unityApplyPrefabInstance,
  unitySimulateInput,
  unityGetAnimatorState,
  unitySetAnimatorParameter,
  unityAnimatorEditTransition,
  unityExecuteMenuItem,
  unityImportAsset,
  unitySliceSprite,
  unityPaintTilemap,
  unityOrient,
  unityDiagnoseConnection,
  unityVerify,
  unityBatch,
  unityReadScript,
  unityGetScriptSha,
  unityFindInFile,
  unityCreateScript,
  unityApplyTextEdits,
  unityScriptEdit,
  unityExecuteCode,
  unityReflect,
  unityDocs,
  unityManageTools,
};
