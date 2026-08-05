# WazziCode Godot add-on

This directory is the installable Godot editor add-on for WazziCode Godot, an MCP bridge for Codex, Claude, and other compatible AI coding clients.

## Install from this repository

Copy this complete `godot_ai` directory into a project's `addons/` directory so the final path is:

```text
your-project/addons/godot_ai/plugin.cfg
```

Open the project in Godot 4.5 or newer, then enable **WazziCode Godot** under **Project > Project Settings > Plugins**. The dock can configure Codex, Claude, or both against the same local backend.

The repository-level bootstrap is the preferred installation path; see [the root setup guide](../../../SETUP.md).

## Compatibility and attribution

The folder remains named `godot_ai` because the mature add-on lifecycle, saved resources, client launchers, and self-update process depend on that path. WazziCode Godot is derived from [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai) and retains its MIT license. See the repository [NOTICE](../../../NOTICE.md) and [LICENSE](LICENSE).
