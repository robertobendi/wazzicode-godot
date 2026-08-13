# Unity package — UnityVibeOS

Editor-only C# package living at `unity/UnityVibeOS/`. Installs as `com.uvibe.os` in any Unity 2021.3+ project.

## Files

| File | Purpose |
|---|---|
| `package.json` | Unity package manifest |
| `Editor/UnityVibeOS.Editor.asmdef` | Editor-only assembly |
| `Editor/MiniJson.cs` | Tiny dependency-free JSON encoder + decoder |
| `Editor/MainThreadDispatcher.cs` | Drains queued actions on `EditorApplication.update` (time-budgeted: ~8ms/tick, 256-action safety cap) |
| `Editor/BridgeServer.cs` | `HttpListener` on `127.0.0.1:38578`, JSON-RPC dispatch + long-poll awaits |
| `Editor/BridgeRouter.cs` | Method → handler map |
| `Editor/EditorStateMirror.cs` | Volatile thread-safe snapshot of compile/play state, refreshed each editor tick (read by long-poll probes off the main thread) |
| `Editor/ProjectInfo.cs` | Unity version, paths, packages, render pipeline |
| `Editor/ConsoleCapture.cs` | Bounded ring buffer fed by `Application.logMessageReceivedThreaded` |
| `Editor/CompileWatcher.cs` | Compile state via `UnityEditor.Compilation.CompilationPipeline` |
| `Editor/SceneInspector.cs` | Open scenes + hierarchy |
| `Editor/SelectionInspector.cs` | Active GameObject inspection (transform, components, fields, prefab info) |
| `Editor/SerializedReader.cs` | `SerializedObject` → JSON-friendly dict; encodes object refs |
| `Editor/ScreenshotCapture.cs` | Game view, Scene view, and selected-object capture → base64 PNG |
| `Editor/MenuItems.cs` | `Window → Unity Vibe OS → {Status, Restart Bridge, Stop, Start}` |

## Threading

`HttpListener` callbacks run on the threadpool. All Unity Editor APIs require the main thread. Each request:

1. Listener thread reads body, parses JSON.
2. Pushes a closure to `MainThreadDispatcher`.
3. Listener thread blocks on `ManualResetEventSlim` (per-method timeout, 15s default).
4. `EditorApplication.update` drains the queue, runs the handler, sets the event.
5. Listener thread serializes and writes the response.

### Long-poll awaits

`compile.await`, `playmode.await`, `test.await`, and multi-frame `playmode.step` are special-cased
**before** main-thread dispatch: the HTTP thread waits (≈50ms probes against `EditorStateMirror` /
other volatile state, capped at 25s per request) until the condition flips, then fetches the
authoritative status payload on the main thread and returns it with a `settled` flag. This means
the MCP client makes one call and gets the answer the moment a compile / play transition / test run
finishes, instead of polling every 400–1000ms. The Editor main thread is never blocked by a wait.
Optional assemblies register their own awaits via `BridgeServer.RegisterAwait` (the Test Framework
integration registers `test.await`).

## Routes

| Route | Purpose |
|---|---|
| `POST /rpc` | JSON-RPC envelope (the bridge protocol) |
| `GET /health` | Cheap liveness probe; returns `{status, unityVersion, projectPath, uptimeMs}` |
| `OPTIONS *` | Permits localhost CORS for future dashboard use |

Bound only to `127.0.0.1`. No external network exposure.

## Lifecycle

- `[InitializeOnLoad]` schedules `BridgeServer.Start()` via `EditorApplication.delayCall` so static-init order is settled.
- `AssemblyReloadEvents.beforeAssemblyReload` and `EditorApplication.quitting` call `Stop()` to release the port.
- `Window → Unity Vibe OS → Restart Bridge` recreates the listener.

## Console capture limitations

- Logs emitted **before** `ConsoleCapture` static ctor runs are not retained. Documented; see manual checklist.
- The buffer is in-memory only; reset on assembly reload.
- The capture hook does not include early Editor warnings or some compile-time messages — those live in the Editor log file (Unity-version-dependent location).

## Compile state

`UnityEditor.Compilation.CompilationPipeline` provides `compilationStarted`, `compilationFinished`, and `assemblyCompilationFinished(name, CompilerMessage[])` events. Messages from the latest pass are aggregated. The live `EditorApplication.isCompiling` boolean is used as the `isCompiling` field, which is accurate at any moment.

## Screenshot capture

`ScreenshotCapture.cs` exposes three methods:

- **Game view** (`screenshot.gameView`): finds `Camera.main`, falls back to the highest-`depth` enabled active Camera, then renders into a temporary `RenderTexture` and encodes PNG. Works in edit mode (no Play mode required).
- **Scene view** (`screenshot.sceneView`): renders `SceneView.lastActiveSceneView.camera` (or the first SceneView if none is active). Returns `OBJECT_NOT_FOUND` when no SceneView exists.
- **Selected** (`screenshot.selected`): walks `Renderer` bounds of the selection, spawns a `HideAndDontSave` temporary camera, frames a 3/4 view, renders, then `DestroyImmediate`s the camera. For prefab assets, prefers `AssetPreview.GetAssetPreview` to avoid spawning a camera.

Camera renders accept `format: "png" | "jpg"` (+ `quality`, default 80) — JPEG payloads are ≈10x smaller, which matters when capturing repeatedly in play-test loops. The editor-window grab stays PNG so panel text remains legible. Images are returned as base64 strings inside the bridge envelope. The MCP server detects this and emits a multimodal `image` content block alongside the JSON envelope so Claude actually sees the frame.

## Beyond this doc

Play-mode control (including the update-driven multi-frame stepper in `PlayModeControl`), runtime
inspection, input simulation, the animator bridge, the test runner, and all write methods live in
the files listed above; see `docs/MCP_TOOLS.md` for the full tool surface.
