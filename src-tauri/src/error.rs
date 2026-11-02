use std::fmt;
use serde::ser::{Serialize, Serializer};

/// Application-level error type. Hand-written — no thiserror.
#[derive(Debug)]
pub enum AppError {
    Io(String),
    Config(String),
    Auth(String),
    Db(String),
    Network(String),
    Drive(String),
    Other(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Io(msg) => write!(f, "IO error: {msg}"),
            AppError::Config(msg) => write!(f, "Config error: {msg}"),
            AppError::Auth(msg) => write!(f, "Auth error: {msg}"),
            AppError::Db(msg) => write!(f, "DB error: {msg}"),
            AppError::Network(msg) => write!(f, "Network error: {msg}"),
            AppError::Drive(msg) => write!(f, "Drive error: {msg}"),
            AppError::Other(msg) => write!(f, "Error: {msg}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

/// Serialize AppError as a plain string so it can cross the Tauri IPC boundary.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_variants() {
        assert_eq!(AppError::Io("oops".into()).to_string(), "IO error: oops");
        assert_eq!(AppError::Config("bad".into()).to_string(), "Config error: bad");
        assert_eq!(AppError::Auth("denied".into()).to_string(), "Auth error: denied");
        assert_eq!(AppError::Db("locked".into()).to_string(), "DB error: locked");
        assert_eq!(AppError::Network("timeout".into()).to_string(), "Network error: timeout");
        assert_eq!(AppError::Drive("quota".into()).to_string(), "Drive error: quota");
        assert_eq!(AppError::Other("unknown".into()).to_string(), "Error: unknown");
    }

    #[test]
    fn from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let app_err = AppError::from(io_err);
        assert!(matches!(app_err, AppError::Io(_)));
        assert!(app_err.to_string().contains("IO error:"));
    }

    #[test]
    fn serialize_as_string() {
        let err = AppError::Auth("token expired".into());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, r#""Auth error: token expired""#);
    }
}

