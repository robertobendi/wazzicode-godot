# MCP tools

All tools return a `ToolEnvelope`. Success:

```json
{ "ok": true, "data": {...}, "warnings": [],
  "meta": { "source": "unity_bridge|mock|git|project_brain|filesystem",
            "durationMs": 0, "detailLevel": "summary|normal|full" } }
```

Failure:

```json
{ "ok": false,
  "error": { "code": "STABLE_CODE", "message": "...", "recoverable": true, "suggestedAction": "..." },
  "meta": { ... } }
```

Stable error codes: `UNITY_NOT_CONNECTED`, `UNITY_COMPILING`, `UNITY_RELOADING`, `TEST_FRAMEWORK_MISSING`, `PLAY_MODE_REQUIRED`, `PROJECT_IDENTITY_MISMATCH`, `FEATURE_UNAVAILABLE`, `OBJECT_NOT_FOUND`, `ASSET_NOT_FOUND`, `INVALID_ARGUMENT`, `SAFETY_MODE_BLOCKED`, `WRITE_REQUIRES_SNAPSHOT`, `UNSUPPORTED_UNITY_VERSION`, `INTERNAL_ERROR`, `MOCK_MODE_ACTIVE`, `BRIDGE_TIMEOUT`, `MALFORMED_BRIDGE_RESPONSE`, `TOOL_NOT_IMPLEMENTED`, `PROJECT_NOT_FOUND`, `GIT_NOT_AVAILABLE`.

## Implemented (73 tools)

### Context & inspection

| Tool | Source | Notes |
|---|---|---|
| `unity_project_summary` | `unity_bridge` | Unity version, render pipeline, input system, build target, packages |
| `unity_get_open_scenes` | `unity_bridge` | Per-scene path/name/dirty/loaded/buildIndex; activeScene |
| `unity_get_scene_hierarchy` | `unity_bridge` | Tree of `{name,path,active,childCount,components?,children?}` |
| `unity_inspect_selected` | `unity_bridge` | Full inspector view of `Selection.activeGameObject` including serialized fields |
| `unity_get_console_logs` | `unity_bridge` | Logs captured since package load (Application.logMessageReceivedThreaded) |
| `unity_wait_for_compile` | `unity_bridge` | Waits server-side (`compile.await` long-poll) until idle or timeout; falls back to client-side `compile.status` polling on older Unity packages |
| `unity_check_git_status` | `git` | Runs `git status --porcelain=v2` in the project dir |
| `unity_orient` | mixed | One-call live Unity/git bootstrap plus freshness reconciliation and task-relevant project-map matches |
| `unity_query_project_brain` | `project_brain` | Bounded search over source-backed entities, facts, provenance, and graph neighbors; refreshes first |
| `unity_generate_project_brain` | `project_brain` | Explicit filesystem rebuild of `.unity-vibe/knowledge/` and compatibility summaries |

### Visual

| Tool | Source | Notes |
|---|---|---|
| `unity_capture_game_view` | `unity_bridge` | Renders `Camera.main` (or specified) off-screen. Returns multimodal **image** content (base64 PNG, or JPEG via `format:"jpg"` — ≈10x smaller). Auto-saves to `.unity-vibe/screenshots/`. |
| `unity_capture_scene_view` | `unity_bridge` | Renders `SceneView.lastActiveSceneView` camera. Multimodal image. |
| `unity_capture_selected` | `unity_bridge` | Spawns a temporary HideAndDontSave camera framing the selection's bounds; falls back to `AssetPreview` for prefab assets. Multimodal image. |
| `unity_capture_editor_window` | `unity_bridge` | Captures the **whole Editor main window** (all docked panels — toolbar, Hierarchy, Scene/Game view, Inspector, Project, Console) from the OS framebuffer via `InternalEditorUtility.ReadScreenPixel`, not a camera render. Optional `maxWidth` downscales (longest side); omit for native resolution. Multimodal image. |

Screenshot tools return `{source, width, height, mimeType, pngBase64, savedTo?, cameraName?, subject?}`. The MCP server detects `pngBase64` and emits an `image` content block alongside the JSON envelope so Claude sees the actual pixels — not just a data URL string.

### Performance

| Tool | Source | Notes |
|---|---|---|
| `unity_get_performance_stats` | `unity_bridge` | Reads Unity's own `Unity.Profiling.ProfilerRecorder` counters (main-thread ms + estimated FPS, draw calls, batches, SetPass calls, triangles, vertices, per-frame GC alloc, memory), averaged over a rolling frame window. Recorders run always-on; data is richest in play mode. |

### Tests (Unity Test Framework)

| Tool | Source | Notes |
|---|---|---|
| `unity_run_tests` | `unity_bridge` | Runs EditMode/PlayMode tests and returns structured pass/fail + messages/stack traces. Starts the run then waits server-side (`test.await` long-poll) to completion, surviving the PlayMode domain reload (run state held in `SessionState`); falls back to `test.status` polling on older packages. Returns `TEST_FRAMEWORK_MISSING` if the package is absent. |

### Play mode & runtime inspection

| Tool | Source | Notes |
|---|---|---|
| `unity_enter_play_mode` | `unity_bridge` | Enters play mode; with `waitForReady` waits (server-side `playmode.await` long-poll) through the domain reload until running. |
| `unity_exit_play_mode` | `unity_bridge` | Exits to edit mode. |
| `unity_step_frame` | `unity_bridge` | Advances 1+ frames (pauses the game) — multi-frame steps run inside the Editor in a single call. Requires play mode → else `PLAY_MODE_REQUIRED`. |
| `unity_get_play_mode_status` | `unity_bridge` | isPlaying / isPaused / isTransitioning / frameCount. |
| `unity_find_runtime_objects` | `unity_bridge` | Finds live GameObjects by name substring and/or component (sees runtime-spawned objects in play mode). |
| `unity_inspect_runtime_object` | `unity_bridge` | Full live state of one object by instanceId or path — actual runtime values, not edit-time defaults. |

### Asset / reference graph (read-only)

| Tool | Source | Notes |
|---|---|---|
| `unity_find_missing_scripts` | `unity_bridge` | Prefabs + open scenes with missing MonoBehaviour scripts. |
| `unity_find_missing_references` | `unity_bridge` | Dangling serialized object references (the usual cause of runtime NREs). |
| `unity_find_dependencies` | `unity_bridge` | Assets a given asset uses (`AssetDatabase.GetDependencies`, recursive by default). |
| `unity_find_references` | `unity_bridge` | Reverse lookup: assets that use a given asset ("what breaks if I delete this?"). |

### Write (gated by `safetyMode`)

| Tool | Target | Notes |
|---|---|---|
| `unity_set_serialized_field` | scene | Set a component field via `SerializedObject`, recorded as an Undo step. |
| `unity_assign_reference` | scene | Wire an object-reference field to a scene object/component or an asset; verifies type compatibility. |
| `unity_add_component` | scene | `Undo.AddComponent` on a scene object. |
| `unity_create_gameobject` | scene | Create an empty or primitive GameObject, optionally parented. |
| `unity_instantiate_prefab` | scene | Instantiate a prefab into the active scene as a linked instance. |
| `unity_wire_ui_button` | scene | Add a persistent `Button.onClick` listener calling a component method (UGUI accessed reflectively — no hard dependency). |
| `unity_delete_gameobject` | scene | Delete a GameObject (and its children) from the active scene, recorded as an Undo step. |
| `unity_remove_component` | scene | Remove a component from a scene GameObject (Undo-wrapped; refuses the Transform). |
| `unity_create_scriptable_object` | asset | Create a ScriptableObject asset of a named type under `Assets/`. |
| `unity_create_material` | asset | Create a Material asset with a shader (pipeline default if unspecified). |
| `unity_delete_asset` | asset | Delete an asset file (to the OS trash by default, recoverable; `permanent:true` removes it outright). |
| `unity_create_prefab_variant` | prefab | Create a prefab variant of an existing prefab. |
| `unity_save_scene` | scene | Save an open scene (snapshotted first when `autoSnapshot` is on). |
| `unity_clear_console` | console | Clear the Editor console + the bridge log buffer. |

Studio-managed projects make write tools available automatically. Before dispatch, the MCP server still checks `gateTool()`, snapshots affected files where applicable, runs the mutation, and appends an entry to `.unity-vibe/action_log.jsonl`. Every Unity-side mutation is wrapped in the Editor Undo system. See `docs/SAFETY_MODEL.md`.

Every tool supports a `detailLevel` input of `summary | normal | full` (default `normal`). The hierarchy tool also accepts `maxDepth` and `includeComponents`.

## Bridge methods (server-internal)

| Method | Purpose |
|---|---|
| `system.health` | Liveness probe |
| `system.summary` | Project metadata |
| `scene.getOpenScenes` | Open scenes list |
| `scene.getHierarchy` | Hierarchy tree |
| `selection.inspect` | Active selection |
| `console.getLogs` | Console buffer |
| `compile.status` | Compile state |
| `screenshot.gameView` | Render Camera.main / specified Camera as PNG |
| `screenshot.sceneView` | Render the active SceneView camera as PNG |
| `screenshot.selected` | Render the active selection from a temp camera |
| `perf.sample` | Read averaged ProfilerRecorder counters |
| `test.run` / `test.status` / `test.cancel` | Test Framework run lifecycle (registered dynamically by the optional `UnityVibeOS.TestRunner.Editor` assembly) |
| `playmode.enter` / `.exit` / `.step` / `.status` | Play-mode state machine |
| `runtime.findObjects` / `runtime.inspect` | Live object discovery + inspection |
| `asset.findMissingScripts` / `.findMissingReferences` / `.findReferences` / `.findDependencies` | Asset/reference graph |
| `edit.setSerializedField` / `.addComponent` / `.createGameObject` / `.saveScene` / `.assignReference` / `.wireUiButton` / `.deleteGameObject` / `.removeComponent` | Scene mutators (Undo-wrapped) |
| `edit.instantiatePrefab` / `.createScriptableObject` / `.createMaterial` / `.createPrefabVariant` / `.deleteAsset` | Asset/prefab mutators |
| `console.clear` | Clear console + capture buffer |

`BridgeRouter` checks a dynamic handler table first (so optional assemblies like the Test Framework integration can register `test.*` without the core needing a compile-time reference) and falls back to the built-in switch. `console.clear` is reserved for a future `unity_clear_console` tool but isn't routed yet.

## Reliability

- **Bridge discovery:** the Unity bridge writes `Library/UnityVibeOS/bridge.json` (`{port, host, projectPath, unityVersion, pid, ...}`) on start. The MCP client reads it to learn the actual bound port and to verify it is talking to the right project (`PROJECT_IDENTITY_MISMATCH` otherwise). The port auto-increments if the default is busy, so two Editor instances don't collide.
- **Reload survival:** entering play mode or recompiling reloads the C# domain and briefly drops the bridge socket. Because the discovery file persists, the client maps connection-refused-while-known to the recoverable `UNITY_RELOADING`, and `bridgeCall` retries for ~20s — so tool calls simply resume once Unity is back.
- **Per-method timeouts:** the Unity main-thread handler budget is method-aware (15s default, up to 120s for asset-graph scans and 60s for play-mode transitions).

## Planned (post-MVP)

These are designed but not yet exposed. They follow the same envelope.

**Core context:** `unity_project_brain`, `unity_get_conventions`, `unity_update_conventions`, `unity_get_recent_changes`, `unity_get_current_task_context`.

**Scene:** `unity_list_scenes`, `unity_open_scene`, `unity_inspect_gameobject`, `unity_find_objects`, `unity_find_objects_with_component`, `unity_find_objects_missing_component`, `unity_diagnose_scene`.

**Asset:** `unity_find_asset`, `unity_inspect_asset`, `unity_find_references`, `unity_find_dependencies`, `unity_list_scriptable_objects`, `unity_inspect_scriptable_object`, `unity_find_missing_references`, `unity_find_missing_scripts`, `unity_find_duplicate_assets`, `unity_find_probably_unused_assets`.

**Prefab:** `unity_inspect_prefab`, `unity_find_prefabs_with_component`, `unity_find_prefabs_using_script`, `unity_compare_prefab_instance`, `unity_get_prefab_overrides`, `unity_diagnose_prefab`.

**Console/compile/build:** `unity_clear_console`, `unity_get_compile_errors`, `unity_run_specific_test`, `unity_get_build_settings`, `unity_build_player`, `unity_get_build_errors`. (EditMode/PlayMode test running ships now via `unity_run_tests`.)

**Runtime:** `unity_pause_play_mode`, `unity_watch_value`, `unity_get_runtime_snapshot`, `unity_simulate_input`. (`enter`/`exit`/`step`/`find`/`inspect` ship now.)

**Visual:** `unity_capture_prefab_preview`, `unity_capture_ui_canvas`.

**Edit:** the full first-wave edit set ships now — `set_serialized_field`, `assign_reference`, `add_component`, `create_gameobject`, `instantiate_prefab`, `wire_ui_button`, `create_scriptable_object`, `create_material`, `create_prefab_variant`, `save_scene`, `clear_console`.

**Safety:** `unity_create_snapshot`, `unity_list_snapshots`, `unity_restore_snapshot`, `unity_list_ai_actions`, `unity_revert_last_action`, `unity_show_pending_changes`, `unity_set_safety_mode`. (Snapshot + action-log primitives exist in `packages/safety` and the action log is written on every gated write; these expose them as tools.)

**Asset/prefab/diagnostic/workflows:** `unity_find_duplicate_assets`, `unity_find_probably_unused_assets`, prefab inspection/diff tools, the `unity_diagnose_*` composites, and the `*_workflow` recipes — all compositions of the primitives above.

The shipped surface deliberately closes the agent's core loops — *observe → act → verify* (compile, console, **tests**, **play mode**, **performance**) and *diagnose* (missing scripts/refs, dependency graph) — before adding breadth. Remaining items are mostly compositions of these primitives.
