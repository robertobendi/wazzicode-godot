# WazziCode Godot telemetry

Anonymous telemetry is **off by default**. WazziCode Godot does not create a telemetry UUID, start a telemetry worker, or send telemetry unless you explicitly opt in.

The inherited collector is open source in `src/godot_ai/telemetry.py`; plugin-side event handling is in `plugin/addons/godot_ai/telemetry.gd`.

## How to opt in

### Editor UI

Open the WazziCode Godot clients/tools window, find **Anonymous telemetry (opt in)**, enable it, and select **Apply and Restart Server**. The choice is saved under the compatibility setting key `godot_ai/telemetry_enabled`.

Generated client entries carry the choice explicitly:

- enabled: `godot-ai attach --enable-telemetry ...`
- disabled: `godot-ai attach --disable-telemetry ...`

Re-run **Configure** after changing the preference so an existing Codex, Claude, or other client entry receives the current launch arguments.

### Environment

Set the positive opt-in variable to a truthy value (`1`, `true`, `yes`, or `on`):

```bash
export GODOT_AI_ENABLE_TELEMETRY=true
```

The mature `GODOT_AI_*` namespace is retained for compatibility. A truthy legacy disable variable always wins over the positive opt-in, including when both are present:

```bash
export GODOT_AI_DISABLE_TELEMETRY=true
# The cross-tool kill switch is also authoritative:
export DISABLE_TELEMETRY=true
```

Falsey or missing enable values do not opt in. Environment controls apply to the current process and are not silently persisted as an editor preference.

## Effect of staying disabled

When telemetry is disabled:

- no record is queued or transmitted;
- no customer UUID is generated;
- no telemetry worker thread is created;
- no telemetry data directory is created; and
- inherited `customer_uuid.txt` and `milestones.json` files are removed on server startup.

The plugin helper also drops events instead of buffering or forwarding them.

## Destination and provenance

After opt-in, records use the inherited baked-in Godot AI endpoint unless you provide an override:

```text
https://godot-ai-telemetry-pudmurzsnq-uw.a.run.app/events
```

That default is an upstream Godot AI service inherited from [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai); this repository does not present it as a WazziCode-operated service.

Self-hosters and controlled test environments can choose another destination:

```bash
export GODOT_AI_ENABLE_TELEMETRY=true
export GODOT_AI_TELEMETRY_ENDPOINT=https://telemetry.example.com/events
export GODOT_AI_TELEMETRY_TIMEOUT=2.5
```

Only `http://` and `https://` schemes are accepted. Loopback is rejected unless `GODOT_AI_TELEMETRY_ALLOW_LOOPBACK=1` is set. Plain HTTP to a non-loopback host is rejected unless `GODOT_AI_TELEMETRY_ALLOW_INSECURE_HTTP=1` is set. An invalid override does not fall back to the upstream endpoint.

## What an opted-in installation sends

### Tool and resource execution

- tool or resource name;
- `sub_action` for domain rollups;
- success status and duration;
- structured error category, plus an allowlisted readiness sub-code where applicable;
- exception class name for unstructured failures, never exception message text; and
- a salted, hashed session ID when a call targets an editor session.

### Startup

- server version and WebSocket port;
- lifespan startup duration;
- whether diagnostic hints are suppressed; and
- one-shot first-startup milestone state.

### Connection and plugin events

- Godot/plugin/protocol versions, server launch mode, session count, and connect/disconnect state;
- a one-shot multiple-sessions milestone; and
- allowlisted plugin events: `dock_startup`, `plugin_reload`, `self_update`, and `dev_server_toggle`.

## Identifier privacy

Session IDs contain a project-directory slug such as `secret-game@a3f2`. Before transmission, the slug becomes the first eight hexadecimal characters of `sha256(customer_uuid + slug)`, for example `3f1a8b22@a3f2`. The salt makes a common project name produce different hashes on different installations.

The telemetry payload does not contain source code, scene contents, file paths, project names, editor logs, console output, email addresses, or account identifiers. As with any network request, the destination's infrastructure may observe ordinary connection metadata such as the source IP even though it is not a telemetry payload field.

## Local storage after opt-in

- macOS: `~/Library/Application Support/godot-ai/`
- Linux: `$XDG_DATA_HOME/godot-ai/` or `~/.local/share/godot-ai/`
- Windows: `%APPDATA%\godot-ai\`

The compatibility directory contains `customer_uuid.txt` and `milestones.json`. Disable telemetry and start the server once to clean inherited files, or delete that directory manually while the server is stopped.

## Maintainer wiring

- `src/godot_ai/server.py` installs the FastMCP instrumentation wrappers before registering tools and resources.
- `src/godot_ai/sessions/registry.py` emits editor connection records.
- `src/godot_ai/transport/websocket.py` allowlists plugin events.
- `plugin/addons/godot_ai/telemetry.gd` handles the editor-side preference and event buffer.

When adding a plugin event, update the allowlists in both Python and GDScript, document its non-identifying field shape here, and add focused tests.
