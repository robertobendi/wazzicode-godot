# Godot Vibe OS repository

This is a pnpm TypeScript workspace plus a Godot 4 editor addon and a Tauri desktop app.

- Never guess a Godot API. Verify unfamiliar signatures in the installed 4.7 source/docs or through `godot_reflect`.
- Do not hand-edit `.tscn` or `.tres` when a dedicated editor RPC fits the change.
- After addon changes run the real fixture integration in `tests/godot/integration.mjs`.
- After TypeScript changes run the affected package typecheck and tests; before completion run the full gates in README.
- Do not call import or `--check-only` a unit test. Project tests are `not_configured` unless a real runner is invoked.
- Preserve localhost-only binding, per-launch token auth, project identity validation, request bounds, UndoRedo scene mutations, SHA-guarded file edits, snapshots, and action logging.

Use `node apps/cli/bin/gvibe <command>` for the local CLI.
