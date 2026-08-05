# WazziCode Godot attribution notice

WazziCode Godot is a derivative of **Godot AI**, maintained upstream at [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai).

The initial derivative base is:

- upstream release/version: `3.1.1`
- upstream commit: `b1d767657fac87ef2a13a02c8ed58f4aa441db48`
- upstream source: <https://github.com/hi-godot/godot-ai>

Godot AI is distributed under the MIT License with this retained notice:

> Copyright (c) 2025 Godot AI contributors

The full license text remains in [LICENSE](LICENSE) and [plugin/addons/godot_ai/LICENSE](plugin/addons/godot_ai/LICENSE). WazziCode Godot modifications are also distributed under that license.

## WazziCode modifications

The derivative adds WazziCode Godot product branding, treats Codex and Claude as equal first-class clients, adds repository bootstrap/setup guidance and the `godot_orient` / `godot_verify` workflows, and changes anonymous telemetry from default-on to explicit opt-in.

When telemetry is explicitly enabled, the inherited collector sends to the baked-in Godot AI upstream telemetry endpoint unless `GODOT_AI_TELEMETRY_ENDPOINT` is set. This repository does not represent that upstream service as a WazziCode-operated endpoint. See [docs/TELEMETRY.md](docs/TELEMETRY.md) before opting in.

## Retained compatibility names

The identifiers `godot_ai`, `godot-ai`, `addons/godot_ai`, `godot_ai/*`, `/godot-ai/status`, and `godot://...` are intentionally retained. Renaming them would disrupt existing MCP client entries, saved editor settings, add-on loading, process discovery, protocol checks, and the upstream self-update lifecycle. Their presence is compatibility and provenance, not a conflicting product name.

The inherited in-editor updater continues to trust only signed `hi-godot/godot-ai` release assets. Installing one of those assets switches the add-on to upstream Godot AI; it is not a WazziCode update. WazziCode source users should pull reviewed changes and rerun `bootstrap.mjs`. The inherited PyPI/tag publishing workflows are guarded to run only in the upstream repository until WazziCode has its own distribution name and signing process.

## Following upstream

Use a separate `upstream` remote and review changes before integration:

```bash
git remote add upstream https://github.com/hi-godot/godot-ai.git  # once
git fetch upstream
git log --oneline HEAD..upstream/main
git diff HEAD...upstream/main
```

Apply an upstream merge or rebase on a dedicated branch. Resolve conflicts deliberately, then verify that WazziCode display branding, this notice, privacy-first telemetry defaults, compatibility identifiers, and bootstrap behavior remain intact.
