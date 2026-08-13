use crate::agent::SessionManager;
use crate::bridge::StatusTask;
use crate::codexauth::CodexLoginManager;
use crate::execution::ProjectExecutions;
use crate::gitutil::Checkpoint;
use crate::looprunner::LoopManager;
use crate::pairing::PairingManager;
use crate::store::settings::Settings;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::{Mutex, RwLock};

/// Application state shared across Tauri commands.
///
/// Held by Tauri as `tauri::State<AppState>`. Fields are async-locked so
/// command handlers can read/write without blocking the runtime.
pub struct AppState {
    pub settings: RwLock<Settings>,
    pub config_dir: PathBuf,
    /// Headless agent runs (one active per project). Cheap to clone.
    pub sessions: SessionManager,
    /// Atomic chat/Auto editing exclusion, keyed by canonical project path.
    pub executions: ProjectExecutions,
    /// The single running bridge status poller, if any.
    pub status_task: Mutex<Option<StatusTask>>,
    /// The hidden-PTY company-account pairing driver for Claude (one at a time).
    pub pairing: PairingManager,
    /// The Codex sign-in driver (one at a time).
    pub codex_login: CodexLoginManager,
    /// The single active auto-mode loop, if any.
    pub loops: LoopManager,
    /// The last studio checkpoint taken per project (before a chat turn), used
    /// by `revert_last`. Keyed by project path.
    pub checkpoints: Mutex<HashMap<PathBuf, Checkpoint>>,
}

impl AppState {
    pub fn new(config_dir: PathBuf, settings: Settings) -> Self {
        Self {
            settings: RwLock::new(settings),
            config_dir,
            sessions: SessionManager::default(),
            executions: ProjectExecutions::default(),
            status_task: Mutex::new(None),
            pairing: PairingManager::default(),
            codex_login: CodexLoginManager::default(),
            loops: LoopManager::default(),
            checkpoints: Mutex::new(HashMap::new()),
        }
    }
}
