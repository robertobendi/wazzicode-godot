# Claude Context: SampleGame

This file primes Claude Code for productive work in this Unity project. Read it before answering project-specific questions.

## Project

- SampleGame on Unity 2022.3.42f1, URP, InputSystem.
- Build target: StandaloneOSX.
- Path: `/Users/Roberto/Repos/wazzicode-unity/tests/fixtures/sample-unity-project`.

## How to work here

- Prefer the Unity Vibe OS MCP tools (`unity_*`) over reading raw .unity / .prefab YAML.
- Always check Unity console (`unity_get_console_logs`) and compile state (`unity_wait_for_compile`) after C# changes.
- Inspect what the user is looking at via `unity_inspect_selected` before assuming structure.
- Treat write tools as gated by `.unity-vibe/config.json#safetyMode` (default `read_only`). Do not bypass.

## What's here

- 1 scenes, 0 prefabs, 3 C# scripts.
- 2 manager-style classes; 1 ScriptableObject types; pooling=no, save-system=no, audio-manager=yes.

## Scenes

- `Assets/Scenes/Sample.unity`

## ScriptableObject types

`WeaponData`

## Conventions

See [`.unity-vibe/conventions.md`](./conventions.md). Defer to anything documented there.

## Source files referenced by this brain

- `.unity-vibe/project_brain.md` — full project brain (markdown)
- `.unity-vibe/project_brain.json` — same data structured
- `.unity-vibe/conventions.md` — project conventions
- `.unity-vibe/config.json` — safety + runtime config
