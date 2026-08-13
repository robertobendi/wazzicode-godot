using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace UnityVibeOS
{
    public static class SelectionInspector
    {
        public static IDictionary<string, object> Inspect(bool includeFields)
        {
            var go = Selection.activeGameObject;
            if (go == null)
            {
                return new Dictionary<string, object>
                {
                    { "hasSelection", false }
                };
            }
            return new Dictionary<string, object>
            {
                { "hasSelection", true },
                { "selected", Describe(go, includeFields) }
            };
        }

        /// <summary>
        /// Build the full inspector view of a GameObject. Shared by selection inspection and
        /// runtime inspection (play-mode live objects).
        /// </summary>
        public static IDictionary<string, object> Describe(GameObject go, bool includeFields)
        {
            var components = new List<object>();
            var warnings = new List<object>();
            var allComps = go.GetComponents<Component>();
            for (int i = 0; i < allComps.Length; i++)
            {
                var comp = allComps[i];
                if (comp == null)
                {
                    components.Add(new Dictionary<string, object>
                    {
                        { "type", "<MissingScript>" },
                        { "isMissingScript", true }
                    });
                    warnings.Add($"Missing script at component slot {i}");
                    continue;
                }
                var entry = new Dictionary<string, object>
                {
                    { "type", comp.GetType().Name },
                    { "assembly", comp.GetType().Assembly.GetName().Name }
                };
                var enabledProp = comp.GetType().GetProperty("enabled");
                if (enabledProp != null && enabledProp.PropertyType == typeof(bool))
                {
                    try { entry["enabled"] = (bool)enabledProp.GetValue(comp); } catch { /* ignore */ }
                }
                if (includeFields)
                {
                    try
                    {
                        var so = new SerializedObject(comp);
                        entry["fields"] = SerializedReader.ReadFields(so);
                    }
                    catch (System.Exception e)
                    {
                        entry["fieldsError"] = e.Message;
                    }
                }
                components.Add(entry);
            }

            string layerName = LayerMask.LayerToName(go.layer);
            if (string.IsNullOrEmpty(layerName)) layerName = $"Layer{go.layer}";

            // Prefab info
            var prefab = new Dictionary<string, object>
            {
                { "isPrefabInstance", PrefabUtility.IsPartOfPrefabInstance(go) },
                { "isPrefabAsset", PrefabUtility.IsPartOfPrefabAsset(go) }
            };
            if (PrefabUtility.IsPartOfPrefabInstance(go))
            {
                var src = PrefabUtility.GetCorrespondingObjectFromSource(go) as GameObject;
                if (src != null)
                {
                    var srcPath = AssetDatabase.GetAssetPath(src);
                    prefab["sourcePath"] = srcPath ?? "";
                    if (!string.IsNullOrEmpty(srcPath)) prefab["sourceGuid"] = AssetDatabase.AssetPathToGUID(srcPath);
                }
                prefab["hasOverrides"] = PrefabUtility.HasPrefabInstanceAnyOverrides(go, false);
            }
            if (PrefabUtility.IsPartOfPrefabAsset(go))
            {
                var p = AssetDatabase.GetAssetPath(go);
                if (!string.IsNullOrEmpty(p)) prefab["sourcePath"] = p;
            }

            var t = go.transform;
            var transform = new Dictionary<string, object>
            {
                { "position", new Dictionary<string, object> {
                    { "x", (double)t.localPosition.x }, { "y", (double)t.localPosition.y }, { "z", (double)t.localPosition.z } } },
                { "rotation", new Dictionary<string, object> {
                    { "x", (double)t.localEulerAngles.x }, { "y", (double)t.localEulerAngles.y }, { "z", (double)t.localEulerAngles.z } } },
                { "localScale", new Dictionary<string, object> {
                    { "x", (double)t.localScale.x }, { "y", (double)t.localScale.y }, { "z", (double)t.localScale.z } } },
                { "worldPosition", new Dictionary<string, object> {
                    { "x", (double)t.position.x }, { "y", (double)t.position.y }, { "z", (double)t.position.z } } }
            };

            var selected = new Dictionary<string, object>
            {
                { "name", go.name },
                { "path", SceneInspector.PathOf(go) },
                { "instanceId", go.GetInstanceID() },
                { "activeSelf", go.activeSelf },
                { "activeInHierarchy", go.activeInHierarchy },
                { "tag", go.tag ?? "" },
                { "layer", layerName },
                { "scene", go.scene.path ?? "" },
                { "prefab", prefab },
                { "transform", transform },
                { "components", components }
            };
            if (warnings.Count > 0) selected["warnings"] = warnings;

            return selected;
        }
    }
}
