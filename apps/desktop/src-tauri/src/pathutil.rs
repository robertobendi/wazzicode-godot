//! Cross-platform path normalisation.
//!
//! On Windows `std::fs::canonicalize` returns an extended-length "verbatim"
//! path prefixed with `\\?\` (e.g. `\\?\C:\Users\me\Repos`). The bundled
//! Git for Windows is an MSYS build that can't parse that prefix and fails
//! operations such as `git clone <dest>` with:
//!
//! ```text
//! could not create work tree dir '\\?\C:\…\Repo': Invalid argument
//! ```
//!
//! It also breaks `git -C \\?\…` (fetch / pull / commit / push). So we strip
//! the prefix before any path reaches the `git` binary, and before a path is
//! persisted as a configured root.
//!
//! On Unix none of this applies — `dunce` is a transparent pass-through, so
//! both helpers are byte-for-byte identical to the corresponding std calls.
//! Nothing here changes the macOS/Linux behaviour.

use std::path::{Path, PathBuf};

/// Like `std::fs::canonicalize`, but without the Windows `\\?\` verbatim
/// prefix for normal paths (those within the legacy length limit and not a
/// true UNC share). Identical to `std::fs::canonicalize` on Unix.
pub fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Strip a Windows `\\?\` verbatim prefix if present — pure, no IO. Leaves
/// paths that genuinely require the prefix (true UNC, or longer than the
/// legacy MAX_PATH) untouched. No-op on Unix.
///
/// Use this on any path handed to the `git` binary, in case it carries a
/// verbatim prefix from an older persisted root or a symlink resolution.
pub fn simplified(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}
