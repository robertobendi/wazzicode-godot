# Sample MCP configs

- `claude_code.json` — drop into `~/.claude.json` (under `mcpServers`) or your project's `.mcp.json`.
- `claude_desktop_config.json` — drop into `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) / `%APPDATA%/Claude/claude_desktop_config.json` (Windows).

Replace `UVIBE_PROJECT` with the absolute path of your Unity project (the directory containing `Assets/`, `Packages/`, `ProjectSettings/`).

You can also generate the snippet with the right path baked in:

```bash
uvibe mcp-config --project=/absolute/path/to/your/UnityProject
```
