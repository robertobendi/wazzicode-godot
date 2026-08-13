# Unity Vibe OS

**Make Claude Code see and edit your Unity project.**

A local MCP server + Unity Editor package + project brain. Claude Code gets **60+ live `unity_*` tools** — inspect scenes, **write & verify C#**, run play mode, edit prefabs, and literally **see** your Game and Scene views via real screenshots. Editing works immediately; changes are checkpointed, Undo-able, and action-logged. Everything runs on `127.0.0.1`.

---

## 🚀 Use it (3 steps)

### Step 1 — Install (one command)

Paste this prompt into Claude Code from anywhere:

> **Install Unity Vibe OS into my Unity project. Run exactly:**
> `node /ABS/PATH/TO/wazzicode-unity/bootstrap.mjs /ABS/PATH/TO/MyUnityProject`
> **It's idempotent. When it finishes, tell me the next steps.**

Or run it yourself:

```bash
node /ABS/PATH/TO/wazzicode-unity/bootstrap.mjs /ABS/PATH/TO/MyUnityProject
```

That single command installs deps, builds, drops the Unity package into `Packages/manifest.json`, generates `.unity-vibe/`, writes a per-project `.mcp.json` (Claude Code auto-discovers it), and updates both `CLAUDE.md` and `AGENTS.md` with usage rules for Claude Code and Codex. Idempotent — safe to re-run and preserves your existing instructions.

### Step 2 — Open Unity, restart Claude Code

```bash
# 1. Open the Unity project in Unity Editor — bridge auto-starts at 127.0.0.1:38578
# 2. Then in your terminal:
cd /ABS/PATH/TO/MyUnityProject
claude       # approve the unity-vibe-os MCP server when prompted
```

Optionally: `claude mcp list` to confirm.

### Step 3 — Talk to Claude in your Unity project

Claude already read your `CLAUDE.md` and knows the workflow. Just ask:

```
What's open in Unity? What's selected? Show me the game view.
```

```
Are there any compile errors right now? Walk me through fixing them.
```

```
Inspect the selected object, capture it, and suggest three improvements.
```

```
Write a PlayerController that moves with WASD and jumps. Verify it compiles and passes tests.
```

```
Refresh the project map, then show me its coverage and main systems.
```

```
Why is the player not shooting? Diagnose with whatever Unity tools you have.
```

That's it.

---

## 🧭 Session init prompt (optional)

The MCP server already briefs Claude on the full toolset when it connects (see `SERVER_INSTRUCTIONS` in `packages/mcp-server/src/instructions.ts`), so you don't *need* a setup prompt. If you want to pin your house style and a hard "orient first / verify after" habit, paste this at the start of a session in your Unity project:

```text
This project has the unity-vibe-os MCP server connected — live unity_* tools over the running Unity Editor. The server briefs you on the full toolset on connect, so follow that; this is just my house style.

- Start every task with unity_orient and pass the current request as `task` (one call: project-map matches, summary, open scenes, selection, compile status, errors, git). Use unity_query_project_brain for deeper project questions. UNITY_NOT_CONNECTED → tell me to open the Unity Editor and stop. UNITY_RELOADING → just retry, it's mid-compile.
- Before writing C# against any Unity/package API, confirm it exists with unity_reflect. You can author code directly (unity_create_script / unity_apply_text_edits / unity_script_edit) — don't hand me code to paste.
- After ANY C# change, run unity_verify (compile → console → tests, one verdict). Don't claim it works until it passes.
- "this object" / "the selected one" → unity_inspect_selected first.
- "Does it play right?" → enter play mode, observe with console / unity_find_runtime_objects / unity_capture_game_view / perf stats, then exit. You can SEE the game via the screenshot tools.
- "Why is it broken?" → unity_find_missing_scripts / unity_find_missing_references / unity_find_references before deleting or renaming.
- Project access is managed automatically. Use the Unity tools directly without asking me to change permissions or run setup commands. Every task gets a checkpoint, and scene/prefab changes are Undo-able and logged.

Do the unity_orient check, then wait for my task.
```

Handy in-session shortcuts: slash commands `/mcp__unity-vibe-os__orient | analyze_scene | diagnose_scene | verify | new_script | play_test`, and `@unity://project-brain` / `@unity://scene-hierarchy` to pull context.

---

## 🧰 Sample prompts you'll use again

### Sanity / health
```
Run `uvibe doctor` and tell me if anything is red.
```
```
Run `uvibe verify --mock` to confirm the tools are wired without Unity.
```

### After a `git pull` of this repo
```
Re-run: node /ABS/PATH/TO/wazzicode-unity/bootstrap.mjs /ABS/PATH/TO/MyUnityProject --rebuild
```

### Daily Unity work
```
Compile, then check console for warnings/errors. Summarize anything new.
```
```
Show me the scene view. What's wrong with the framing?
```
```
List the prefabs and scenes that depend on the WeaponData ScriptableObject.
```
```
Refactor the TakeDamage method in @Assets/Scripts/Health.cs to clamp at zero, then verify.
```
```
Enter play mode, press jump a few times, capture the game view, and tell me if it feels right.
```

---

## 🛠 What ships

- **MCP server** with **73 tools** across groups (`core`, `scripting`, `reflection`, `runtime`, `testing`, `codegen`):
  - **Orientation & inspection** — `unity_orient` (one-call status), `unity_get_scene_hierarchy`, `unity_inspect_selected`, `unity_get_console_logs`, `unity_wait_for_compile`, `unity_check_git_status`.
  - **See it** — multimodal screenshots `unity_capture_game_view` / `unity_capture_scene_view` / `unity_capture_selected` / `unity_capture_editor_window` return real images.
  - **Write & edit C#** — `unity_read_script`, `unity_find_in_file`, `unity_create_script`, `unity_apply_text_edits`, `unity_script_edit`; verify with `unity_verify` (compile → console → tests in one call).
  - **Don't hallucinate APIs** — `unity_reflect` (live type system of *your* Unity + packages) and `unity_docs`.
  - **Build scenes/prefabs** — create GameObjects, add components, set/assign fields, transforms, instantiate prefabs, paint tilemaps, prefab mode, wire UI buttons, materials/ScriptableObjects, plus delete GameObjects / remove components / delete assets — 27 gated write tools, each Undo-able (or recoverable) and logged. `unity_batch` bundles a multi-step plan into one call.
  - **Play mode & runtime** — enter/exit/step, inspect runtime objects, simulate input, drive the Animator, read performance stats.
  - **Editor automation** — `unity_execute_code` (run C# in the Editor) and `unity_manage_tools` (toggle tool groups live).
- **Claude Code native** — server instructions teach the toolset on connect, MCP slash commands (`/mcp__unity-vibe-os__orient | analyze_scene | diagnose_scene | verify | new_script | play_test`), `@`-mentionable resources (`unity://project-brain | conventions | action-log | scene-hierarchy | console`), and tool annotations so reads auto-run and risky writes are flagged.
- **Unity Editor package** (`unity/UnityVibeOS`) — localhost HTTP JSON-RPC bridge, scene/selection inspectors, console + compile watch, screenshots, scene/prefab/asset mutators, script editor, reflection, in-Editor C# execution, test runner, play-mode control. Survives domain reloads; keeps working when the Editor is unfocused.
- **CLI** (`uvibe`) — `setup`, `init`, `serve`, `brain`, `doctor`, `verify`, `mcp-config`, `install-unity-package`, `gsd-auto`.
- **Project map** — automatically refreshed, source-backed entity/relationship graph under `.unity-vibe/knowledge/`, bounded MCP queries, and a searchable Studio visualizer; no running Unity Editor required to scan.
- **Mock bridge** — every MCP tool works without Unity for testing.
- **Recovery layer** — app-managed access is ready by default, with pre-task git checkpoints, Unity Undo, automatic snapshots, and an action log.

---

## 🆘 If something's off

```
Run `uvibe doctor` and follow the suggestions it prints.
```

Common fixes:

- **Bridge unreachable** → open the Unity project in Unity Editor (the `com.uvibe.os` package was added by the bootstrap; bridge auto-starts on Editor load).
- **Claude doesn't see the tools** → `cd` into the Unity project and restart Claude Code; approve the `unity-vibe-os` server when prompted.
- **`tsc` errors after a pull** → re-run with `--rebuild`.
- **Port 38578 in use** → see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## 📂 Repo layout

```
bootstrap.mjs              one-command install
apps/cli/                  uvibe CLI (TypeScript)
packages/core/             protocol, schemas, errors, envelope
packages/mcp-server/       MCP server, bridge client, mock bridge, 66 tools,
                           tool groups, annotations, prompts, resources, instructions
packages/project-brain/    Unity-project detector + brain generator
packages/safety/           config, safety modes + per-target gates, snapshot + action log
unity/UnityVibeOS/         Unity Editor package (C#) — installs in Unity projects
docs/                      architecture, MCP tools, Unity package, safety, manual checklist
.planning/                 plan/phases/status/verify/decisions (GSD-style)
tests/                     vitest tests + sample Unity fixture
examples/                  example MCP config and brain
INSTALL.md                 install detail (prerequisites, flags, uninstall)
```

---

## 📚 Docs

- [`INSTALL.md`](INSTALL.md) — install detail, flags, uninstall
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture
- [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md) — MCP tool reference (implemented + planned)
- [`docs/UNITY_PACKAGE.md`](docs/UNITY_PACKAGE.md) — Unity package internals
- [`docs/SAFETY_MODEL.md`](docs/SAFETY_MODEL.md) — safety modes, snapshots, action log
- [`docs/PROJECT_BRAIN.md`](docs/PROJECT_BRAIN.md) — what the project brain captures
- [`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md) — dev loop
- [`docs/GSD_AUTOMATION.md`](docs/GSD_AUTOMATION.md) — internal GSD-style workflow
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — common issues
- [`docs/UNITY_MANUAL_TEST_CHECKLIST.md`](docs/UNITY_MANUAL_TEST_CHECKLIST.md) — what to verify inside Unity

---

## 📊 Status

- ✅ **67/67 vitest** green — registry, safety gates, tool groups, annotations, prompts, resources, server instructions, and end-to-end MCP exchange against the mock bridge (multimodal images decoded and rendered).
- ✅ Shipped: full inspection, **C# script editing + `unity_verify`**, **`unity_reflect`/`unity_docs`**, app-ready scene/prefab/asset editing, play-mode/runtime, screenshots, tool groups, and Claude-Code-native slash commands/resources/annotations.
- ✅ One-command install: `bootstrap.mjs` → idempotent, per-project `.mcp.json` with absolute paths, marker-delimited `CLAUDE.md` and `AGENTS.md` blocks.
- ⚠ The TypeScript/MCP layer is fully tested here, but the **Unity Editor C# package must be compiled inside a Unity Editor to runtime-verify** — especially the newer `ScriptEditor` / `CodeExecutor` / `ReflectionBridge`. See [`docs/UNITY_MANUAL_TEST_CHECKLIST.md`](docs/UNITY_MANUAL_TEST_CHECKLIST.md).
- 🚧 Broader domains (physics, VFX, ProBuilder, UI Toolkit, profiler) are out of scope for now — see `.planning/ROADMAP.md`.

## License

MIT.
