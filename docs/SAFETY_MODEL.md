# Safety model

Unity Vibe Studio is ready to inspect and edit a project immediately. It repairs project access when a project is selected and again before every task, so users do not need to understand or approve internal access modes.

## Modes

Stored in `.unity-vibe/config.json#safetyMode`. Studio-managed projects use `autopilot` by default.

| Mode | Behavior |
|---|---|
| `read_only` | All write tools blocked with `SAFETY_MODE_BLOCKED`. Inspection, diagnostics, screenshots, brain generation are allowed. |
| `suggest` | Write tools return a structured proposed change instead of applying it. |
| `confirm` | Write tools allowed only for tool categories explicitly enabled in config. Snapshots required if `autoSnapshot=true`. |
| `autopilot` | Normal Studio mode: tools run without per-call permission prompts and remain protected by checkpoints, Undo, snapshots, and action logging. |

## Per-category flags

```json
{
  "allowSceneWrites": true,
  "allowPrefabWrites": true,
  "allowScriptWrites": true,
  "allowAssetWrites": true,
  "allowMenuItems": true,
  "allowCodeExecution": true,
  "allowedMenuItems": ["*"],
  "autoSnapshot": true
}
```

Studio maintains these values automatically. The flags remain in the lower-level configuration schema for compatibility and emergency lock-down, not as normal user-facing setup.

## Snapshots

`packages/safety/snapshot.ts` exposes:

- `createSnapshot(projectPath, files: string[])` — copies files into `.unity-vibe/snapshots/<ISO>/` with a manifest.
- `listSnapshots(projectPath)` — newest-first.
- `restoreSnapshot(projectPath, id)` — copies files back.

Write tools create snapshots where applicable when `autoSnapshot=true`.

## Action log

Every write attempt — success, error, or blocked — is appended as JSONL to `.unity-vibe/action_log.jsonl`. Tool: `unity_list_ai_actions` (planned). Entry shape:

```json
{
  "timestamp": 1714327200000,
  "tool": "unity_set_serialized_field",
  "args": {"path": "...", "field": "...", "value": "..."},
  "result": "ok|error|blocked",
  "errorCode": null,
  "snapshotId": "2026-04-28T19-22-14-001Z",
  "notes": null
}
```

## Hard rules (from the brief)

- Bridge bound only to `127.0.0.1`. No remote exposure.
- No arbitrary shell execution exposed via MCP tools.
- No edits to `.unity` / `.prefab` YAML; mutations go through Unity Editor APIs.
- Never delete assets permanently — moved to `.unity-vibe/trash/` with explicit override.
- Never mass-rename or mass-move assets without an explicit task plan.

## User experience

Permission switches are deliberately not part of the normal UI. Studio launches its supported agent backends non-interactively, repairs the selected project's tool access, and reports task progress in the chat. Recovery stays available through the pre-task git checkpoint, Unity Undo, snapshots, and the action log.
