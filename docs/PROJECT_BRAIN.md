# Project Knowledge Map

Unity Vibe OS maintains one source-backed knowledge map per Unity project. Its purpose is to pay the discovery cost once, keep the result current, and let later agents or developers retrieve only the project facts relevant to a task.

The map is generated from project files; it does not invent architectural summaries. Every fact or relationship includes provenance, and heuristic observations are labeled with confidence.

## Canonical store

The generated store lives under `.unity-vibe/knowledge/`:

| File | Purpose |
|---|---|
| `manifest.json` | Schema version, project identity, coverage, errors, source/content fingerprints, and dirty reasons |
| `entities.jsonl` | Streamable records for the project, packages, modules, scenes, prefabs, scripts, and C# types |
| `relations.jsonl` | Source-backed `contains`, `declares`, `derives`, and conservative `references` edges |
| `index.md` | Small human-readable overview used by the `unity://project-brain` MCP resource |

JSONL is the canonical database format. It is dependency-free, easy to stream, inspect, diff, and rebuild, while the entity/relation records still form a graph. SQLite or an Obsidian vault is not required to query or visualize it.

Unity Vibe OS also writes `.unity-vibe/project_brain.json`, `project_brain.md`, and `claude_context.md` for compatibility with existing workflows. `.unity-vibe/conventions.md` remains curated and is never overwritten after creation.

## What is scanned

Generation does not require a running Unity Editor. It reads:

- `ProjectSettings/ProjectVersion.txt` and `ProjectSettings/ProjectSettings.asset` for Unity and product settings.
- `Packages/manifest.json` for dependency versions, render pipeline, and input system.
- `Assets/` and embedded `Packages/`, excluding generated or transient directories such as `Library`, `Temp`, `Logs`, `obj`, `.git`, and `.unity-vibe`.
- Scenes, prefabs, scripts, ScriptableObject assets, materials, textures, and audio files.
- Every selected C# script for declared types, namespaces, base types, bounded member signatures, and conservative references to uniquely resolved project types.

The default scan cap is 25,000 files. First-party C# and package C# are prioritized before non-code assets. The manifest always reports discovered and scanned counts by scope, read errors, whether coverage is complete, and whether the cap truncated it. A truncated map means facts beyond the boundary are unknown, not absent.

The C# analysis is deliberately deterministic text analysis rather than a replacement for Unity/Roslyn reflection. Relationships marked as heuristic must be checked against their path, line, evidence, and confidence before a risky change. Use `unity_reflect` when an exact live Unity API or serialized type must be verified.

## Freshness lifecycle

The map is built during `uvibe setup` and Unity Vibe Studio onboarding. It is also reconciled when the MCP server starts and before `unity_orient` or `unity_query_project_brain` returns project knowledge.

Freshness uses two mechanisms:

1. Successful persistent MCP writes mark the manifest dirty with the tool and affected path. Preview-only, blocked, failed, console-only, and unsaved scene operations do not claim that persistent files changed.
2. A filesystem fingerprint detects edits made outside MCP from paths, sizes, modification times, the configured scan boundary, and SHA-256 content digests for C# plus the Unity/package settings that shape the map. Restoring an edited file's size and timestamp does not hide the change.

Reconciliation is serialized across processes. A missing, dirty, corrupt, or changed store is rebuilt with atomic file replacements and a manifest written last; readers validate the committed snapshot before using it. A clean store with the same source fingerprint is reused. Persistent scan errors remain visible without causing an endless rebuild loop, then retry after a source change or an explicit refresh. Generated records are replaced from observed state rather than appended, so removed scripts, types, and relations disappear instead of accumulating as stale history.

Run `uvibe brain --project <path>` or call `unity_generate_project_brain` for an explicit rebuild. `uvibe brain --ensure --project <path>` performs the same freshness reconciliation used by Studio.

## Asking questions

Agents should begin with `unity_orient({ task: "<current request>" })`. It returns a compact project primer and a bounded set of relevant entities alongside live Unity, compile, console, and git state.

Use `unity_query_project_brain` for deeper questions such as:

- `what handles saving?`
- `PlayerController dependencies`
- `types derived from ScriptableObject`
- `scripts in the combat module`

Queries return ranked entities, facts, graph neighbors, and provenance rather than injecting the entire store into model context. Optional kind filters, result limits, explicit truncation counts, and a serialized-size ceiling keep responses bounded.

In Unity Vibe Studio, open **Project Map** from the top bar. The visualizer provides coverage and freshness status, entity-kind filters, search, facts and evidence, inbound/outbound relationships, and an explicit refresh action. It reads the same canonical files as the MCP tools.

## Ownership rules

- Do not hand-edit files under `.unity-vibe/knowledge/`; rebuild them from project state.
- Put human decisions and team rules in `.unity-vibe/conventions.md`.
- Treat a dirty, incomplete, truncated, or error-bearing manifest as an explicit knowledge boundary.
- Verify live scene/prefab state with Unity tools and verify C# changes with `unity_verify`; the filesystem map complements the Editor rather than replacing it.
