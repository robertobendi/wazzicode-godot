# CLAUDE.md — Unity Vibe OS

This repository builds **Unity Vibe OS**, a local Unity-aware operating layer for Claude Code. It exposes Unity project state to Claude through MCP tools (`unity_*`) so Claude does not have to guess from .unity / .prefab YAML or hidden inspector state.

## How to work in this repo

- TypeScript monorepo (pnpm workspaces). Three packages + one CLI app + one Unity Editor package.
- ESM, NodeNext, strict TS. Imports use `.js` extensions even from `.ts` source.
- `pnpm build` builds all packages in topological order.
- `pnpm test` runs vitest (TS source via vite alias — no pre-build needed for tests).
- `node apps/cli/bin/uvibe <command>` runs the CLI.

## How Claude (the agent reading this file) should behave

- **Start a task with `unity_orient`** — one call returns project summary, open scenes, selection, compile status, recent warnings/errors, git status, and brain freshness. Don't issue those as separate reads.
- **After any C# change, prefer `unity_verify`** — it runs wait-for-compile → console errors → tests and returns a single pass/fail verdict in one call (the canonical loop below, collapsed).
- **Batch a known multi-step edit with `unity_batch`** — send the whole plan (e.g. create GameObject → add component → set fields → save) as one call instead of many round trips. Each op is still safety-gated and logged.
- Prefer the `unity_*` MCP tools over reading raw `.unity` / `.prefab` YAML or shelling out to inspect the project.
- When the user says "this object" or "the selected one", call `unity_inspect_selected` first.
- Project and agent access are managed automatically by Unity Vibe Studio. Use the tools directly without asking the user to change permissions or run setup commands.
- Use `unity_check_git_status` before suggesting any change that modifies tracked files.
- Use `unity_generate_project_brain` (or `uvibe brain`) to refresh `.unity-vibe/` after major work.
- Tools are organized into groups (`core`, `scripting`, `reflection`, `runtime`, `testing`, `codegen`) and all are active. Call `unity_manage_tools` to `list_groups` or temporarily activate/deactivate one when you need a smaller tool list. Toggling updates the tool list live (no reconnect).
- `unity_get_scene_hierarchy` is capped at `maxNodes` (default 5000); a big scene returns `truncated:true` (and `childrenOmitted` on depth-clipped nodes) — narrow with `scenePath`/`maxDepth` rather than dumping everything.

### Canonical edit loop (follow this without being told)

After **any** C# change, the fast path is a single `unity_verify` call. It performs the three steps below and returns `{pass, compiled, errorCount, problems, tests}`; use the individual tools only when you need finer control:
1. `unity_wait_for_compile` (it rides through the script-domain reload automatically).
2. `unity_get_console_logs` (level=`warning_or_error`) — confirm no new errors.
3. `unity_run_tests` (EditMode; add PlayMode for runtime behaviour) — this is the ground truth that the code *works*, not just compiles. Use `filter` to scope to the area you touched.

For runtime / "does it actually play" questions:
- `unity_enter_play_mode` → observe with `unity_get_console_logs`, `unity_find_runtime_objects` + `unity_inspect_runtime_object`, `unity_capture_game_view`, and `unity_get_performance_stats` → `unity_exit_play_mode`. To see the Editor itself (panels, inspector, console layout) rather than a camera render, use `unity_capture_editor_window` — it grabs the whole Unity main window from the OS framebuffer. Use `unity_step_frame` to advance deterministically. Profiler counters (draw calls, GC, FPS) only accrue while playing.

For "why is my scene/prefab broken":
- `unity_find_missing_scripts`, `unity_find_missing_references` (dangling links → runtime NREs), and `unity_find_references` / `unity_find_dependencies` to trace the asset graph before deleting/renaming.

For traversing the project / doing layout / editing prefabs:
- `unity_open_scene` and `unity_load_scene_additive` let you move through scenes yourself (they work in `read_only` — navigation isn't a write — but refuse to discard unsaved changes unless `discardUnsavedChanges:true`, returning `UNSAVED_CHANGES`).
- `unity_set_transform` / `unity_reparent` do real positioning/hierarchy work; `unity_paint_tilemap` for 2D levels.
- `unity_open_prefab` enters prefab mode so the scene-edit tools operate on the prefab's own contents; persist with `unity_save_prefab`. `unity_apply_prefab_instance` pushes a scene instance's overrides back to the asset.

For play-testing and animation:
- In play mode, `unity_simulate_input` fires keys/clicks/axes (Input System) and `unity_set_animator_parameter` drives Animator params/triggers; read back with `unity_get_animator_state`. Edit the controller graph with `unity_animator_edit_transition`.

Before writing C# against a Unity/package API, verify it exists (this is the #1 cause of broken compiles):
- `unity_reflect` queries the live loaded assemblies of *this* project (exact Unity + package versions). `action:"search"` finds a type by name; `action:"get_type"` lists its methods/properties/fields + base/interfaces; `action:"get_member"` returns a member's real signatures (incl. overloads). Trust this over memory.
- `unity_docs` fetches the official Scripting API page (prose/usage) for a type or member — best-effort over the network; it returns candidate URLs even when offline.

For writing and editing C# (you can author game code directly — don't hand it back as text for the user to paste):
- Read first: `unity_read_script` returns contents + a `sha256`; pass that back as `preconditionSha256` on the edit so a concurrent change can't be clobbered. `unity_find_in_file` locates a method/field/anchor (line+column) without reading the whole file; `unity_get_script_sha` is a cheap change check.
- Create new files with `unity_create_script` (path under `Assets/`, ending `.cs`).
- Edit existing files three ways, structured → precise: `unity_script_edit` for whole-method/anchor ops (`replace_method`, `insert_method`, `delete_method`, `anchor_insert/replace/delete`, `prepend/append` — brace matching ignores braces inside strings/comments); `unity_apply_text_edits` for exact 1-based line/column range replacements (use when you need byte precision). Both accept `preview:true` to get a unified diff without writing.
- Every write triggers a Unity import → recompile, so finish with `unity_verify`. These are gated by the `script` target (`confirm`/`autopilot` + `allowScriptWrites`, on by default).

`unity_execute_menu_item` is a generic escape hatch for any Editor command, but it only runs paths you've whitelisted (`allowMenuItems:true` + `allowedMenuItems` in config); otherwise it returns `MENU_ITEM_NOT_ALLOWED`. The 2D/asset pipeline tools are `unity_import_asset` and `unity_slice_sprite`.

`unity_execute_code` compiles and runs a C# snippet *inside* the Editor (the snippet is the body of `static object Execute()`; `return` a value to get it back, and logs are captured). Reach for it for one-off Editor automation that has no dedicated tool — bulk operations, recomputing data, probing an API — instead of writing a throwaway script. Studio makes it available automatically and protects the task with checkpoints and an action log. It needs the project's Api Compatibility Level set to ".NET Framework"; otherwise it returns `FEATURE_UNAVAILABLE` and you should use `unity_create_script` + `unity_verify` instead.

### Editor focus

- The bridge keeps Unity processing tool calls (and running play mode) even when the Editor window is **not focused**, so you don't have to click into Unity for compiles, play-mode steps, or captures to proceed. This "Keep Unity Awake" driver is on by default; the user can toggle it under `Window ▸ Unity Vibe OS ▸ Keep Unity Awake (background)` (it costs some background CPU). If a user reports tool calls only completing when they click Unity, that toggle is off.

### Claude Code integration

This server is built for Claude Code specifically and leans on MCP features Claude Code surfaces natively:
- **Server instructions** (`SERVER_INSTRUCTIONS` in `packages/mcp-server/src/instructions.ts`) — sent to Claude Code on connect, so the agent learns the toolset + canonical workflows *in the user's Unity project* (where there's no wazzicode CLAUDE.md). This is what lets the user "just write prompts" and trust the agent knows the tools. A test asserts every tool it names actually exists.
- **Tool annotations** — every tool advertises `readOnlyHint`/`destructiveHint`/`idempotentHint`, so read-only tools (orient, inspect, find, capture, reflect) can be auto-approved while hard-to-undo writes (script edits, `unity_execute_code`, menu items, saves) are flagged. Additive, Undo-wrapped scene edits are intentionally *not* marked destructive.
- **Slash commands (MCP prompts)** — `/mcp__unity-vibe-os__orient`, `…__diagnose_scene`, `…__analyze_scene`, `…__verify`, `…__new_script`, and `…__play_test` expand to the matching tool workflow.
- **`@`-mentionable resources** — `unity://project-brain`, `unity://conventions`, `unity://action-log`, and live `unity://scene-hierarchy` / `unity://console`.

### When the bridge is unavailable

- `UNITY_RELOADING` — the bridge is mid script-domain reload (post-compile or entering play). It is **recoverable**; tool calls already retry for ~20s. Just wait; don't treat it as fatal.
- `UNITY_NOT_CONNECTED` — no Unity Editor with the UnityVibeOS package is running for this project. Ask the user to open Unity, then `uvibe doctor`.
- `UNITY_EDITOR_STALLED` — Unity's editor loop is frozen (window unfocused with "Keep Unity awake (background)" off or the package too old to have it). Retrying is useless: nothing progresses until Unity wakes. Stop and ask the user to focus the Unity window or enable `Window ▸ Unity Vibe OS ▸ Keep Unity awake (background)`. The client detects this via the bridge's GET `/health` (served off the main thread, so it answers even while frozen) and `unity_orient` warns up front when keep-awake is off.
- `PROJECT_IDENTITY_MISMATCH` — a Unity Editor answered but for a different project (the client auto-discovers the bridge via `Library/UnityVibeOS/bridge.json` and verifies project identity). Ask the user to open the correct project.
- `TEST_FRAMEWORK_MISSING` — `unity_run_tests` needs `com.unity.test-framework`; suggest installing it.

## Useful CLI

- `uvibe doctor` — health check (MCP, bridge, brain, git, config).
- `uvibe brain` — refresh project brain.
- `uvibe verify --mock` — MVP acceptance checks against the mock bridge.
- `uvibe mcp-config` — print Claude MCP config snippet. `--target=codex` prints the `[mcp_servers.*]` TOML block (plus the `codex mcp add` one-liner) for the OpenAI Codex CLI, which reads TOML rather than `.mcp.json`.
- `uvibe init` — create `.unity-vibe/` scaffold.
- `uvibe serve` — start the MCP server (used in your Claude config).

## Agent backends (desktop app)

Unity Vibe Studio (`apps/desktop`) can drive **either** Claude Code (`claude -p --output-format stream-json`) or the **OpenAI Codex CLI** (`codex exec --json`), selectable in Settings. Both speak the same MCP server, so Unity capability is identical. The abstraction lives in `apps/desktop/src-tauri/src/agent/` (`Backend` enum → binary + argv + stream-capture rules); the webview's `streamMapper.ts` reduces *both* JSON vocabularies into one `StreamDraft` by dispatching on the line's own `type` (they're disjoint), so no UI code knows which CLI ran.

Four Codex-specific gotchas, all already handled — don't "fix" them back:
- Codex takes MCP servers as **TOML `-c` overrides**, not a `--mcp-config` file, and Windows paths must be TOML *literal* strings (`'C:\x'`); a basic string makes `\U` an invalid escape and the whole config fails to parse.
- `codex exec resume` **re-declares** `--json`, `--skip-git-repo-check`, `-m` and `-c`, so they are not clap-global: those flags must be emitted *after* the `resume` subcommand or they bind to `exec` and are ignored (which would silently disable JSONL on every resumed turn). Studio's non-interactive bypass flag also follows the subcommand and is shared by fresh/resumed runs.
- Codex reports **tokens, not USD**. `cost_usd` stays `None` (never `Some(0.0)`), and the auto-loop disables its budget cap + warns rather than pretending every turn was free.
- **Subscription only.** The app never offers an API-key sign-in, and `agent::spawn` strips `OPENAI_API_KEY`/`CODEX_API_KEY` from every Codex child (`codexauth::scrub_api_key`) so a stray env var can't silently bill API credits instead of the user's ChatGPT plan.

### Dictation

The desktop composer has a mic: a quantized Whisper runs locally in a Web Worker (ONNX Runtime + WASM) — offline, no credits, no native binary. The model and runtime are vendored into `apps/desktop/public/` by `pnpm --filter @uvibe/desktop bundle:whisper` and are **gitignored**; when absent, the mic button hides itself rather than failing. Code lives in `apps/desktop/src/lib/dictation/`.

## Internal planning

Plan / phase / status / verify / decisions live in `.planning/`. The format mirrors GSD; this repo does not require a GSD CLI.

## Limits

- Unity Editor APIs cannot run from this shell. The Unity package compiles against documented APIs and follows standard idioms; runtime verification is the user's job (see `docs/UNITY_MANUAL_TEST_CHECKLIST.md`).
- Write tools are wired and gated by `safetyMode` (per-target flags in `.unity-vibe/config.json`):
  - **scene** (`allowSceneWrites`): `unity_set_serialized_field`, `unity_set_transform`, `unity_reparent`, `unity_assign_reference`, `unity_add_component`, `unity_create_gameobject`, `unity_instantiate_prefab`, `unity_paint_tilemap`, `unity_wire_ui_button`, `unity_delete_gameobject`, `unity_remove_component`, `unity_save_scene`.
  - **prefab** (`allowPrefabWrites`): `unity_create_prefab_variant`, `unity_save_prefab`, `unity_apply_prefab_instance`.
  - **asset** (`allowAssetWrites`, default true): `unity_create_scriptable_object`, `unity_create_material`, `unity_import_asset`, `unity_slice_sprite`, `unity_animator_edit_transition`, `unity_delete_asset`.
  - **script** (`allowScriptWrites`, default true): `unity_create_script`, `unity_apply_text_edits`, `unity_script_edit`. Read-side `unity_read_script`/`unity_get_script_sha`/`unity_find_in_file` are ungated. Script writes hit disk and trigger a recompile (not Unity-Undoable — recovery is git / autoSnapshot), so follow with `unity_verify`.
  - **console**: `unity_clear_console`. **editor** (`allowMenuItems` + `allowedMenuItems` allowlist): `unity_execute_menu_item`.
  - Non-write but state-touching: `unity_open_scene`/`unity_load_scene_additive`/`unity_open_prefab` (navigation; allowed in `read_only`, guarded against discarding unsaved changes) and `unity_simulate_input`/`unity_set_animator_parameter`/`unity_get_animator_state` (runtime/ephemeral).
  - Studio enables the tools automatically. Scene/prefab mutations are wrapped in Unity's Undo system (Ctrl+Z); asset/script writes recover through the pre-task git checkpoint or automatic snapshot. Every write is recorded to `.unity-vibe/action_log.jsonl`.
- The Test Framework integration lives in a separate assembly guarded by `UNITY_INCLUDE_TESTS`, so the core bridge still compiles when `com.unity.test-framework` is absent.
