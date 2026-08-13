# Project Conventions

> Edit this file freely. Unity Vibe OS reads it for project-specific rules and exposes it to Claude.

## Code style
- C# follows Unity defaults (4-space indent, K&R braces).
- Public fields are PascalCase, private fields are _camelCase.
- Avoid `FindObjectOfType` in Update/FixedUpdate.

## Scene & prefab rules
- Never edit `.unity` / `.prefab` YAML by hand. Always go through the Unity Editor or Unity Vibe OS MCP tools.
- Prefer prefab variants over scene-only edits when authoring shared content.
- Manager singletons live in a `Bootstrap` scene loaded first.

## Asset organization
- `Assets/Art`, `Assets/Audio`, `Assets/Prefabs`, `Assets/Scenes`, `Assets/Scripts`, `Assets/ScriptableObjects`.
- ScriptableObjects under `Assets/ScriptableObjects/<Type>/`.

## Claude-specific rules
- Use `unity_inspect_selected` before assuming what is selected.
- Always compile (`unity_wait_for_compile`) and review console (`unity_get_console_logs`) after C# edits.
- Never run shell commands that mutate the project; use safe write tools (when available).
- Prefer narrow, additive changes. Open scene only when necessary.
