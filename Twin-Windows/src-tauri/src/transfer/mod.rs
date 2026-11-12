//! Transfer module — upload, download, progress, limiter.
use std::path::{Path, PathBuf};

use crate::error::AppError;

pub mod download;
pub mod limiter;
pub mod progress;
pub mod upload;

pub use download::DownloadRunner;
pub use limiter::Limiter;
pub use progress::{active_transfers_count, relay_progress};
pub use upload::UploadRunner;

/// Resolve a sync-relative path under `root` without permitting path traversal,
/// absolute paths, alternate data streams, or Windows device files.
///
/// Drive metadata and persisted jobs are both untrusted at this boundary. A
/// lexical check is deliberate: the caller may be creating a destination, so
/// canonicalization cannot be relied upon before it exists.
pub fn resolve_under_root(root: &Path, rel_path: &str) -> Result<PathBuf, AppError> {
    if rel_path.is_empty() || rel_path.contains('\0') {
        return Err(AppError::Other("path must be a non-empty relative path".into()));
    }

    let normalized = rel_path.replace('\\', "/");
    if normalized.starts_with('/') || normalized.starts_with("//") {
        return Err(AppError::Other(format!("unsafe absolute path: {rel_path:?}")));
    }

    let mut resolved = root.to_path_buf();
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." || component.contains(':') {
            return Err(AppError::Other(format!("unsafe path component in {rel_path:?}")));
        }
        if component.ends_with('.') || component.ends_with(' ') || is_windows_device_name(component) {
            return Err(AppError::Other(format!("unsupported Windows path component in {rel_path:?}")));
        }
        resolved.push(component);
    }
    Ok(resolved)
}

fn is_windows_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default().to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4"
            | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2"
            | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

#[cfg(test)]
mod tests {
    use super::resolve_under_root;
    use std::path::Path;

    #[test]
    fn resolves_safe_relative_paths_only() {
        let root = Path::new(r"C:\\Twin");
        assert_eq!(
            resolve_under_root(root, "nested/file.txt").unwrap(),
            root.join("nested").join("file.txt")
        );
        for unsafe_path in [
            "../escape.txt", "a/../../escape.txt", "/absolute.txt", r"C:\\escape.txt",
            "file.txt:ads", "CON", "NUL.txt", "trailing."
        ] {
            assert!(resolve_under_root(root, unsafe_path).is_err(), "{unsafe_path}");
        }
    }
}

