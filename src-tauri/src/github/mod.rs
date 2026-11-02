//! P11 – GitHub config-sync module.
//!
//! Pushes `config/sync-state.json` (and optionally `config/config.toml`) to a
//! GitHub repo via the Contents API.  Pull merges remote state into local DB.
//!
//! Token: Credential Manager service `tether`, key `github_token` (never logged).
//! Timer: runs every `github_push_mins` minutes when governor is Running.

pub mod client;
pub mod state;

pub use client::GitHubClient;
pub use state::{build_sync_state, merge_pull};

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};
use tracing::{info, warn};

use crate::config;
use crate::db::Db;
use crate::error::AppError;
use crate::governor::Governor;

// ── Last-push hash cache ───────────────────────────────────────────────────────

/// In-memory + file cache of the blake3 hash of the last successfully pushed state.
pub struct PushCache {
    pub hash: Option<String>,
    pub path: PathBuf,
}

impl PushCache {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join("gh_last.txt");
        let hash = std::fs::read_to_string(&path).ok().map(|s| s.trim().to_string());
        Self { hash, path }
    }

    pub fn save(&mut self, hash: &str) {
        self.hash = Some(hash.to_string());
        let _ = std::fs::write(&self.path, hash);
    }
}

// ── Background push loop ───────────────────────────────────────────────────────

/// Long-running task: push state every `github_push_mins` minutes.
/// Spawned once from `main.rs` setup.
pub async fn push_loop(db: Arc<Db>, gov: Governor, data_dir: PathBuf, repo_root: PathBuf) {
    let cache = Arc::new(Mutex::new(PushCache::load(&data_dir)));

    loop {
        let cfg = config::load().unwrap_or_default();
        let push_mins = cfg.app.github_push_mins.max(1);

        sleep(Duration::from_secs(push_mins * 60)).await;
        gov.checkpoint().await;

        // Only push if token + repo are configured.
        let token = match crate::auth::github_token() {
            Ok(Some(t)) => t,
            _ => continue,
        };
        if cfg.github.repo.is_empty() {
            continue;
        }

        let client = GitHubClient::new(token, cfg.github.repo.clone(), cfg.github.branch.clone());
        let mut cache_lock = cache.lock().await;

        match do_push(&client, &db, &cfg, &mut cache_lock, &repo_root).await {
            Ok(pushed) => {
                if pushed {
                    info!("GitHub: state pushed successfully");
                }
            }
            Err(e) => {
                warn!("GitHub push error: {e}");
            }
        }
    }
}

/// Perform one push attempt.  Returns `true` if something was actually uploaded.
pub async fn do_push(
    client:    &GitHubClient,
    db:        &Db,
    cfg:       &config::Config,
    cache:     &mut PushCache,
    repo_root: &std::path::Path,
) -> Result<bool, AppError> {
    let json_bytes = state::build_sync_state_bytes(db, cfg)?;

    // Blake3 hash to detect changes.
    let hash = blake3_hex(&json_bytes);
    if cache.hash.as_deref() == Some(&hash) {
        return Ok(false); // unchanged
    }

    // Choose path: plain or gzip.
    const LIMIT: usize = 500 * 1024;
    let (path, content_bytes, delete_other): (&str, Vec<u8>, Option<&str>) =
        if json_bytes.len() <= LIMIT {
            ("config/sync-state.json", json_bytes, Some("config/sync-state.json.gz"))
        } else {
            let gz = gzip_compress(&json_bytes)?;
            if gz.len() > LIMIT {
                return Err(AppError::Other("GitHub: state too large even after gzip".into()));
            }
            ("config/sync-state.json.gz", gz, Some("config/sync-state.json"))
        };

    // Upload the main file.
    client.put_file(path, &content_bytes).await?;

    // Delete the alternative path if it exists (best-effort).
    if let Some(other) = delete_other {
        if other != path {
            let _ = client.delete_file(other).await;
        }
    }

    // Also push config.toml if it exists and has changed.
    let toml_path = repo_root.join("config").join("config.toml");
    if toml_path.exists() {
        if let Ok(toml_bytes) = std::fs::read(&toml_path) {
            let _ = client.put_file("config/config.toml", &toml_bytes).await;
        }
    }

    cache.save(&hash);
    Ok(true)
}

/// Pull remote state and merge into local DB + config.
pub async fn do_pull(
    client:    &GitHubClient,
    db:        &Db,
    data_dir:  &std::path::Path,
    repo_root: &std::path::Path,
) -> Result<(), AppError> {
    // Fetch sync-state.json (try gz first).
    let remote_bytes = match client.get_file("config/sync-state.json.gz").await {
        Ok(b) => gunzip_decompress(&b)?,
        Err(_) => client.get_file("config/sync-state.json").await?,
    };

    let remote: state::SyncState = serde_json::from_slice(&remote_bytes)
        .map_err(|e| AppError::Other(format!("GitHub: parse sync-state: {e}")))?;

    state::merge_pull(db, &remote)?;

    // Fetch config.toml if remote sha differs from what we last downloaded.
    let cfg_sha_path = data_dir.join("gh_cfg_sha.txt");
    let last_sha = std::fs::read_to_string(&cfg_sha_path).unwrap_or_default();
    let (cfg_bytes, cfg_sha) = client.get_file_with_sha("config/config.toml").await?;
    if cfg_sha != last_sha.trim() {
        let toml_path = repo_root.join("config").join("config.toml");
        // Atomic write via temp file.
        let tmp = toml_path.with_extension("toml.tmp");
        std::fs::write(&tmp, &cfg_bytes)
            .map_err(|e| AppError::Io(format!("write config tmp: {e}")))?;
        std::fs::rename(&tmp, &toml_path)
            .map_err(|e| AppError::Io(format!("rename config: {e}")))?;
        let _ = std::fs::write(&cfg_sha_path, &cfg_sha);
        info!("GitHub: config.toml updated from remote");
    }

    Ok(())
}

// ── Utilities ─────────────────────────────────────────────────────────────────

pub fn blake3_hex(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

pub(crate) fn gzip_compress(data: &[u8]) -> Result<Vec<u8>, AppError> {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data)
        .map_err(|e| AppError::Io(format!("gzip write: {e}")))?;
    enc.finish().map_err(|e| AppError::Io(format!("gzip finish: {e}")))
}

pub(crate) fn gunzip_decompress(data: &[u8]) -> Result<Vec<u8>, AppError> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut dec = GzDecoder::new(data);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)
        .map_err(|e| AppError::Io(format!("gunzip: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests;
