using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityVibeOS
{
    /// <summary>
    /// Read-only project-integrity and dependency queries over the AssetDatabase. These are the
    /// "why is my scene/prefab broken" diagnostics: missing scripts, dangling references, and
    /// forward/reverse asset dependency graphs.
    /// </summary>
    public static class AssetGraph
    {
        // ---- Missing scripts ----

        public static IDictionary<string, object> FindMissingScripts(int limit)
        {
            if (limit <= 0) limit = 200;
            var hits = new List<object>();
            int scanned = 0;
            bool truncated = false;

            foreach (var guid in AssetDatabase.FindAssets("t:Prefab"))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                var root = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (root == null) continue;
                scanned++;
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                {
                    int missing = CountMissing(t.gameObject);
                    if (missing > 0)
                    {
                        if (hits.Count >= limit) { truncated = true; break; }
                        hits.Add(new Dictionary<string, object>
                        {
                            { "assetPath", path },
                            { "objectPath", RelativePath(root.transform, t) },
                            { "missingCount", missing }
                        });
                    }
                }
                if (truncated) break;
            }

            // Also scan currently-open scenes (closed scenes aren't opened — that would be destructive).
            for (int i = 0; i < SceneManager.sceneCount && !truncated; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                scanned++;
                foreach (var rootGo in scene.GetRootGameObjects())
                {
                    foreach (var t in rootGo.GetComponentsInChildren<Transform>(true))
                    {
                        int missing = CountMissing(t.gameObject);
                        if (missing > 0)
                        {
                            if (hits.Count >= limit) { truncated = true; break; }
                            hits.Add(new Dictionary<string, object>
                            {
                                { "assetPath", scene.path },
                                { "objectPath", SceneInspector.PathOf(t.gameObject) },
                                { "missingCount", missing }
                            });
                        }
                    }
                    if (truncated) break;
                }
            }

            return new Dictionary<string, object>
            {
                { "scanned", scanned },
                { "hits", hits },
                { "truncated", truncated }
            };
        }

        static int CountMissing(GameObject go)
        {
#if UNITY_2019_3_OR_NEWER
            return GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(go);
#else
            int n = 0;
            foreach (var c in go.GetComponents<Component>()) if (c == null) n++;
            return n;
#endif
        }

        // ---- Missing references ----

        public static IDictionary<string, object> FindMissingReferences(int limit)
        {
            if (limit <= 0) limit = 200;
            var hits = new List<object>();
            int scanned = 0;
            bool truncated = false;

            foreach (var guid in AssetDatabase.FindAssets("t:Prefab"))
            {
                if (truncated) break;
                var path = AssetDatabase.GUIDToAssetPath(guid);
                var root = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (root == null) continue;
                scanned++;
                ScanTreeForMissingRefs(root.transform, path, (objPath, comp, field) =>
                {
                    if (hits.Count >= limit) { truncated = true; return false; }
                    hits.Add(MissingRefHit(path, objPath, comp, field));
                    return true;
                });
            }

            for (int i = 0; i < SceneManager.sceneCount && !truncated; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                scanned++;
                foreach (var rootGo in scene.GetRootGameObjects())
                {
                    if (truncated) break;
                    ScanTreeForMissingRefs(rootGo.transform, scene.path, (objPath, comp, field) =>
                    {
                        if (hits.Count >= limit) { truncated = true; return false; }
                        hits.Add(MissingRefHit(scene.path, objPath, comp, field));
                        return true;
                    });
                }
            }

            return new Dictionary<string, object>
            {
                { "scanned", scanned },
                { "hits", hits },
                { "truncated", truncated }
            };
        }

        delegate bool MissingRefSink(string objectPath, string component, string field);

        static void ScanTreeForMissingRefs(Transform root, string assetPath, MissingRefSink sink)
        {
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                var go = t.gameObject;
                string objPath = assetPath.EndsWith(".unity")
                    ? SceneInspector.PathOf(go)
                    : RelativePath(root, t);
                foreach (var comp in go.GetComponents<Component>())
                {
                    if (comp == null) continue; // missing script handled separately
                    var so = new SerializedObject(comp);
                    var it = so.GetIterator();
                    while (it.NextVisible(true))
                    {
                        if (it.propertyType != SerializedPropertyType.ObjectReference) continue;
                        if (it.objectReferenceValue == null && it.objectReferenceInstanceIDValue != 0)
                        {
                            if (!sink(objPath, comp.GetType().Name, it.propertyPath)) return;
                        }
                    }
                }
            }
        }

        static IDictionary<string, object> MissingRefHit(string assetPath, string objectPath, string component, string field)
        {
            return new Dictionary<string, object>
            {
                { "assetPath", assetPath },
                { "objectPath", objectPath },
                { "component", component },
                { "field", field }
            };
        }

        // ---- Dependencies (forward) ----

        public static IDictionary<string, object> FindDependencies(string path, bool recursive, int limit)
        {
            RequireAsset(path);
            if (limit <= 0) limit = 500;
            var deps = AssetDatabase.GetDependencies(path, recursive);
            var list = new List<object>();
            bool truncated = false;
            foreach (var dep in deps)
            {
                if (dep == path) continue;
                if (list.Count >= limit) { truncated = true; break; }
                list.Add(AssetRef(dep));
            }
            return new Dictionary<string, object>
            {
                { "asset", AssetRef(path) },
                { "direction", "dependencies" },
                { "recursive", recursive },
                { "count", list.Count },
                { "assets", list },
                { "truncated", truncated }
            };
        }

        // ---- References (reverse) ----

        public static IDictionary<string, object> FindReferences(string path, int limit)
        {
            RequireAsset(path);
            if (limit <= 0) limit = 500;
            var list = new List<object>();
            bool truncated = false;
            // Reverse lookup: scan every asset and ask whether its direct dependencies include `path`.
            foreach (var other in AssetDatabase.GetAllAssetPaths())
            {
                if (!other.StartsWith("Assets/")) continue;
                if (other == path) continue;
                var deps = AssetDatabase.GetDependencies(other, false);
                bool refs = false;
                foreach (var d in deps) { if (d == path) { refs = true; break; } }
                if (!refs) continue;
                if (list.Count >= limit) { truncated = true; break; }
                list.Add(AssetRef(other));
            }
            return new Dictionary<string, object>
            {
                { "asset", AssetRef(path) },
                { "direction", "references" },
                { "count", list.Count },
                { "assets", list },
                { "truncated", truncated }
            };
        }

        // ---- helpers ----

        static void RequireAsset(string path)
        {
            if (string.IsNullOrEmpty(path))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'path'.");
            if (string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(path)))
                throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No asset at '{path}'.");
        }

        static IDictionary<string, object> AssetRef(string path)
        {
            var type = AssetDatabase.GetMainAssetTypeAtPath(path);
            return new Dictionary<string, object>
            {
                { "path", path },
                { "guid", AssetDatabase.AssetPathToGUID(path) },
                { "type", type != null ? type.Name : "" }
            };
        }

        static string RelativePath(Transform root, Transform t)
        {
            var stack = new List<string>();
            var cur = t;
            while (cur != null && cur != root)
            {
                stack.Insert(0, cur.name);
                cur = cur.parent;
            }
            stack.Insert(0, root.name);
            return "/" + string.Join("/", stack);
        }
    }
}
