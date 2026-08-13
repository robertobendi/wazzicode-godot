using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Finds and inspects live objects. Works in edit mode against loaded scene objects, but is
    /// most useful in play mode where it sees runtime-spawned objects and their current state.
    /// </summary>
    public static class RuntimeInspector
    {
        public static IDictionary<string, object> FindObjects(string query, string component, int limit, bool includeInactive)
        {
            if (limit <= 0) limit = 100;
            var matches = new List<object>();
            int matchCount = 0;
            bool truncated = false;

            Type compType = null;
            if (!string.IsNullOrEmpty(component))
            {
                compType = ResolveComponentType(component);
                if (compType == null)
                {
                    throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", $"Unknown component type '{component}'.");
                }
            }

            // FindObjectsOfTypeAll includes inactive and DontDestroyOnLoad objects; filter to
            // genuine scene objects (exclude assets/prefabs and hidden editor objects).
            var all = Resources.FindObjectsOfTypeAll<GameObject>();
            foreach (var go in all)
            {
                if (go == null) continue;
                if (!go.scene.IsValid()) continue;                       // prefab assets / not in a scene
                if ((go.hideFlags & HideFlags.HideAndDontSave) != 0) continue;
                if (!includeInactive && !go.activeInHierarchy) continue;
                if (!string.IsNullOrEmpty(query) && go.name.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (compType != null && go.GetComponent(compType) == null) continue;

                matchCount++;
                if (matches.Count >= limit) { truncated = true; continue; }

                var compNames = new List<object>();
                foreach (var c in go.GetComponents<Component>())
                {
                    compNames.Add(c == null ? "<MissingScript>" : c.GetType().Name);
                }
                matches.Add(new Dictionary<string, object>
                {
                    { "name", go.name },
                    { "path", SceneInspector.PathOf(go) },
                    { "instanceId", go.GetInstanceID() },
                    { "activeInHierarchy", go.activeInHierarchy },
                    { "components", compNames }
                });
            }

            return new Dictionary<string, object>
            {
                { "isPlaying", EditorApplication.isPlaying },
                { "query", query ?? "" },
                { "matchCount", matchCount },
                { "objects", matches },
                { "truncated", truncated }
            };
        }

        public static IDictionary<string, object> Inspect(int instanceId, string path, bool includeFields)
        {
            GameObject go = null;
            if (instanceId != 0)
            {
                go = EditorCompat.IdToObject(instanceId) as GameObject;
            }
            if (go == null && !string.IsNullOrEmpty(path))
            {
                go = FindByPath(path);
            }
            if (go == null)
            {
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND",
                    instanceId != 0 ? $"No live GameObject with instanceId {instanceId}." : $"No live GameObject at path '{path}'.");
            }
            return new Dictionary<string, object>
            {
                { "isPlaying", EditorApplication.isPlaying },
                { "selected", SelectionInspector.Describe(go, includeFields) }
            };
        }

        public static IDictionary<string, object> SetField(IDictionary<string, object> p)
        {
            if (!EditorApplication.isPlaying)
                throw new BridgeRouter.HandlerError("PLAY_MODE_REQUIRED", "Runtime field overrides only take effect in play mode. Enter play mode first.");

            int instanceId = Int(p, "instanceId", 0);
            string path = Str(p, "path");
            var go = instanceId != 0 ? EditorCompat.IdToObject(instanceId) as GameObject : null;
            if (go == null && !string.IsNullOrEmpty(path)) go = FindByPath(path);
            if (go == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", "Runtime target not found (provide instanceId or path).");
            if (EditorUtility.IsPersistent(go)
                || !go.scene.IsValid()
                || !go.scene.isLoaded
                || EditorSceneManager.IsPreviewSceneObject(go)
                || PrefabStageUtility.GetPrefabStage(go) != null
                || (go.hideFlags & HideFlags.HideAndDontSave) != 0)
            {
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Runtime field overrides only accept live GameObjects in a loaded play-world scene.");
            }

            string componentName = Str(p, "component");
            string field = Str(p, "field");
            if (string.IsNullOrEmpty(componentName))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'component'.");
            if (string.IsNullOrEmpty(field))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'field'.");
            if (p == null || !p.TryGetValue("value", out var value))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'value'.");

            Component component = null;
            foreach (var candidate in go.GetComponents<Component>())
            {
                if (candidate != null && (candidate.GetType().Name == componentName || candidate.GetType().FullName == componentName))
                {
                    if (component != null)
                    {
                        throw new BridgeRouter.HandlerError("INVALID_ARGUMENT",
                            $"Component selector '{componentName}' matches multiple components on '{go.name}'. Runtime field overrides require a unique component.");
                    }
                    component = candidate;
                }
            }
            if (component == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Component '{componentName}' not found on '{go.name}'.");

            var serialized = new SerializedObject(component);
            var property = serialized.FindProperty(field);
            if (property == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Serialized field '{field}' not found on '{componentName}'.");

            Mutators.SetPropertyValue(property, value);
            bool changed = serialized.ApplyModifiedPropertiesWithoutUndo();
            string target = SceneInspector.PathOf(go);
            return new Dictionary<string, object>
            {
                { "applied", true },
                { "changed", changed },
                { "summary", $"Set runtime-only {componentName}.{field} on {target}" },
                { "target", target },
                { "runtimeOnly", true },
                { "undoable", false }
            };
        }

        static GameObject FindByPath(string path)
        {
            GameObject match = null;
            var all = Resources.FindObjectsOfTypeAll<GameObject>();
            foreach (var go in all)
            {
                if (go == null || !go.scene.IsValid()) continue;
                if ((go.hideFlags & HideFlags.HideAndDontSave) != 0) continue;
                if (SceneInspector.PathOf(go) != path) continue;
                if (match != null)
                {
                    throw new BridgeRouter.HandlerError("INVALID_ARGUMENT",
                        $"Hierarchy path '{path}' matches multiple loaded objects. Use instanceId to select one unambiguously.");
                }
                match = go;
            }
            return match;
        }

        static Type ResolveComponentType(string name)
        {
            // Try a fast path via TypeCache (Editor only), then a loose name match.
            foreach (var t in TypeCache.GetTypesDerivedFrom<Component>())
            {
                if (t.Name == name || t.FullName == name) return t;
            }
            return null;
        }
    }
}
