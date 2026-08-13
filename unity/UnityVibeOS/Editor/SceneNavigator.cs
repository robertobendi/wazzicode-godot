using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;

namespace UnityVibeOS
{
    /// <summary>
    /// Scene navigation: open a scene (single) or load one additively, so Claude can traverse the
    /// project without the user switching scenes by hand. These are not gated as writes, but
    /// single-open refuses to silently discard unsaved changes (it surfaces UNSAVED_CHANGES with
    /// the dirty scene list unless discardUnsavedChanges is set).
    /// </summary>
    public static class SceneNavigator
    {
        public static IDictionary<string, object> OpenScene(IDictionary<string, object> p)
        {
            string scenePath = RequireScenePath(p);
            bool discard = p.TryGetValue("discardUnsavedChanges", out var dv) && dv != null && System.Convert.ToBoolean(dv);

            if (!discard)
            {
                var dirty = new List<object>();
                for (int i = 0; i < SceneManager.sceneCount; i++)
                {
                    var s = SceneManager.GetSceneAt(i);
                    if (s.isDirty) dirty.Add(string.IsNullOrEmpty(s.path) ? (s.name + " (unsaved)") : s.path);
                }
                if (dirty.Count > 0)
                {
                    throw new BridgeRouter.HandlerError(
                        "UNSAVED_CHANGES",
                        "Opening a scene would discard unsaved changes. Save first or pass discardUnsavedChanges:true.",
                        new Dictionary<string, object> { { "dirtyScenes", dirty } });
                }
            }

            EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
            return Result(scenePath);
        }

        public static IDictionary<string, object> LoadSceneAdditive(IDictionary<string, object> p)
        {
            string scenePath = RequireScenePath(p);
            // Additive load preserves existing scenes (and their unsaved edits), so no dirty guard.
            EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Additive);
            return Result(scenePath);
        }

        static IDictionary<string, object> Result(string opened)
        {
            var summary = SceneInspector.GetOpenScenes();
            summary["opened"] = opened;
            return summary;
        }

        static string RequireScenePath(IDictionary<string, object> p)
        {
            string path = p != null && p.TryGetValue("scenePath", out var v) && v != null ? v.ToString() : null;
            if (string.IsNullOrEmpty(path))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'scenePath'.");
            path = path.Replace('\\', '/');
            if (!File.Exists(path))
                throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No scene file at '{path}'.");
            return path;
        }
    }
}
