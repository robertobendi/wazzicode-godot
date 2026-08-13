pub mod settings;

use crate::error::AppResult;
use std::path::PathBuf;

/// Resolve the platform-appropriate config dir for Foundry for Godot.
/// Mac:     ~/Library/Application Support/foundry-godot
/// Windows: %APPDATA%/foundry-godot
/// Linux:   ~/.config/foundry-godot
pub fn config_dir() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| crate::error::AppError::Other("could not resolve config dir".into()))?;
    let dir = base.join("foundry-godot");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
