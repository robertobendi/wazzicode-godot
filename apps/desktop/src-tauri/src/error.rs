use serde::{Serialize, Serializer};
use thiserror::Error;

/// Application error. Serializes to a plain string over IPC so the frontend
/// can render the message verbatim (spawn/PATH hints, friendly bridge errors).
#[derive(Debug, Error)]
pub enum AppError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Other(s.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
