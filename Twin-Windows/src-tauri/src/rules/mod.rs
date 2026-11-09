//! P06 – Rules matcher
//!
//! Decides whether a file is eligible for sync based on include/exclude globs,
//! max file size, and hidden/system file attributes (Windows only).

use std::path::Path;

use globset::{Glob, GlobSet, GlobSetBuilder};
use tracing::warn;

/// Compiled include/exclude rule set.
pub struct Rules {
    include: GlobSet,
    exclude: GlobSet,
    max_bytes: u64, // 0 = unlimited
}

impl Rules {
    /// Build from string slices.  Invalid globs are warned and skipped.
    pub fn new(include: &[String], exclude: &[String], max_file_mb: u64) -> Self {
        Self {
            include: build_globset(include),
            exclude: build_globset(exclude),
            max_bytes: max_file_mb.saturating_mul(1024 * 1024),
        }
    }

    /// Build rules combining global rules with pair-specific exclude patterns and selective subfolder exclusions.
    pub fn for_pair(global: &crate::config::RulesSection, pair: &crate::config::PairEntry) -> Self {
        let mut combined_excludes = global.exclude.clone();
        for pat in &pair.exclude {
            let trimmed = pat.trim();
            if !trimmed.is_empty() && !combined_excludes.iter().any(|x| x == trimmed) {
                combined_excludes.push(trimmed.to_string());
            }
        }
        for folder in &pair.excluded_folders {
            let trimmed = folder.trim_matches('/').trim_matches('\\').replace('\\', "/");
            if !trimmed.is_empty() {
                let deep = format!("{trimmed}/**");
                if !combined_excludes.contains(&deep) {
                    combined_excludes.push(deep);
                }
                if !combined_excludes.contains(&trimmed) {
                    combined_excludes.push(trimmed.clone());
                }
            }
        }
        Self::new(&global.include, &combined_excludes, global.max_file_mb)
    }

    /// Return `true` if the file at `rel` (relative path, any slash direction)
    /// with `size` bytes is allowed to be synced.
    pub fn allowed(&self, rel: &Path, size: u64) -> bool {
        self.allowed_path(None, rel, size)
    }

    /// Return `true` if the file at `rel` (with optional `full_path` for accurate Windows attributes)
    /// with `size` bytes is allowed to be synced.
    pub fn allowed_path(&self, full_path: Option<&Path>, rel: &Path, size: u64) -> bool {
        // Normalise to forward-slash string for glob matching.
        let fwd = rel
            .to_string_lossy()
            .replace('\\', "/");
        let rel_fwd = Path::new(&fwd);

        // 1. Hidden / system attributes (Windows). Check absolute path if provided.
        let target = full_path.unwrap_or(rel);
        if is_hidden_or_system(target) {
            return false;
        }

        // 2. Max size.
        if self.max_bytes > 0 && size > self.max_bytes {
            return false;
        }

        // 3. Exclude wins.
        if self.exclude.is_match(rel_fwd) {
            return false;
        }

        // 4. Include (empty include list = allow all).
        if self.include.is_empty() {
            return true;
        }
        self.include.is_match(rel_fwd)
    }

    /// Return `true` if a directory should be skipped completely during tree traversal.
    pub fn is_dir_excluded(&self, rel_dir: &str) -> bool {
        let fwd = rel_dir.replace('\\', "/");
        let trimmed = fwd.trim_matches('/');
        if trimmed.is_empty() {
            return false;
        }
        let with_slash = format!("{trimmed}/");
        self.exclude.is_match(Path::new(trimmed)) || self.exclude.is_match(Path::new(&with_slash))
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn build_globset(patterns: &[String]) -> GlobSet {
    let mut builder = GlobSetBuilder::new();
    for pat in patterns {
        match Glob::new(pat) {
            Ok(g) => {
                builder.add(g);
            }
            Err(e) => {
                warn!("Invalid glob pattern {:?}: {e}", pat);
            }
        }
    }
    builder.build().unwrap_or_else(|_| GlobSet::empty())
}

/// Check hidden/system flag on the absolute path via Windows API.
/// On non-Windows or on error, returns `false` (don't block the file).
fn is_hidden_or_system(_rel: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
            INVALID_FILE_ATTRIBUTES,
        };
        let wide: Vec<u16> = _rel
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let attrs = unsafe { GetFileAttributesW(wide.as_ptr()) };
        if attrs == INVALID_FILE_ATTRIBUTES {
            return false;
        }
        (attrs & FILE_ATTRIBUTE_HIDDEN != 0) || (attrs & FILE_ATTRIBUTE_SYSTEM != 0)
    }
    #[cfg(not(windows))]
    {
        // On non-Windows treat dot-files as hidden.
        _rel.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('.'))
            .unwrap_or(false)
    }
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(inc: &[&str], exc: &[&str], max_mb: u64) -> Rules {
        Rules::new(
            &inc.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &exc.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            max_mb,
        )
    }

    #[test]
    fn empty_include_allows_all() {
        let r = rules(&[], &[], 0);
        assert!(r.allowed(Path::new("foo/bar.txt"), 100));
    }

    #[test]
    fn exclude_blocks() {
        let r = rules(&[], &["*.tmp"], 0);
        assert!(!r.allowed(Path::new("foo/bar.tmp"), 100));
        assert!(r.allowed(Path::new("foo/bar.txt"), 100));
    }

    #[test]
    fn exclude_wins_over_include() {
        let r = rules(&["**/*.txt"], &["**/*.txt"], 0);
        assert!(!r.allowed(Path::new("readme.txt"), 100));
    }

    #[test]
    fn include_filters_when_set() {
        let r = rules(&["**/*.rs"], &[], 0);
        assert!(r.allowed(Path::new("src/main.rs"), 100));
        assert!(!r.allowed(Path::new("Cargo.toml"), 100));
    }

    #[test]
    fn max_size_blocks() {
        let r = rules(&[], &[], 1); // 1 MB
        assert!(!r.allowed(Path::new("big.bin"), 2 * 1024 * 1024));
        assert!(r.allowed(Path::new("small.bin"), 512 * 1024));
    }

    #[test]
    fn node_modules_excluded() {
        let r = rules(&[], &["node_modules/**"], 0);
        assert!(!r.allowed(Path::new("node_modules/lodash/index.js"), 100));
        assert!(r.allowed(Path::new("src/index.js"), 100));
    }

    #[test]
    fn backslash_paths_normalised() {
        let r = rules(&[], &["*.tmp"], 0);
        // Windows-style path passed with backslash.
        assert!(!r.allowed(Path::new("foo\\bar.tmp"), 100));
    }

    #[test]
    fn zero_max_size_is_unlimited() {
        let r = rules(&[], &[], 0);
        assert!(r.allowed(Path::new("huge.iso"), u64::MAX));
    }

    #[test]
    fn git_dir_excluded() {
        let r = rules(&[], &[".git/**"], 0);
        assert!(!r.allowed(Path::new(".git/config"), 100));
        assert!(r.allowed(Path::new("src/lib.rs"), 100));
    }

    #[cfg(not(windows))]
    #[test]
    fn dotfiles_hidden_on_non_windows() {
        let r = rules(&[], &[], 0);
        assert!(!r.allowed(Path::new(".env"), 100));
        assert!(r.allowed(Path::new("env.txt"), 100));
    }
}

