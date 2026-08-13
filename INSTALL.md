# Install Godot Vibe OS

Run the idempotent bootstrap against a directory containing `project.godot`:

```bash
node /absolute/path/to/wazzicode-godot/bootstrap.mjs /absolute/path/to/MyGodotGame
```

It installs workspace dependencies, builds the CLI and its dependencies, runs `gvibe setup`, copies the addon to `addons/godot_vibe_os`, enables it in `[editor_plugins]`, creates `.godot-vibe/`, writes `.mcp.json`, and adds marker-delimited agent guidance without replacing existing instructions.

Open the project in Godot 4.7.1, restart the MCP client from the project directory, then check:

```bash
node /absolute/path/to/wazzicode-godot/apps/cli/bin/gvibe doctor \
  --project=/absolute/path/to/MyGodotGame
```

Bootstrap flags: `--rebuild`, `--skip-install`, and `--skip-build`.

To uninstall, disable the plugin in Godot, remove `addons/godot_vibe_os`, `.godot-vibe/`, and the `godot-vibe-os` entry in `.mcp.json`, then remove the marker-delimited Godot Vibe OS blocks from `AGENTS.md` and `CLAUDE.md` if desired.
