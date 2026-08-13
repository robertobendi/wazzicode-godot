using System;
using System.Collections.Generic;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Maps protocol method names to handlers that run on the Unity main thread.
    /// Each handler returns the `result` payload (a Dictionary&lt;string, object&gt; or list).
    /// Errors are propagated as exceptions; the caller wraps them into the bridge envelope.
    /// </summary>
    public static class BridgeRouter
    {
        public sealed class HandlerError : Exception
        {
            public string Code { get; }
            public IDictionary<string, object> Details { get; }
            public HandlerError(string code, string message, IDictionary<string, object> details = null) : base(message)
            {
                Code = code;
                Details = details;
            }
        }

        /// <summary>
        /// Dynamic handler table for optional modules (e.g. the Test Framework integration)
        /// that live in a separate assembly which may not be compiled in every project.
        /// They self-register on load via <see cref="Register"/>; Dispatch checks this first.
        /// </summary>
        static readonly Dictionary<string, Func<IDictionary<string, object>, object>> Dynamic =
            new Dictionary<string, Func<IDictionary<string, object>, object>>();

        public static void Register(string method, Func<IDictionary<string, object>, object> handler)
        {
            if (string.IsNullOrEmpty(method) || handler == null) return;
            Dynamic[method] = handler;
        }

        public static object Dispatch(string method, IDictionary<string, object> p)
        {
            if (Dynamic.TryGetValue(method, out var dyn))
            {
                return dyn(p ?? new Dictionary<string, object>());
            }
            switch (method)
            {
                case "system.health":
                    return new Dictionary<string, object>
                    {
                        { "status", "ok" },
                        { "uptimeMs", BridgeServer.UptimeMs }
                    };
                case "system.summary":
                    return ProjectInfo.GetSummary();
                case "build.getSettings":
                    return ProjectInfo.GetBuildSettings();
                case "scene.getOpenScenes":
                    return SceneInspector.GetOpenScenes();
                case "scene.getHierarchy":
                {
                    string scenePath = Str(p, "scenePath", null);
                    int maxDepth = GetInt(p, "maxDepth", 32);
                    bool includeComponents = GetBool(p, "includeComponents", true);
                    int maxNodes = GetInt(p, "maxNodes", 5000);
                    return SceneInspector.GetHierarchy(scenePath, maxDepth, includeComponents, maxNodes);
                }
                case "selection.inspect":
                {
                    bool includeFields = GetBool(p, "includeFields", true);
                    return SelectionInspector.Inspect(includeFields);
                }
                case "console.getLogs":
                {
                    string level = Str(p, "level", "all");
                    int limit = GetInt(p, "limit", 200);
                    long? since = null;
                    if (p != null && p.TryGetValue("sinceTimestamp", out var st) && st != null)
                    {
                        if (st is long lv) since = lv;
                        else if (st is int iv) since = iv;
                        else if (st is double dv) since = (long)dv;
                    }
                    var logs = ConsoleCapture.Read(level, limit, since, out bool truncated, out int bufferSize);
                    return new Dictionary<string, object>
                    {
                        { "logs", logs },
                        { "truncated", truncated },
                        { "bufferSize", bufferSize }
                    };
                }
                case "compile.status":
                    return CompileWatcher.GetStatus();
                case "asset.refresh":
                    return CompileWatcher.RefreshAssets();
                case "screenshot.gameView":
                {
                    int width = GetInt(p, "width", 1280);
                    int height = GetInt(p, "height", 720);
                    string cameraPath = Str(p, "cameraPath", null);
                    string format = Str(p, "format", "png");
                    int quality = GetInt(p, "quality", 80);
                    return ScreenshotCapture.CaptureGameView(width, height, cameraPath, format, quality);
                }
                case "screenshot.sceneView":
                {
                    int width = GetInt(p, "width", 1024);
                    int height = GetInt(p, "height", 640);
                    string format = Str(p, "format", "png");
                    int quality = GetInt(p, "quality", 80);
                    return ScreenshotCapture.CaptureSceneView(width, height, format, quality);
                }
                case "screenshot.selected":
                {
                    int width = GetInt(p, "width", 768);
                    int height = GetInt(p, "height", 768);
                    float padding = GetFloat(p, "paddingFactor", 3.5f);
                    string format = Str(p, "format", "png");
                    int quality = GetInt(p, "quality", 80);
                    return ScreenshotCapture.CaptureSelected(width, height, padding, format, quality);
                }
                case "screenshot.editorWindow":
                {
                    int maxWidth = GetInt(p, "maxWidth", 0);
                    return ScreenshotCapture.CaptureEditorWindow(maxWidth);
                }

                case "perf.sample":
                    return PerformanceProbe.Sample();

                case "playmode.enter":
                    return PlayModeControl.Enter();
                case "playmode.exit":
                    return PlayModeControl.Exit();
                case "playmode.step":
                    return PlayModeControl.Step();
                case "playmode.beginStep":
                    return PlayModeControl.BeginStep(p);
                case "playmode.stepStatus":
                    return PlayModeControl.StepStatus();
                case "playmode.status":
                    return PlayModeControl.Status();
                case "playmode.configure":
                    return PlayModeControl.Configure(p);
                case "runtime.findObjects":
                {
                    string query = Str(p, "query", null);
                    string component = Str(p, "component", null);
                    int limit = GetInt(p, "limit", 100);
                    bool includeInactive = GetBool(p, "includeInactive", false);
                    return RuntimeInspector.FindObjects(query, component, limit, includeInactive);
                }
                case "runtime.inspect":
                {
                    int instanceId = GetInt(p, "instanceId", 0);
                    string path = Str(p, "path", null);
                    bool includeFields = GetBool(p, "includeFields", true);
                    return RuntimeInspector.Inspect(instanceId, path, includeFields);
                }
                case "runtime.setField":
                    return RuntimeInspector.SetField(p);

                case "asset.findMissingScripts":
                {
                    int limit = GetInt(p, "limit", 200);
                    return AssetGraph.FindMissingScripts(limit);
                }
                case "asset.findMissingReferences":
                {
                    int limit = GetInt(p, "limit", 200);
                    return AssetGraph.FindMissingReferences(limit);
                }
                case "asset.findReferences":
                {
                    string path = Str(p, "path", null);
                    int limit = GetInt(p, "limit", 500);
                    return AssetGraph.FindReferences(path, limit);
                }
                case "asset.findDependencies":
                {
                    string path = Str(p, "path", null);
                    bool recursive = GetBool(p, "recursive", true);
                    int limit = GetInt(p, "limit", 500);
                    return AssetGraph.FindDependencies(path, recursive, limit);
                }

                case "scene.open":
                    return SceneNavigator.OpenScene(p);
                case "scene.loadAdditive":
                    return SceneNavigator.LoadSceneAdditive(p);

                case "prefab.open":
                    return PrefabStageBridge.OpenPrefab(p);
                case "prefab.save":
                    return PrefabStageBridge.SavePrefab(p);
                case "prefab.applyInstance":
                    return PrefabStageBridge.ApplyInstance(p);

                case "input.simulate":
                    return InputSimulator.Simulate(p);
                case "animator.getState":
                    return AnimatorBridge.GetState(p);
                case "animator.setParameter":
                    return AnimatorBridge.SetParameter(p);
                case "animator.editTransition":
                    return AnimatorBridge.EditTransition(p);

                case "editor.executeMenuItem":
                    return MenuBridge.ExecuteMenuItem(p);

                case "script.read":
                    return ScriptEditor.Read(p);
                case "script.getSha":
                    return ScriptEditor.GetSha(p);
                case "script.findInFile":
                    return ScriptEditor.FindInFile(p);
                case "script.create":
                    return ScriptEditor.Create(p);
                case "script.applyEdits":
                    return ScriptEditor.ApplyTextEdits(p);
                case "script.applyStructuredEdits":
                    return ScriptEditor.ApplyStructuredEdits(p);

                case "code.execute":
                    return CodeExecutor.Execute(p);

                case "reflect.query":
                    return ReflectionBridge.Handle(p);

                case "asset.import":
                    return AssetMutators.ImportAsset(p);
                case "asset.sliceSprite":
                    return AssetMutators.SliceSprite(p);

                case "edit.setSerializedField":
                    return Mutators.SetSerializedField(p);
                case "edit.setTransform":
                    return Mutators.SetTransform(p);
                case "edit.reparent":
                    return Mutators.Reparent(p);
                case "edit.paintTilemap":
                    return TilemapMutators.PaintTilemap(p);
                case "edit.addComponent":
                    return Mutators.AddComponent(p);
                case "edit.createGameObject":
                    return Mutators.CreateGameObject(p);
                case "edit.saveScene":
                    return Mutators.SaveScene(p);
                case "edit.assignReference":
                    return Mutators.AssignReference(p);
                case "edit.wireUiButton":
                    return Mutators.WireUiButton(p);
                case "edit.instantiatePrefab":
                    return AssetMutators.InstantiatePrefab(p);
                case "edit.createScriptableObject":
                    return AssetMutators.CreateScriptableObject(p);
                case "edit.createMaterial":
                    return AssetMutators.CreateMaterial(p);
                case "edit.createPrefabVariant":
                    return AssetMutators.CreatePrefabVariant(p);
                case "edit.deleteGameObject":
                    return Mutators.DeleteGameObject(p);
                case "edit.removeComponent":
                    return Mutators.RemoveComponent(p);
                case "edit.deleteAsset":
                    return AssetMutators.DeleteAsset(p);

                case "console.clear":
                    return ConsoleCapture.Clear();

                case "test.run":
                case "test.status":
                case "test.cancel":
                    throw new HandlerError(
                        "TEST_FRAMEWORK_MISSING",
                        "Unity Test Framework is not installed or its optional UnityVibeOS integration did not load.");

                default:
                    throw new HandlerError("INVALID_ARGUMENT", $"Unknown method: {method}");
            }
        }

    }
}
