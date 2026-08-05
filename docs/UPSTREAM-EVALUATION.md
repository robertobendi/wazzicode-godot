# Godot MCP upstream evaluation

WazziCode Godot was created on 2026-08-06 after reviewing Godot MCP implementations available on GitHub. The review favored a permissive license, recent maintenance, editor-safe writes, session routing, protocol hardening, automated tests, and a production release lifecycle over star count alone.

## Candidates reviewed

| Project | Notable strengths | Evaluation result |
|---|---|---|
| [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai) | MIT; Python FastMCP plus a GDScript editor plugin; broad rolled-up operations; multi-editor routing; undo-aware writes; transactional batches; diagnostics, screenshots, play control, and in-editor tests; path/origin hardening; CI and signed release updates | Selected as the base. The imported history is release `v3.1.1`, commit `b1d767657fac87ef2a13a02c8ed58f4aa441db48`. |
| [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp) | MIT; TypeScript/GDScript; especially good deterministic playtesting and a well-tested action surface | Strong runner-up. Its local Node suite passed 603 tests with 7 skips during evaluation, but its architecture was a larger departure from the existing WazziCode Unity workflow and the reviewed WebSocket boundary had less authentication/origin hardening. |
| [n24q02m/better-godot-mcp](https://github.com/n24q02m/better-godot-mcp) | Apache-2.0; security tests and useful offline text-scene editing | Useful design reference, but the selected base had a broader live-editor lifecycle and deeper release/CI history. |
| [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) | Popular, compact Node/GDScript bridge with an approachable setup | Useful early implementation, but the reviewed revision had a smaller automated-test and lifecycle surface than the selected base. |

No MCP implementation was found in the official [godotengine GitHub organization](https://github.com/godotengine) during the review, so WazziCode Godot is explicitly a community derivative rather than an official Godot project.

## Improvements made here

- Added a dependency-free, cross-platform project bootstrap with safe merges, link/copy modes, local editable Python setup, dry-run support, and path-boundary tests.
- Added `godot_orient`, an always-loaded bounded snapshot for beginning or resuming agent work.
- Added deferred `godot_verify`, which produces an evidence-based verdict from fresh editor state, diagnostics, and optional in-editor tests without authoring project content.
- Made telemetry explicit opt-in across Python, the Godot editor UI, spawned servers, and generated client launchers.
- Added WazziCode product surfaces, equal Codex/Claude guidance, transparent upstream attribution, and a compatibility-preserving CLI alias.
- Guarded inherited upstream publishing workflows so the derivative cannot accidentally publish the upstream package name.

Candidate counts and repository state are a dated engineering snapshot, not a permanent ranking. Re-evaluate before changing foundations, and preserve the `upstream` Git remote so future Godot AI fixes can be reviewed and merged deliberately.
