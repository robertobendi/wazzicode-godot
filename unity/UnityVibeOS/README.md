# UnityVibeOS — Unity Editor package

The Editor-side half of [Unity Vibe OS](../../README.md). Exposes a localhost HTTP JSON-RPC bridge (`127.0.0.1:38578`) consumed by `@uvibe/mcp-server`, which Claude Code calls.

## Install

Two ways.

**A. Local file path (simplest while iterating):**

In your Unity project's `Packages/manifest.json`:

```json
{
  "dependencies": {
    "com.uvibe.os": "file:../../path/to/wazzicode-unity/unity/UnityVibeOS"
  }
}
```

**B. Drop-in:**

Copy the `UnityVibeOS/` directory into your project's `Packages/com.uvibe.os/`.

Once installed and Unity has compiled, the bridge auto-starts at editor load and listens on `127.0.0.1:38578`. Confirm via `uvibe doctor`.

## What it does

- Accepts JSON-RPC requests at `POST /rpc` and returns versioned, structured responses.
- Captures Unity console logs (post-load) into a 2,000-entry ring buffer.
- Reports compile status from `UnityEditor.Compilation.CompilationPipeline`.
- Inspects open scenes, scene hierarchy, and the active selection (with serialized inspector values).

Read-only. No method mutates project state. Write methods will land in a later milestone behind safety snapshots and an action log.

## Bridge protocol

Versioned at `1.0`. Request:

```json
{ "id": "uuid", "version": "1.0", "method": "scene.getHierarchy", "params": {} }
```

Success response:

```json
{ "id": "uuid", "ok": true, "result": { ... }, "error": null,
  "meta": { "unityVersion": "2022.3.42f1", "projectPath": "/...", "durationMs": 12 } }
```

Failure:

```json
{ "id": "uuid", "ok": false, "result": null,
  "error": { "code": "OBJECT_NOT_FOUND", "message": "...", "details": {} },
  "meta": { ... } }
```

## Menu

`Window → Unity Vibe OS → Status` shows port, log buffer size, and compile state.

## Limitations

- Console logs are captured from package load onward. Logs emitted before load (e.g. earliest editor warnings) are not retained.
- Compile error detail depends on Unity version; see `compile.status` `fallback` field.
- No write methods. Plan: ship snapshots + action log first, write tools second.

See `docs/UNITY_PACKAGE.md` and `docs/UNITY_MANUAL_TEST_CHECKLIST.md` in the repo root.
