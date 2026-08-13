using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Prefab-mode editing. OpenPrefab enters isolation mode (the scene-edit tools then operate on
    /// the prefab's own contents); SavePrefab writes the stage back to the asset; ApplyInstance
    /// pushes a scene instance's overrides up to its source prefab. Save/Apply are gated as prefab
    /// writes at the MCP layer.
    /// </summary>
    public static class PrefabStageBridge
    {
        public static IDictionary<string, object> OpenPrefab(IDictionary<string, object> p)
        {
            string assetPath = ResolvePrefabPath(p);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null) throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No prefab at '{assetPath}'.");

            var stage = PrefabStageUtility.OpenPrefab(assetPath);
            if (stage == null)
                throw new BridgeRouter.HandlerError("INTERNAL_ERROR", $"Failed to open prefab '{assetPath}' in prefab mode.");

            return new Dictionary<string, object>
            {
                { "opened", true },
                { "assetPath", stage.assetPath },
                { "rootName", stage.prefabContentsRoot != null ? stage.prefabContentsRoot.name : null },
                { "inPrefabMode", true }
            };
        }

        public static IDictionary<string, object> SavePrefab(IDictionary<string, object> p)
        {
            var stage = PrefabStageUtility.GetCurrentPrefabStage();
            if (stage == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", "No prefab is open in prefab mode. Call unity_open_prefab first.");

            PrefabUtility.SaveAsPrefabAsset(stage.prefabContentsRoot, stage.assetPath, out bool success);
            if (!success)
                throw new BridgeRouter.HandlerError("INTERNAL_ERROR", $"Failed to save prefab '{stage.assetPath}'.");

            bool closeAfter = p != null && p.TryGetValue("closeAfter", out var c) && c != null && System.Convert.ToBoolean(c);
            if (closeAfter) StageUtility.GoBackToPreviousStage();

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Saved prefab {stage.assetPath}" },
                { "target", stage.assetPath },
                { "closed", closeAfter },
                { "undoable", false }
            };
        }

        public static IDictionary<string, object> ApplyInstance(IDictionary<string, object> p)
        {
            var go = ResolveTarget(p);
            var root = PrefabUtility.GetOutermostPrefabInstanceRoot(go);
            if (root == null)
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", $"'{go.name}' is not part of a prefab instance.");

            string assetPath = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(root);
            PrefabUtility.ApplyPrefabInstance(root, InteractionMode.AutomatedAction);

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Applied overrides on {SceneInspector.PathOf(root)} to {assetPath}" },
                { "target", assetPath },
                { "undoable", false }
            };
        }

        // ---- helpers ----

        static string ResolvePrefabPath(IDictionary<string, object> p)
        {
            string path = Str(p, "prefabPath");
            string guid = Str(p, "prefabGuid");
            if (string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(guid)) path = AssetDatabase.GUIDToAssetPath(guid);
            if (string.IsNullOrEmpty(path)) throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'prefabPath' (or 'prefabGuid').");
            return path.Replace('\\', '/');
        }

        static GameObject ResolveTarget(IDictionary<string, object> p)
        {
            int instanceId = Int(p, "instanceId", 0);
            string path = Str(p, "path");
            GameObject go = null;
            if (instanceId != 0) go = EditorCompat.IdToObject(instanceId) as GameObject;
            if (go == null && !string.IsNullOrEmpty(path)) go = FindByPath(path);
            if (go == null && instanceId == 0 && string.IsNullOrEmpty(path)) go = Selection.activeGameObject;
            if (go == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", "Target GameObject not found (provide instanceId or path, or select one).");
            return go;
        }

        static GameObject FindByPath(string path)
        {
            foreach (var go in Resources.FindObjectsOfTypeAll<GameObject>())
            {
                if (go == null || !go.scene.IsValid()) continue;
                if ((go.hideFlags & HideFlags.HideAndDontSave) != 0) continue;
                if (SceneInspector.PathOf(go) == path) return go;
            }
            return null;
        }

    }
}
