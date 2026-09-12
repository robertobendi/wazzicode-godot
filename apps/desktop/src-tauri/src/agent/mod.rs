//! Headless coding-agent integration: backend selection, flag building, the
//! shared spawn/stream core, and the per-turn chat session manager.
//!
//! Three backends are supported and are interchangeable everywhere in the app
//! (chat, auto-loop, quick actions): Anthropic's **Claude Code** (`claude -p`),
//! OpenAI's **Codex CLI** (`codex exec`), and **OpenCode** (`opencode run`).
//! All are headless, all stream newline-delimited JSON, and all drive the same
//! `godot-vibe-os` MCP server — so a single spawn core serves them all, and
//! only the argv and the event vocabulary differ. See [`backend::Backend`].

pub mod backend;
pub mod codex;
pub mod flags;
pub mod opencode;
pub mod options;
pub mod session;
pub mod spawn;

pub use backend::Backend;
pub use options::{AgentModelOption, AgentRunOptions};
pub use session::SessionManager;
pub use spawn::{spawn_streaming, ChildHandle, ExitInfo};
