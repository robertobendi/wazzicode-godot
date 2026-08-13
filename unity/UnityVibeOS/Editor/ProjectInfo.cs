using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace UnityVibeOS
{
    public static class ProjectInfo
    {
        public static string UnityVersion => Application.unityVersion;

        /// <summary>
        /// Project path = parent of the Assets folder.
        /// </summary>
        public static string ProjectPath
        {
            get
            {
                var dataPath = Application.dataPath;
                if (string.IsNullOrEmpty(dataPath)) return "";
                return Path.GetFullPath(Path.Combine(dataPath, ".."));
            }
        }

        public static IDictionary<string, object> GetSummary()
        {
            var packages = new List<object>();
            var manifestPath = Path.Combine(ProjectPath, "Packages", "manifest.json");
            if (File.Exists(manifestPath))
            {
                try
                {
                    var raw = File.ReadAllText(manifestPath);
                    if (MiniJson.Deserialize(raw) is Dictionary<string, object> root
                        && root.TryGetValue("dependencies", out var depObj)
                        && depObj is Dictionary<string, object> deps)
                    {
                        foreach (var kv in deps)
                        {
                            packages.Add(new Dictionary<string, object>
                            {
                                { "name", kv.Key },
                                { "version", kv.Value?.ToString() ?? "" }
                            });
                        }
                    }
                }
                catch { /* tolerated */ }
            }

            string renderPipeline = "Built-in";
            if (UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline != null)
            {
                renderPipeline = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline.GetType().Name;
            }

            string inputSystem = "Legacy InputManager";
#if ENABLE_INPUT_SYSTEM
            inputSystem = "InputSystem";
#endif

            string scriptingBackend = "Mono";
#if ENABLE_IL2CPP
            scriptingBackend = "IL2CPP";
#endif

            var dict = new Dictionary<string, object>
            {
                { "unityVersion", UnityVersion },
                { "projectPath", ProjectPath },
                { "productName", PlayerSettings.productName },
                { "companyName", PlayerSettings.companyName },
                { "bundleIdentifier", Application.identifier },
                { "renderPipeline", renderPipeline },
                { "inputSystem", inputSystem },
                { "scriptingBackend", scriptingBackend },
                { "buildTarget", EditorUserBuildSettings.activeBuildTarget.ToString() },
                { "packages", packages }
            };
            return dict;
        }

        public static IDictionary<string, object> GetBuildSettings()
        {
            var target = EditorUserBuildSettings.activeBuildTarget;
            var group = BuildPipeline.GetBuildTargetGroup(target);
            bool targetSupported = BuildPipeline.IsBuildTargetSupported(group, target);
            var scenes = new List<object>();
            var issues = new List<object>();
            int enabledSceneCount = 0;

            var configuredScenes = EditorBuildSettings.scenes;
            if (configuredScenes != null)
            {
                foreach (var scene in configuredScenes)
                {
                    string path = scene.path ?? "";
                    bool exists = !string.IsNullOrEmpty(path) && AssetDatabase.LoadAssetAtPath<SceneAsset>(path) != null;
                    if (scene.enabled)
                    {
                        enabledSceneCount++;
                        if (!exists) issues.Add($"Enabled scene is missing: {path}");
                    }
                    scenes.Add(new Dictionary<string, object>
                    {
                        { "path", path },
                        { "enabled", scene.enabled },
                        { "guid", scene.guid.ToString() },
                        { "exists", exists }
                    });
                }
            }

            if (enabledSceneCount == 0) issues.Add("No enabled scenes are configured in Build Settings.");
            if (!targetSupported) issues.Add($"Build target {target} is not supported by this Unity installation.");

            return new Dictionary<string, object>
            {
                { "valid", issues.Count == 0 },
                { "activeBuildTarget", target.ToString() },
                { "buildTargetGroup", group.ToString() },
                { "targetSupported", targetSupported },
                { "developmentBuild", EditorUserBuildSettings.development },
                { "enabledSceneCount", enabledSceneCount },
                { "scenes", scenes },
                { "issues", issues }
            };
        }
    }
}
