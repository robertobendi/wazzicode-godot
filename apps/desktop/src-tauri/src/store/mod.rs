pub mod settings;

use crate::error::AppResult;
use std::path::PathBuf;

/// Resolve the platform-appropriate config dir for Unity Vibe Studio.
/// Mac:     ~/Library/Application Support/unity-vibe-studio
/// Windows: %APPDATA%/unity-vibe-studio
/// Linux:   ~/.config/unity-vibe-studio
pub fn config_dir() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| crate::error::AppError::Other("could not resolve config dir".into()))?;
    let dir = base.join("unity-vibe-studio");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
