//! Headless coding-agent integration: backend selection, flag building, the
//! shared spawn/stream core, and the per-turn chat session manager.
//!
//! Two backends are supported and are interchangeable everywhere in the app
//! (chat, auto-loop, quick actions): Anthropic's **Claude Code** (`claude -p`)
//! and OpenAI's **Codex CLI** (`codex exec`). Both are headless, both stream
//! newline-delimited JSON, and both drive the same `unity-vibe-os` MCP server —
//! so a single spawn core serves both, and only the argv and the event
//! vocabulary differ. See [`backend::Backend`].

pub mod backend;
pub mod codex;
pub mod flags;
pub mod options;
pub mod session;
pub mod spawn;

pub use backend::Backend;
pub use options::{AgentModelOption, AgentRunOptions};
pub use session::SessionManager;
pub use spawn::{spawn_streaming, ChildHandle, ExitInfo};
