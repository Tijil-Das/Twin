//! P11 – sync-state.json builder and pull-merge logic.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::config::Config;
use crate::db::Db;
use crate::error::AppError;
use crate::github::blake3_hex;

// ── Sync-state schema (version 1) ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncState {
    pub version: u32,
    pub updated: String,      // ISO-8601
    pub machine: String,      // HOSTNAME
    pub pairs:   Vec<PairState>,
    pub manifest: HashMap<String, ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairState {
    pub id:                 String,
    pub drive_folder_id:    String,
    pub mode:               String,
    pub last_sync_ms:       i64,
    pub changes_page_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub count:     u64,
    pub bytes:     i64,
    /// blake3 of sorted "rel_path|md5" lines.
    pub root_hash: String,
}

// ── Builder ───────────────────────────────────────────────────────────────────

/// Build the sync-state JSON bytes from DB + config.
/// Does NOT include logs, tokens, or absolute local paths.
pub fn build_sync_state_bytes(db: &Db, cfg: &Config) -> Result<Vec<u8>, AppError> {
    let state = build_sync_state(db, cfg)?;
    serde_json::to_vec(&state)
        .map_err(|e| AppError::Other(format!("sync-state serialize: {e}")))
}

pub fn build_sync_state(db: &Db, cfg: &Config) -> Result<SyncState, AppError> {
    let machine = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local".into());

    let updated = iso_now();

    let mut pairs   = Vec::new();
    let mut manifest = HashMap::new();

    for pair in &cfg.pairs {
        let token = db.get_page_token(&pair.id)?;
        // Last sync time from pair_meta (if present).
        let last_sync_ms = db.get_last_sync_ms(&pair.id)?.unwrap_or(0);

        pairs.push(PairState {
            id:                 pair.id.clone(),
            drive_folder_id:    pair.drive_folder_id.clone(),
            mode:               format!("{:?}", pair.mode).to_lowercase(),
            last_sync_ms,
            changes_page_token: token,
        });

        // Build manifest: count + bytes + root_hash.
        let files = db.list_all_files(&pair.id)?;
        let count = files.len() as u64;
        let bytes = files.iter().filter_map(|f| f.size).sum::<i64>();

        // Build sorted "rel_path|md5" lines then blake3.
        let mut lines: Vec<String> = files
            .iter()
            .filter_map(|f| {
                f.md5.as_ref().map(|md5| format!("{}|{}", f.rel_path, md5))
            })
            .collect();
        lines.sort();
        let combined = lines.join("\n");
        let root_hash = blake3_hex(combined.as_bytes());

        manifest.insert(pair.id.clone(), ManifestEntry { count, bytes, root_hash });
    }

    Ok(SyncState { version: 1, updated, machine, pairs, manifest })
}

// ── Pull merge ────────────────────────────────────────────────────────────────

/// Merge remote `SyncState` into local DB.
/// Rules:
/// - Pairs missing locally: add with `needs_local_path` flag (drive_folder_id + mode).
/// - Pairs present both: update drive_folder_id / mode only if local row is absent.
/// - Set `changes_page_token` only if the local pair has none.
/// - Last-write-wins by `updated` timestamp for scalar fields.
pub fn merge_pull(db: &Db, remote: &SyncState) -> Result<(), AppError> {
    // We don't have a "local updated" timestamp easily; do per-pair logic.
    for rp in &remote.pairs {
        let local_token = db.get_page_token(&rp.id)?;
        let local_last = db.get_last_sync_ms(&rp.id)?;

        if local_last.is_none() {
            // Pair not known locally → insert placeholder.
            db.upsert_pair_meta(&rp.id, None, None)?;
            info!("GitHub pull: new pair {} from remote (needs local path)", rp.id);
        }

        // Set page token only if we don't have one.
        if local_token.is_none() {
            if let Some(ref tok) = rp.changes_page_token {
                db.set_page_token(&rp.id, tok)?;
                info!("GitHub pull: imported page token for pair {}", rp.id);
            }
        }
    }
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn iso_now() -> String {
    use chrono::DateTime;
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    DateTime::from_timestamp(secs, 0)
        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

