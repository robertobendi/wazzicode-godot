# Unity Vibe OS — Roadmap

## Mission
Make Unity vibe-coding with Claude Code dramatically easier by exposing structured Unity state through MCP tools.

## Phases (autonomous loop)

| # | Phase | State | DoD |
|---|---|---|---|
| 0 | Repo discovery + planning | done | planning files exist; GSD terminal absent → mirror manually |
| 1 | Core schemas + bridge protocol | done | Zod schemas, error codes, envelope, JSON-RPC types |
| 2 | MCP server MVP (8 tools) | done | server starts, tools list, mock bridge returns valid envelopes |
| 3 | Unity Editor package MVP | done | bridge HTTP server, scene/selection inspectors, console capture, compile watcher |
| 4 | Project Brain MVP | done | `uvibe brain` writes 5 files |
| 5 | CLI MVP | done | init/serve/brain/doctor/verify/mcp-config |
| 6 | Tests + verification | done | vitest green, mock-mode acceptance tests pass |
| 7 | Docs | done | architecture, MCP tools, Unity package, safety, troubleshooting, manual checklist |
| 8 | Screenshots + polish | done | `unity_capture_game_view`, `unity_capture_scene_view`, `unity_capture_selected`; multimodal image content; `uvibe install-unity-package` |
| 9 | One-command install + Claude onboarding | done | `bootstrap.mjs`, `uvibe setup`, `mcp-config --write`, marker-delimited CLAUDE.md, INSTALL.md |
| 10a | Reliability hardening | done | bridge discovery file, port auto-select, project-identity guard, UNITY_RELOADING + retry, per-method timeouts |
| 10b | Performance probes | done | `unity_get_performance_stats` via ProfilerRecorder (FPS/draw calls/batches/GC/memory) |
| 10c | Test runner | done | `unity_run_tests` (EditMode/PlayMode) via optional Test Framework assembly; survives domain reload |
| 10d | Runtime tools | done | play-mode enter/exit/step/status, runtime find/inspect |
| 10e | Asset/reference graph | done | missing scripts, missing refs, find references/dependencies |
| 11 | Safety + write tools | done | gate wired into MCP server, action log, auto-snapshot. Full first-wave mutators (Undo-wrapped): set field, assign reference, add component, create GO, instantiate prefab, wire UI button, create ScriptableObject/material, create prefab variant, save scene, clear console. Remaining (post-wave): snapshot/restore/revert as exposed tools |
| 12 | Diagnostic + workflow composites | future | `unity_diagnose_*`, `*_workflow` recipes built on the shipped primitives |
| 13 | Automation loop (`uvibe loop`) | future | task-driven autonomous loop |
| 14 | Dashboard | future | minimal web UI |

## Future tools (not yet implemented)
See `docs/MCP_TOOLS.md` "Planned" section.
