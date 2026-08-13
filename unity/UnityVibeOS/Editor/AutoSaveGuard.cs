using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityVibeOS
{
    /// <summary>
    /// Keeps unattended/autopilot sessions from FREEZING on Unity's native
    /// "Scene(s) have been modified — save before reloading?" modal.
    ///
    /// Scene edits only mark a scene dirty. When a domain reload (triggered by a C#
    /// recompile) or entering play mode happens while scenes are dirty, the Editor
    /// pops a blocking modal that no MCP tool can dismiss — halting any automated
    /// loop driving the bridge. This guard silently persists dirty scenes just
    /// before those transitions so the modal never appears.
    ///
    /// Gated to autonomous sessions: active only when .unity-vibe/config.json has
    /// safetyMode == "autopilot", or "autoSaveBeforeReload": true is set explicitly.
    /// Interactive read_only/confirm sessions are unaffected. Only scenes already
    /// saved to disk (non-empty path) are saved — never an untitled scene, which
    /// would itself raise a Save-As dialog.
    /// </summary>
    [InitializeOnLoad]
    public static class AutoSaveGuard
    {
        static AutoSaveGuard()
        {
            AssemblyReloadEvents.beforeAssemblyReload -= SaveDirtyScenesIfAuto;
            AssemblyReloadEvents.beforeAssemblyReload += SaveDirtyScenesIfAuto;
            EditorApplication.playModeStateChanged -= OnPlayModeChange;
            EditorApplication.playModeStateChanged += OnPlayModeChange;
        }

        static void OnPlayModeChange(PlayModeStateChange state)
        {
            // Save right before play starts so the enter-play-mode reload can't prompt.
            if (state == PlayModeStateChange.ExitingEditMode)
                SaveDirtyScenesIfAuto();
        }

        static void SaveDirtyScenesIfAuto()
        {
            try
            {
                if (!AutoSaveEnabled()) return;
                int saved = 0;
                for (int i = 0; i < SceneManager.sceneCount; i++)
                {
                    var sc = SceneManager.GetSceneAt(i);
                    // Skip untitled scenes (empty path) — saving them would raise a Save-As modal.
                    if (sc.isLoaded && sc.isDirty && !string.IsNullOrEmpty(sc.path))
                    {
                        if (EditorSceneManager.SaveScene(sc)) saved++;
                    }
                }
                if (saved > 0)
                    Debug.Log($"[UnityVibeOS] Auto-saved {saved} dirty scene(s) before reload/play to avoid a blocking save dialog (autopilot).");
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[UnityVibeOS] auto-save before reload failed: {e.Message}");
            }
        }

        // Read .unity-vibe/config.json fresh (these events are infrequent). Explicit
        // "autoSaveBeforeReload" wins; otherwise follow autopilot. Fail safe to off.
        static bool AutoSaveEnabled()
        {
            try
            {
                var dataPath = Application.dataPath;
                if (string.IsNullOrEmpty(dataPath)) return false;
                var root = Path.GetFullPath(Path.Combine(dataPath, ".."));
                var cfgPath = Path.Combine(root, ".unity-vibe", "config.json");
                if (!File.Exists(cfgPath)) return false;

                if (!(MiniJson.Deserialize(File.ReadAllText(cfgPath)) is IDictionary<string, object> cfg))
                    return false;

                if (cfg.TryGetValue("autoSaveBeforeReload", out var raw) && raw is bool flag)
                    return flag;

                if (cfg.TryGetValue("safetyMode", out var mode) && mode is string s)
                    return string.Equals(s, "autopilot", StringComparison.OrdinalIgnoreCase);

                return false;
            }
            catch
            {
                return false;
            }
        }
    }
}
