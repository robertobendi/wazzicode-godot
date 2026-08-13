# foundry-unity

A chat-first desktop app (macOS / Windows / Linux) that lets non-technical
teammates make Unity changes through an AI assistant — no terminal. It drives
Unity via the [Unity Vibe OS](../../README.md) MCP bridge and ships its own Node
runtime + MCP server, so employees never install Node or clone this monorepo.

## Dev quickstart

```bash
pnpm install                              # from the repo root
pnpm --filter @uvibe/desktop tauri dev    # launch the app with hot reload
```

Dev builds use the `dev_uvibe_entry` fallback in `src-tauri/src/mcpconfig.rs`,
so you don't need to bundle the sidecar just to run `tauri dev`.

Other useful commands:

```bash
pnpm --filter @uvibe/desktop typecheck    # tsc --noEmit
pnpm --filter @uvibe/desktop test         # vitest (streamMapper, toolLabels, promptAssembly)
```

## Building a packaged app locally

Packaging needs two artifacts the base Tauri config intentionally omits — the
Node sidecar (`externalBin`) and the bundled `uvibe.cjs` + Unity package
(`resources`). Prepare them, then build with the overlay config:

```bash
pnpm build                                                 # workspace (produces apps/cli/dist)
pnpm --filter @uvibe/desktop bundle:sidecar               # fetch host-triple node binary
pnpm --filter @uvibe/desktop bundle:uvibe                 # bundle CLI + copy Unity package
pnpm --filter @uvibe/desktop exec tauri build \
  --config src-tauri/tauri.bundle.conf.json               # add --target <triple> to cross to a specific arch
```

## Release process (CI)

Releases are built by `.github/workflows/desktop-release.yml` — a 4-target
matrix (macOS arm64 + intel, Windows x86_64, Linux x86_64) that runs the same
`pnpm build → fetch-node-sidecar → bundle-uvibe → tauri build` steps per leg.

```bash
git tag desktop-v0.2.9
git push origin desktop-v0.2.9
```

The workflow then appears in **Actions**; when it finishes, a **draft** GitHub
release named `foundry-unity desktop-v0.2.9` holds all installers. Review it
and click **Publish** manually. (You can also start it from the Actions tab via
**Run workflow** — `workflow_dispatch`.)

Artifacts per release:

| OS | Files |
|---|---|
| macOS (arm64, intel) | `.dmg` |
| Windows | `.msi`, NSIS `.exe` |
| Linux | `.deb`, `.AppImage` |

These builds are **unsigned and un-notarized** — there are no Apple, minisign,
or auto-updater secrets in the workflow. That is expected for v1; the install
notes below cover the resulting first-launch prompts.

## Install notes (unsigned builds)

- **macOS** — Gatekeeper blocks unsigned apps on first launch. Right-click the
  app in `/Applications` → **Open** → **Open** on the dialog (only needed once).
  Or from a terminal:
  `xattr -d com.apple.quarantine "/Applications/foundry-unity.app"`.
- **Windows** — SmartScreen shows "Windows protected your PC". Click
  **More info → Run anyway**. The installer downloads the WebView2 runtime
  automatically if it's missing.
- **Linux** — the `.AppImage` is self-contained: `chmod +x` it and run. The
  `.deb` installs with `sudo apt install ./foundry-unity_*.deb`.

## Choosing an agent: Claude Code or ChatGPT Codex

The app can drive either CLI, selectable in **Settings → Agent** (and on the
first screen of onboarding). Both drive the same `unity-vibe-os` MCP server, so
every Unity capability is identical; only the CLI underneath changes.

|                | Claude Code                    | ChatGPT Codex                       |
| -------------- | ------------------------------ | ----------------------------------- |
| CLI            | `claude`                       | `codex`                             |
| Install        | official installer (automatic) | `npm install -g @openai/codex`      |
| Sign-in        | admin pairing (below)          | ChatGPT subscription sign-in        |
| Streaming      | token-by-token                 | per message (tool chips still live) |
| Per-turn cost  | reported in USD                | tokens only — no price              |

The last row has one real consequence: **auto mode's $ budget cap does nothing on
Codex**, because Codex never reports a price. The loop says so in its warnings and
falls back to the iteration cap. Set `maxIterations` accordingly.

Model overrides are stored per backend, so switching agents can't hand a
`claude-*` model id to Codex (or a `gpt-*` one to Claude).

### Queued tasks

The composer stays available while an agent is working. Pressing Enter or
**Queue task** adds the message and its attachments to the current conversation's
ordered queue. After a successful terminal event, foundry-unity autosaves the finished
turn before starting the next task. A stopped or failed task pauses the remaining
queue so it can be reviewed, resumed, trimmed one task at a time, or cleared.

To wire Codex up outside the app (plain terminal use), the CLI prints the TOML
block and the one-liner that registers it:

```bash
uvibe mcp-config --target=codex --project=/path/to/UnityGame
```

## Pairing flow, Claude (for the admin)

Employees sign in against the **company Claude account** without ever seeing the
token. The app runs `claude setup-token` in the background and shows the employee
a single **"Copy link for your admin"** screen. As the admin, when an employee
sends you that OAuth link:

1. Open the link **in a browser where you're logged into the company Claude
   account** (the account whose subscription/credits the team should use).
2. Approve the authorization request. The page shows a short **code**.
3. Send that code back to the employee.

The employee pastes the code into the app; it captures the resulting OAuth token,
stores it in the OS keychain (never in project files), and verifies it with a
cheap probe. From then on their chats and auto-loop runs use the company account.
If a pairing gets stuck, the employee can hit **Start over** (there's a 10-minute
timeout) and re-send you a fresh link.

## Sign-in flow, Codex — subscription only

Codex needs no admin round-trip: `codex login` opens a browser, the employee signs
in to ChatGPT, and the CLI stores its own credentials under `~/.codex`. The app
shows the sign-in URL in case the browser doesn't open by itself, then polls
`codex login status` until it flips.

**This path bills your ChatGPT plan, never API credits — by construction:**

- The app offers **no API-key sign-in**. `codex login --with-api-key` exists, but
  it spends from a different wallet, so we don't expose it.
- Every Codex process the app spawns has `OPENAI_API_KEY` / `CODEX_API_KEY`
  **stripped from its environment** (`codexauth::scrub_api_key`). A developer who
  happens to export a key in their shell would otherwise have the CLI silently
  pick it up and bill credits. There's no config key that forces this
  (`preferred_auth_method` isn't recognized by codex-cli 0.144.4), so scrubbing
  the environment is the enforceable guarantee. A unit test pins it.

## Dictation (offline, local)

The composer has a mic. Speech-to-text runs **on the machine** — a quantized
Whisper (`onnx-community/whisper-tiny.en`) executing in ONNX Runtime via WASM,
inside a Web Worker. No audio leaves the device, nothing is billed, and it works
offline and behind a firewall (the app's CSP has no remote `connect-src` at all).

The model + runtime (~82 MB) are **not committed**. Vendor them before packaging:

```bash
pnpm --filter @uvibe/desktop bundle:whisper   # or `bundle`, which does all three
```

If they're absent — e.g. a plain `tauri dev` — the mic button simply doesn't
render, so the app still builds and runs without the download.

Why not a native Whisper? `whisper-rs` needs libclang/LLVM on every build machine,
and whisper.cpp publishes no prebuilt macOS CLI — both are a tax on a
cross-platform product build. WASM is one artifact that behaves identically on all
three OSes. The transcriber is behind a small module (`src/lib/dictation/`), so a
native backend can be swapped in later without touching the composer.
