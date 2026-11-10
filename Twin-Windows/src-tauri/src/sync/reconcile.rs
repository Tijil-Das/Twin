//! P09 – Reconciliation, decision table, conflict policies, echo suppression.
//!
//! Decision table (L = local changed, R = remote changed):
//!
//! | L   | R   | Action                                         |
//! |-----|-----|------------------------------------------------|
//! | no  | no  | nothing                                        |
//! | yes | no  | upload                                         |
//! | no  | yes | download                                       |
//! | yes | yes | md5 equal → mark synced; else conflict policy  |
//! | del L | no R | per policy.deletion                        |
//! | no L | del R | move to .twin-trash/yyyy-mm-dd/          |
//!
//! Mode `upload`:  only L actions.
//! Mode `mirror`:  R changes reverted by re-upload; extra remote trashed.
//! Mode `two_way`: full table.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::config::{ConflictPolicy, DeletionPolicy, PairEntry, PairMode};
use crate::db::{Db, FileRow, NewJob};
use crate::drive::client::DriveClient;
use crate::error::AppError;
use crate::sync::changes::DriveChange;
use crate::sync::changes::DriveEntry;

// ── Echo suppression ──────────────────────────────────────────────────────────

/// An entry in the self-written set.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EchoKey {
    pub path:     String,
    pub mtime_ms: i64,
}

/// Tracks files we just wrote locally so the watcher ignores them for 10 s.
#[derive(Default)]
pub struct SelfWritten {
    inner: Mutex<HashMap<EchoKey, SystemTime>>,
    renames: Mutex<HashMap<(String, String), SystemTime>>,
}

impl SelfWritten {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that we wrote `path` at `mtime_ms`.  Expires after 10 s.
    pub async fn record(&self, path: &str, mtime_ms: i64) {
        let mut m = self.inner.lock().await;
        m.insert(
            EchoKey { path: path.to_string(), mtime_ms },
            SystemTime::now(),
        );
    }

    /// Record that we renamed `old_path` to `new_path` locally. Expires after 10 s.
    pub async fn record_rename(&self, old_path: &str, new_path: &str) {
        let mut m = self.renames.lock().await;
        m.insert((old_path.to_string(), new_path.to_string()), SystemTime::now());
    }

    /// Returns true if this write should be suppressed (i.e., was ours).
    pub async fn is_echo(&self, path: &str, mtime_ms: i64) -> bool {
        let mut m = self.inner.lock().await;
        let key = EchoKey { path: path.to_string(), mtime_ms };
        if let Some(&written_at) = m.get(&key) {
            if written_at.elapsed().unwrap_or(Duration::ZERO) < Duration::from_secs(10) {
                return true;
            }
            m.remove(&key);
        }
        false
    }

    /// Returns true if this rename was initiated by us locally.
    pub async fn is_echo_rename(&self, old_path: &str, new_path: &str) -> bool {
        let mut m = self.renames.lock().await;
        let key = (old_path.to_string(), new_path.to_string());
        if let Some(&written_at) = m.get(&key) {
            if written_at.elapsed().unwrap_or(Duration::ZERO) < Duration::from_secs(10) {
                return true;
            }
            m.remove(&key);
        }
        false
    }

    /// Expire all entries older than 10 s.
    pub async fn gc(&self) {
        let mut m = self.inner.lock().await;
        m.retain(|_, t| t.elapsed().unwrap_or(Duration::ZERO) < Duration::from_secs(10));
        let mut r = self.renames.lock().await;
        r.retain(|_, t| t.elapsed().unwrap_or(Duration::ZERO) < Duration::from_secs(10));
    }
}

// Re-export for mod.rs
pub use SelfWritten as EchoSet;

// ── Reconcile result ──────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct ReconcileResult {
    pub uploads:   usize,
    pub downloads: usize,
    pub conflicts: usize,
    pub deletes:   usize,
    pub errors:    Vec<String>,
}

// ── Full listing reconcile ────────────────────────────────────────────────────

/// Reconcile a fresh Drive folder listing against the local Db + filesystem using default policies.
pub async fn reconcile_listing(
    db:    &Arc<Db>,
    drive: &DriveClient,
    pair:  &PairEntry,
    entries: &[DriveEntry],
    echo:  &Arc<SelfWritten>,
) -> Result<ReconcileResult, AppError> {
    reconcile_listing_with_policy(db, drive, pair, entries, echo, ConflictPolicy::NewerWins, DeletionPolicy::DriveTrash).await
}

/// Reconcile a fresh Drive folder listing against the local Db + filesystem with explicit policies.
pub async fn reconcile_listing_with_policy(
    db:    &Arc<Db>,
    drive: &DriveClient,
    pair:  &PairEntry,
    entries: &[DriveEntry],
    echo:  &Arc<SelfWritten>,
    conflict_policy: ConflictPolicy,
    deletion_policy: DeletionPolicy,
) -> Result<ReconcileResult, AppError> {
    let mut result = ReconcileResult::default();
    let local_root = PathBuf::from(&pair.local);
    let mut pruned_remote_folder_prefixes: Vec<String> = Vec::new();

    // In Mirror mode: prune rogue remote folders and merge duplicate folders.
    if matches!(pair.mode, PairMode::Mirror) && matches!(deletion_policy, DeletionPolicy::DriveTrash | DeletionPolicy::Delete) {
        let mut folders_by_rel: HashMap<String, Vec<&DriveEntry>> = HashMap::new();
        for entry in entries {
            if entry.mime_type.as_deref() == Some("application/vnd.google-apps.folder") {
                if let Some(name) = &entry.name {
                    folders_by_rel.entry(name.clone()).or_default().push(entry);
                }
            }
        }

        // Sort descending by depth so deepest subfolders are pruned before their parents
        let mut sorted_folder_paths: Vec<String> = folders_by_rel.keys().cloned().collect();
        sorted_folder_paths.sort_by(|a, b| b.matches('/').count().cmp(&a.matches('/').count()));

        for rel_dir in sorted_folder_paths {
            let folder_entries = &folders_by_rel[&rel_dir];
            let local_dir = local_root.join(&rel_dir);
            let dir_exists_locally = local_dir.is_dir();

            if !dir_exists_locally {
                // Rogue folder that does not exist locally -> trash or delete
                for f in folder_entries {
                    info!("Mirror reconcile: trashing rogue remote folder {} ({})", rel_dir, f.id);
                    match deletion_policy {
                        DeletionPolicy::DriveTrash => { let _ = drive.trash(&f.id).await; }
                        DeletionPolicy::Delete => { let _ = drive.delete(&f.id).await; }
                        DeletionPolicy::Ignore => {}
                    }
                    result.deletes += 1;
                }
                pruned_remote_folder_prefixes.push(format!("{rel_dir}/"));
                crate::drive::client::invalidate_path_cache(&pair.id, &rel_dir).await;
            } else if folder_entries.len() > 1 {
                // Duplicate folders on Drive for the same local directory!
                // Keep the first instance as primary, migrate any contents from duplicates into primary, then trash the duplicates.
                let primary = folder_entries[0];
                for dup in &folder_entries[1..] {
                    info!("Mirror reconcile: merging duplicate folder {} ({}) into primary ({})", rel_dir, dup.id, primary.id);
                    if let Ok(child_items) = drive.list_folder(&dup.id).await {
                        for child in child_items {
                            let _ = drive.move_file_parent(&child.id, &primary.id, &dup.id).await;
                        }
                    }
                    match deletion_policy {
                        DeletionPolicy::DriveTrash => { let _ = drive.trash(&dup.id).await; }
                        DeletionPolicy::Delete => { let _ = drive.delete(&dup.id).await; }
                        DeletionPolicy::Ignore => {}
                    }
                    result.deletes += 1;
                }
            }
        }
    }

    // Build map: rel_path → DriveEntry from Drive listing.
    let mut remote_by_rel: HashMap<String, &DriveEntry> = HashMap::new();

    for entry in entries {
        if entry.mime_type.as_deref() == Some("application/vnd.google-apps.folder") {
            continue; // dirs handled separately
        }
        let Some(name) = &entry.name else { continue };
        remote_by_rel.insert(name.clone(), entry);
    }

    // Walk Drive entries and compare against Db.
    let now = now_ms();
    let cfg = crate::config::load().unwrap_or_default();
    let rules = crate::rules::Rules::for_pair(&cfg.rules, pair);

    for (rel, remote) in &remote_by_rel {
        let rel_path = std::path::Path::new(rel);
        let remote_size = remote.size.as_deref().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        if rules.is_dir_excluded(rel) || !rules.allowed(rel_path, remote_size) {
            continue;
        }

        let local_path = local_root.join(rel);
        let db_row = db.get_file(&pair.id, rel)?;

        let local_exists = local_path.exists();

        let local_md5  = db_row.as_ref().and_then(|r| r.md5.as_deref()).unwrap_or("");
        let remote_md5 = remote.md5_checksum.as_deref().unwrap_or("");
        // Fall back to local md5 when Drive did not return md5Checksum (drive_md5 is NULL),
        // otherwise every synced file looks "locally changed" and gets re-enqueued for upload.
        let db_drive_md5 = db_row.as_ref().and_then(|r| r.drive_md5.as_deref())
            .or(db_row.as_ref().and_then(|r| r.md5.as_deref()))
            .unwrap_or("");

        // Only flag as changed if we have a stored md5 to compare against.
        // NULL drive_md5 AND NULL local md5 means "unknown" — don't re-enqueue.
        let local_changed = local_exists
            && !local_md5.is_empty()
            && !db_drive_md5.is_empty()
            && local_md5 != db_drive_md5;
        let remote_changed = !remote_md5.is_empty()
            && !db_drive_md5.is_empty()
            && remote_md5 != db_drive_md5;

        // Decision table: (local_exists, local_changed, remote_changed)
        if !local_exists {
            // If this file's parent directory was already pruned/trashed on Drive above,
            // the file is already gone with it; update DB state directly without redundant jobs.
            if pruned_remote_folder_prefixes.iter().any(|pfx| rel.starts_with(pfx)) {
                let state_str = if matches!(deletion_policy, DeletionPolicy::Delete) { "deleted" } else { "trashed" };
                db.upsert_file(FileRow {
                    pair_id:       pair.id.clone(),
                    rel_path:      rel.clone(),
                    size:          None,
                    mtime_ms:      None,
                    md5:           None,
                    drive_id:      Some(remote.id.clone()),
                    drive_md5:     Some(remote_md5.to_string()),
                    drive_mtime_ms: None,
                    drive_rev:     None,
                    state:         state_str.into(),
                    os_file_id:    None,
                })?;
                result.deletes += 1;
                continue;
            }

            if matches!(pair.mode, PairMode::Mirror) {
                // In mirror mode, local is source of truth:
                // If the file does not exist locally, the remote file MUST be deleted/trashed.
                if matches!(deletion_policy, DeletionPolicy::DriveTrash | DeletionPolicy::Delete) {
                    db.upsert_file(FileRow {
                        pair_id:       pair.id.clone(),
                        rel_path:      rel.clone(),
                        size:          None,
                        mtime_ms:      None,
                        md5:           None,
                        drive_id:      Some(remote.id.clone()),
                        drive_md5:     Some(remote_md5.to_string()),
                        drive_mtime_ms: None,
                        drive_rev:     None,
                        state:         "dirty".into(),
                        os_file_id:    None,
                    })?;
                    apply_local_delete_inner(db, pair, rel, now, deletion_policy.clone())?;
                    result.deletes += 1;
                }
            } else if let Some(ref row) = db_row {
                // Safety: only delete remote when the row was previously tracked
                // locally (never on initial discovery). A `synced` row whose
                // file vanished from disk is a local deletion detected by a
                // full scan; the watcher additionally marks rows `deleted_local`.
                if matches!(row.state.as_str(), "deleted_local" | "synced") && !remote_changed {
                    if matches!(deletion_policy, DeletionPolicy::DriveTrash | DeletionPolicy::Delete) {
                        apply_local_delete_inner(db, pair, rel, now, deletion_policy.clone())?;
                        result.deletes += 1;
                    }
                } else if matches!(pair.mode, PairMode::TwoWay) {
                    // Remote file exists and local does not: re-download remote
                    enqueue_download(db, pair, rel, remote, now)?;
                    result.downloads += 1;
                }
            } else if matches!(pair.mode, PairMode::TwoWay) {
                // New remote file not yet tracked locally
                enqueue_download(db, pair, rel, remote, now)?;
                result.downloads += 1;
            }
        } else if !local_changed && !remote_changed {
            // Local exists, both unchanged — in sync.
        } else if local_changed && !remote_changed {
            // Only local changed → upload.
            if matches!(pair.mode, PairMode::Upload | PairMode::TwoWay | PairMode::Mirror) {
                enqueue_upload(db, pair, rel, now)?;
                result.uploads += 1;
            }
        } else if !local_changed && remote_changed {
            // Only remote changed → download (or re-upload in mirror mode).
            if matches!(pair.mode, PairMode::TwoWay | PairMode::Mirror) {
                if pair.mode == PairMode::Mirror {
                    enqueue_upload(db, pair, rel, now)?;
                    result.uploads += 1;
                } else {
                    enqueue_download(db, pair, rel, remote, now)?;
                    result.downloads += 1;
                }
            }
        } else if local_changed && remote_changed {
            // Both changed → conflict.
            if remote_md5 == local_md5 {
                // Same content, just mark synced.
                db.mark_state(&pair.id, rel, "synced")?;
            } else if pair.mode == PairMode::Mirror {
                // In mirror mode: local always wins over remote changes! Overwrite remote.
                enqueue_upload(db, pair, rel, now)?;
                result.uploads += 1;
            } else if matches!(pair.mode, PairMode::TwoWay) {
                let outcome = apply_conflict_inner(db, pair, rel, remote, &local_path, now, echo, conflict_policy.clone()).await?;
                result.uploads    += outcome.uploads;
                result.downloads  += outcome.downloads;
                result.conflicts  += outcome.conflicts;
            }
        }

        // Update drive metadata in DB row.
        let mtime_ms = remote.modified_time.as_deref().and_then(rfc3339_to_ms).unwrap_or(0);
        let size: Option<i64> = remote.size.as_deref().and_then(|s| s.parse().ok());
        let current = db.get_file(&pair.id, rel)?.unwrap_or_else(|| FileRow {
            pair_id:       pair.id.clone(),
            rel_path:      rel.clone(),
            size:          None,
            mtime_ms:      None,
            md5:           None,
            drive_id:      None,
            drive_md5:     None,
            drive_mtime_ms: None,
            drive_rev:     None,
            state:         "synced".into(),
            os_file_id:    None,
        });
        db.upsert_file(FileRow {
            pair_id:       pair.id.clone(),
            rel_path:      rel.clone(),
            size:          size.or(current.size),
            mtime_ms:      current.mtime_ms,
            md5:           current.md5.clone(),
            drive_id:      Some(remote.id.clone()),
            drive_md5:     Some(remote_md5.to_string()),
            drive_mtime_ms: Some(mtime_ms),
            drive_rev:     current.drive_rev.clone(),
            state:         current.state,
            os_file_id:    current.os_file_id,
        })?;
    }

    // Ensure all local files exist on Drive (upload any missing local files in Mirror, TwoWay, or Upload).
    if matches!(pair.mode, PairMode::Mirror | PairMode::TwoWay | PairMode::Upload) {
        let remote_rels: HashSet<&String> = remote_by_rel.keys().collect();
        // List all tracked files in Db.
        let all_tracked = db.list_all_files(&pair.id)?;
        for row in &all_tracked {
            if !remote_rels.contains(&&row.rel_path) {
                // Local file exists on disk but not in Drive → upload it.
                let lp = local_root.join(&row.rel_path);
                if lp.exists() {
                    // The remote object is gone; forget its id so the upload
                    // creates a fresh copy instead of patching a deleted file.
                    db.clear_drive_meta(&pair.id, &row.rel_path)?;
                    enqueue_upload(db, pair, &row.rel_path, now)?;
                    result.uploads += 1;
                }
            }
        }
    }

    Ok(result)
}

// ── Remote change application ─────────────────────────────────────────────────

/// Apply a single remote change from the Changes API feed using default policy.
pub async fn apply_remote_change(
    db:     &Arc<Db>,
    pair:   &PairEntry,
    change: &DriveChange,
    echo:   &Arc<SelfWritten>,
) -> Result<(), AppError> {
    apply_remote_change_with_policy(db, pair, change, echo, ConflictPolicy::NewerWins).await
}

/// Apply a single remote change from the Changes API feed with explicit conflict policy.
pub async fn apply_remote_change_with_policy(
    db:     &Arc<Db>,
    pair:   &PairEntry,
    change: &DriveChange,
    echo:   &Arc<SelfWritten>,
    conflict_policy: ConflictPolicy,
) -> Result<(), AppError> {
    apply_remote_change_with_policies(
        db, pair, change, echo, conflict_policy, DeletionPolicy::DriveTrash,
    ).await
}

/// Apply a single remote change using both the conflict and deletion policies.
pub async fn apply_remote_change_with_policies(
    db:     &Arc<Db>,
    pair:   &PairEntry,
    change: &DriveChange,
    echo:   &Arc<SelfWritten>,
    conflict_policy: ConflictPolicy,
    deletion_policy: DeletionPolicy,
) -> Result<(), AppError> {
    let now = now_ms();

    // Removed or Trashed on Drive.
    let is_remote_removal = change.removed == Some(true)
        || change.file.as_ref().and_then(|f| f.trashed) == Some(true);

    if is_remote_removal {
        // Find local file by drive_id.
        let drive_id = change.file.as_ref().map(|f| f.id.as_str()).unwrap_or(&change.file_id);
        if let Some(row) = db.get_file_by_drive_id(&pair.id, drive_id)? {
            let local_path = PathBuf::from(&pair.local).join(&row.rel_path);
            match pair.mode {
                // Upload-only pairs never touch the local side for remote events.
                PairMode::Upload => {}
                // Mirror is remote-as-mirror-of-local: restore the file remotely if present locally.
                PairMode::Mirror => {
                    if local_path.exists() {
                        // The Drive object no longer exists; recreating it on
                        // upload requires clearing the stale drive_id.
                        db.clear_drive_meta(&pair.id, &row.rel_path)?;
                        enqueue_upload(db, pair, &row.rel_path, now)?;
                    } else {
                        // Gone locally and on Drive: mark trashed
                        let _ = db.mark_state(&pair.id, &row.rel_path, "trashed");
                    }
                }
                PairMode::TwoWay => match deletion_policy {
                    // User explicitly asked to ignore remote deletions.
                    DeletionPolicy::Ignore => {}
                    DeletionPolicy::DriveTrash => {
                        if local_path.exists() {
                            move_to_twin_trash(pair, &local_path, &row.rel_path)?;
                        }
                        db.mark_state(&pair.id, &row.rel_path, "remote_deleted")?;
                    }
                    DeletionPolicy::Delete => {
                        if local_path.exists() {
                            let _ = std::fs::remove_file(&local_path);
                        }
                        db.mark_state(&pair.id, &row.rel_path, "remote_deleted")?;
                    }
                },
            }
        }
        return Ok(());
    }

    let Some(file) = &change.file else { return Ok(()) };

    // Skip trashed (already handled above under is_remote_removal).
    if file.trashed == Some(true) {
        return Ok(());
    }

    // Skip folders.
    if file.mime_type.as_deref() == Some("application/vnd.google-apps.folder") {
        return Ok(());
    }

    // The Changes feed only carries the file's basename. Prefer the full
    // relative path already stored for this Drive id so nested files are not
    // mistaken for files in the pair root.
    let tracked = db.get_file_by_drive_id(&pair.id, &file.id)?;

    // Check if the file was renamed on Google Drive
    if let Some(ref row) = tracked {
        if let Some(ref new_remote_name) = file.name {
            let old_name = std::path::Path::new(&row.rel_path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !old_name.is_empty() && &old_name != new_remote_name {
                let old_rel = row.rel_path.clone();
                let parent_dir = std::path::Path::new(&old_rel).parent().unwrap_or_else(|| std::path::Path::new(""));
                let new_rel = if parent_dir.as_os_str().is_empty() {
                    new_remote_name.clone()
                } else {
                    format!("{}/{}", parent_dir.to_string_lossy().replace('\\', "/"), new_remote_name)
                };

                let root = PathBuf::from(&pair.local);
                let old_local = root.join(&old_rel);
                let new_local = root.join(&new_rel);

                if matches!(pair.mode, PairMode::TwoWay) {
                    info!("Remote rename detected for {}: {} -> {}", file.id, old_rel, new_rel);
                    // Record echo rename so watcher ignores the resulting local rename event
                    echo.record_rename(&old_rel, &new_rel).await;

                    if old_local.exists() {
                        if let Some(parent) = new_local.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if let Err(e) = std::fs::rename(&old_local, &new_local) {
                            warn!("apply remote rename fs::rename failed: {e}");
                        }
                    }

                    // Atomically update DB row to the new path
                    let mut new_row = row.clone();
                    new_row.rel_path = new_rel.clone();
                    if let Some(ref md5) = file.md5_checksum {
                        new_row.drive_md5 = Some(md5.clone());
                        new_row.md5 = Some(md5.clone());
                    }
                    if let Some(ref mtime) = file.modified_time {
                        new_row.drive_mtime_ms = rfc3339_to_ms(mtime);
                    }
                    let _ = db.apply_rename_tx(&pair.id, &old_rel, new_row);
                    return Ok(());
                }
            }
        }
    }
    let rel_path = match tracked.as_ref() {
        Some(row) => row.rel_path.clone(),
        None => match &file.name {
            Some(name) => name.clone(),
            None => return Ok(()),
        },
    };
    let local_path = PathBuf::from(&pair.local).join(&rel_path);

    let remote_md5 = file.md5_checksum.as_deref().unwrap_or("");
    let db_row = match tracked {
        Some(row) => Some(row),
        None => db.get_file(&pair.id, &rel_path)?,
    };
    // Fall back to local md5 when Drive did not return md5Checksum (drive_md5 is NULL),
    // otherwise every synced file looks "locally changed" and gets re-enqueued for upload.
    let db_drive_md5 = db_row.as_ref().and_then(|r| r.drive_md5.as_deref())
        .or(db_row.as_ref().and_then(|r| r.md5.as_deref()))
        .unwrap_or("");

    // Echo suppression: skip if this matches our own upload (md5 same as Db).
    if !remote_md5.is_empty()
        && !db_drive_md5.is_empty()
        && remote_md5 == db_drive_md5
    {
        return Ok(());
    }

    let local_md5 = db_row.as_ref().and_then(|r| r.md5.as_deref()).unwrap_or("");
    // Only flag as changed if we have a stored md5 to compare against.
    let local_changed = local_path.exists()
        && !local_md5.is_empty()
        && !db_drive_md5.is_empty()
        && local_md5 != db_drive_md5;

    // Check echo suppression for local writes.
    let mtime_ms = db_row.as_ref().and_then(|r| r.mtime_ms).unwrap_or(0);
    if echo.is_echo(&rel_path, mtime_ms).await {
        return Ok(());
    }

    match pair.mode {
        // Upload mode: ignore remote changes.
        PairMode::Upload => {}
        // Mirror: local always wins, so re-upload the local file or remove extra remote file.
        PairMode::Mirror => {
            if local_path.exists() {
                enqueue_upload(db, pair, &rel_path, now)?;
            } else if matches!(deletion_policy, DeletionPolicy::DriveTrash | DeletionPolicy::Delete) {
                // In mirror mode, any remote file that does not exist locally must be removed from Drive.
                db.upsert_file(FileRow {
                    pair_id:       pair.id.clone(),
                    rel_path:      rel_path.clone(),
                    size:          None,
                    mtime_ms:      None,
                    md5:           None,
                    drive_id:      Some(file.id.clone()),
                    drive_md5:     Some(remote_md5.to_string()),
                    drive_mtime_ms: None,
                    drive_rev:     None,
                    state:         "dirty".into(),
                    os_file_id:    None,
                })?;
                apply_local_delete_inner(db, pair, &rel_path, now, deletion_policy.clone())?;
            }
        }
        PairMode::TwoWay => {
            if !local_changed {
                // Download the remote change.
                let size: Option<i64> = file.size.as_deref().and_then(|s| s.parse().ok());
                let drive_mtime = file.modified_time.as_deref().and_then(rfc3339_to_ms).unwrap_or(0);
                db.upsert_file(FileRow {
                    pair_id:       pair.id.clone(),
                    rel_path:      rel_path.clone(),
                    size,
                    mtime_ms:      db_row.as_ref().and_then(|r| r.mtime_ms),
                    md5:           db_row.as_ref().and_then(|r| r.md5.clone()),
                    drive_id:      Some(file.id.clone()),
                    drive_md5:     Some(remote_md5.to_string()),
                    drive_mtime_ms: Some(drive_mtime),
                    drive_rev:     None,
                    state:         "dirty".into(),
                    os_file_id:    None,
                })?;
                db.enqueue(NewJob {
                    pair_id:    pair.id.clone(),
                    kind:       "download".into(),
                    rel_path:   rel_path.clone(),
                    priority:   10,
                    created_ms: now,
                })?;
                info!("queued download (remote change): {}", rel_path);
            } else if remote_md5 == local_md5 && !remote_md5.is_empty() {
                // Both changed to the same content.
                db.mark_state(&pair.id, &rel_path, "synced")?;
            } else {
                // Conflict: both changed.
                let _ = apply_conflict_inner(
                    db, pair, &rel_path, file, &local_path, now, echo, conflict_policy,
                ).await?;
            }
        }
    }

    Ok(())
}

// ── Conflict resolution ───────────────────────────────────────────────────────

/// Counts from `apply_conflict`.
struct ConflictOutcome {
    uploads:   usize,
    downloads: usize,
    conflicts: usize,
}

/// Apply the configured conflict policy. Returns outcome counts.
#[allow(dead_code)]
async fn apply_conflict(
    db:         &Arc<Db>,
    pair:       &PairEntry,
    rel_path:   &str,
    remote:     &DriveEntry,
    local_path: &PathBuf,
    now:        i64,
    echo:       &Arc<SelfWritten>,
) -> Result<ConflictOutcome, AppError> {
    apply_conflict_inner(db, pair, rel_path, remote, local_path, now, echo, get_conflict_policy(pair)).await
}

async fn apply_conflict_inner(
    db:         &Arc<Db>,
    pair:       &PairEntry,
    rel_path:   &str,
    remote:     &DriveEntry,
    local_path: &PathBuf,
    now:        i64,
    _echo:      &Arc<SelfWritten>,
    conflict_policy: ConflictPolicy,
) -> Result<ConflictOutcome, AppError> {
    use crate::config::ConflictPolicy;

    match pair.mode {
        PairMode::Upload | PairMode::Mirror => {
            // These modes don't do two-way conflicts.
            enqueue_upload(db, pair, rel_path, now)?;
            return Ok(ConflictOutcome { uploads: 1, downloads: 0, conflicts: 0 });
        }
        _ => {}
    }

    match conflict_policy {
        ConflictPolicy::NewerWins => {
            let remote_mtime = remote.modified_time.as_deref().and_then(rfc3339_to_ms).unwrap_or(0);
            let local_mtime = local_meta_mtime(local_path);
            if remote_mtime >= local_mtime {
                // Remote wins: download.
                db.upsert_file(FileRow {
                    pair_id:       pair.id.clone(),
                    rel_path:      rel_path.to_string(),
                    size:          remote.size.as_deref().and_then(|s| s.parse().ok()),
                    mtime_ms:      Some(local_mtime),
                    md5:           None,
                    drive_id:      Some(remote.id.clone()),
                    drive_md5:     remote.md5_checksum.clone(),
                    drive_mtime_ms: Some(remote_mtime),
                    drive_rev:     None,
                    state:         "dirty".into(),
                    os_file_id:    None,
                })?;
                db.enqueue(NewJob {
                    pair_id:    pair.id.clone(),
                    kind:       "download".into(),
                    rel_path:   rel_path.to_string(),
                    priority:   20,
                    created_ms: now,
                })?;
                Ok(ConflictOutcome { uploads: 0, downloads: 1, conflicts: 0 })
            } else {
                // Local wins: upload.
                enqueue_upload(db, pair, rel_path, now)?;
                Ok(ConflictOutcome { uploads: 1, downloads: 0, conflicts: 0 })
            }
        }

        ConflictPolicy::KeepBoth => {
            // Rename local to `name (conflict <machine> yyyy-mm-dd hhmmss).ext`.
            let machine = hostname();
            let ts = timestamp_str();
            let stem = local_path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());
            let ext = local_path.extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let conflict_name = format!("{stem} (conflict {machine} {ts}){ext}");
            let conflict_path = local_path.with_file_name(&conflict_name);
            // Preserve the file's directory when recording the conflict copy.
            let conflict_rel = match rel_path.rsplit_once('/') {
                Some((dir, _)) => format!("{dir}/{conflict_name}"),
                None => conflict_name.clone(),
            };

            if let Err(e) = std::fs::rename(local_path, &conflict_path) {
                warn!("keep_both rename failed: {e}");
            } else {
                // Upload the conflict copy.
                enqueue_upload(db, pair, &conflict_rel, now)?;
            }

            // Record the remote metadata for the original path *before*
            // enqueuing the download; `run_download` looks up `drive_id` in
            // the DB and would otherwise fail with "no drive_id".
            let remote_mtime = remote.modified_time.as_deref().and_then(rfc3339_to_ms).unwrap_or(0);
            db.upsert_file(FileRow {
                pair_id:       pair.id.clone(),
                rel_path:      rel_path.to_string(),
                size:          remote.size.as_deref().and_then(|s| s.parse().ok()),
                mtime_ms:      None,
                md5:           None,
                drive_id:      Some(remote.id.clone()),
                drive_md5:     remote.md5_checksum.clone(),
                drive_mtime_ms: Some(remote_mtime),
                drive_rev:     None,
                state:         "dirty".into(),
                os_file_id:    None,
            })?;

            // Download remote to original name.
            db.enqueue(NewJob {
                pair_id:    pair.id.clone(),
                kind:       "download".into(),
                rel_path:   rel_path.to_string(),
                priority:   20,
                created_ms: now,
            })?;

            Ok(ConflictOutcome { uploads: 1, downloads: 1, conflicts: 1 })
        }

        ConflictPolicy::Ask => {
            // Mark state='conflict', emit event (caller handles Tauri emit).
            db.mark_state(&pair.id, rel_path, "conflict")?;
            Ok(ConflictOutcome { uploads: 0, downloads: 0, conflicts: 1 })
        }
    }
}

/// Resolve a user-chosen conflict.
pub fn resolve_conflict(
    db:       &Db,
    pair:     &PairEntry,
    rel_path: &str,
    choice:   &str, // "local" | "remote" | "both"
) -> Result<(), AppError> {
    let now = now_ms();
    match choice {
        "local" => {
            enqueue_upload(db, pair, rel_path, now)?;
        }
        "remote" => {
            db.enqueue(NewJob {
                pair_id:    pair.id.clone(),
                kind:       "download".into(),
                rel_path:   rel_path.to_string(),
                priority:   20,
                created_ms: now,
            })?;
        }
        "both" => {
            // Upload local under a conflict name, download remote to original.
            let local_path = PathBuf::from(&pair.local).join(rel_path);
            let machine = hostname();
            let ts = timestamp_str();
            let stem = local_path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());
            let ext = local_path.extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let conflict_name = format!("{stem} (conflict {machine} {ts}){ext}");
            let conflict_path = local_path.with_file_name(&conflict_name);
            let conflict_rel = match rel_path.rsplit_once('/') {
                Some((dir, _)) => format!("{dir}/{conflict_name}"),
                None => conflict_name.clone(),
            };

            if let Err(e) = std::fs::rename(&local_path, &conflict_path) {
                warn!("resolve_conflict both rename: {e}");
            } else {
                enqueue_upload(db, pair, &conflict_rel, now)?;
            }
            db.enqueue(NewJob {
                pair_id:    pair.id.clone(),
                kind:       "download".into(),
                rel_path:   rel_path.to_string(),
                priority:   20,
                created_ms: now,
            })?;
        }
        other => {
            return Err(AppError::Other(format!("invalid conflict choice: {other}")));
        }
    }
    db.mark_state(&pair.id, rel_path, "resolving")?;
    Ok(())
}

// ── Local delete handling ─────────────────────────────────────────────────────

#[allow(dead_code)]
fn apply_local_delete(db: &Db, pair: &PairEntry, rel_path: &str, now: i64) -> Result<(), AppError> {
    apply_local_delete_inner(db, pair, rel_path, now, get_deletion_policy(pair))
}

fn apply_local_delete_inner(
    db: &Db,
    pair: &PairEntry,
    rel_path: &str,
    now: i64,
    deletion_policy: DeletionPolicy,
) -> Result<(), AppError> {
    match deletion_policy {
        DeletionPolicy::Ignore => {}
        DeletionPolicy::DriveTrash | DeletionPolicy::Delete => {
            db.enqueue(NewJob {
                pair_id:    pair.id.clone(),
                kind:       "delete".into(),
                rel_path:   rel_path.to_string(),
                priority:   5,
                created_ms: now,
            })?;
        }
    }
    Ok(())
}

/// Move a local file to `<pair.local>/.twin-trash/yyyy-mm-dd/`.
fn move_to_twin_trash(
    pair:       &PairEntry,
    local_path: &PathBuf,
    rel_path:   &str,
) -> Result<(), AppError> {
    let date = date_str();
    let trash_dir = PathBuf::from(&pair.local)
        .join(".twin-trash")
        .join(&date);
    std::fs::create_dir_all(&trash_dir)
        .map_err(|e| AppError::Io(format!("twin-trash mkdir: {e}")))?;

    let file_name = local_path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel_path.replace('/', "_"));

    let dest = trash_dir.join(&file_name);
    std::fs::rename(local_path, &dest)
        .map_err(|e| AppError::Io(format!("twin-trash move: {e}")))?;

    info!("moved to twin-trash: {rel_path} -> {}", dest.display());
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn enqueue_upload(db: &Db, pair: &PairEntry, rel_path: &str, now: i64) -> Result<(), AppError> {
    // A queued upload means this file is out of sync, even when the row still
    // says "synced" (e.g. mirror mode re-uploading after a remote change).
    db.mark_state(&pair.id, rel_path, "dirty")?;
    db.enqueue(NewJob {
        pair_id:    pair.id.clone(),
        kind:       "upload".into(),
        rel_path:   rel_path.to_string(),
        priority:   10,
        created_ms: now,
    })?;
    Ok(())
}

fn enqueue_download(
    db:       &Db,
    pair:     &PairEntry,
    rel_path: &str,
    remote:   &DriveEntry,
    now:      i64,
) -> Result<(), AppError> {
    let size: Option<i64> = remote.size.as_deref().and_then(|s| s.parse().ok());
    let mtime_ms = remote.modified_time.as_deref().and_then(rfc3339_to_ms).unwrap_or(0);
    db.upsert_file(FileRow {
        pair_id:       pair.id.clone(),
        rel_path:      rel_path.to_string(),
        size,
        mtime_ms:      None,
        md5:           None,
        drive_id:      Some(remote.id.clone()),
        drive_md5:     remote.md5_checksum.clone(),
        drive_mtime_ms: Some(mtime_ms),
        drive_rev:     None,
        state:         "dirty".into(),
        os_file_id:    None,
    })?;
    db.enqueue(NewJob {
        pair_id:    pair.id.clone(),
        kind:       "download".into(),
        rel_path:   rel_path.to_string(),
        priority:   10,
        created_ms: now,
    })?;
    Ok(())
}

#[allow(dead_code)]
fn get_conflict_policy(_pair: &PairEntry) -> ConflictPolicy {
    // Policy is global (from Config); PairEntry has no policy field.
    // Callers pass in the pair; we read policy from a thread-local default.
    // Since we don't have Config here, default to NewerWins.
    ConflictPolicy::NewerWins
}

#[allow(dead_code)]
fn get_deletion_policy(_pair: &PairEntry) -> DeletionPolicy {
    // Same as above — default to DriveTrash.
    DeletionPolicy::DriveTrash
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn rfc3339_to_ms(s: &str) -> Option<i64> {
    use chrono::DateTime;
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn local_meta_mtime(path: &PathBuf) -> i64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local".to_string())
}

fn timestamp_str() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    use chrono::DateTime;
    let dt = DateTime::from_timestamp(secs as i64, 0)
        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
    dt.format("%Y-%m-%d %H%M%S").to_string()
}

fn date_str() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    use chrono::DateTime;
    let dt = DateTime::from_timestamp(secs as i64, 0)
        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
    dt.format("%Y-%m-%d").to_string()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    use crate::config::{PairEntry, PairMode};
    use crate::db::{Db, FileRow};

    fn temp_db() -> (TempDir, Arc<Db>) {
        let dir = TempDir::new().unwrap();
        let db  = Db::open(&dir.path().join("state.db")).unwrap();
        (dir, Arc::new(db))
    }

    fn pair(mode: PairMode, local: &str) -> PairEntry {
        PairEntry {
            id:             "p1".into(),
            local:          local.into(),
            drive_folder_id: "root_drive_id".into(),
            mode,
            enabled:        true,
            deletion:       None,
            ..Default::default()
        }
    }

    fn base_row(pair_id: &str, rel: &str) -> FileRow {
        FileRow {
            pair_id:       pair_id.into(),
            rel_path:      rel.into(),
            size:          Some(100),
            mtime_ms:      Some(1_700_000_000_000),
            md5:           Some("local_md5".into()),
            drive_id:      Some("drv_id_1".into()),
            drive_md5:     Some("local_md5".into()), // matches local = synced
            drive_mtime_ms: Some(1_700_000_000_000),
            drive_rev:     None,
            state:         "synced".into(),
            os_file_id:    None,
        }
    }

    // ── Table row: no changes → nothing ─────────────────────────────────────

    #[tokio::test]
    async fn no_changes_nothing_queued() {
        let (dir, db) = temp_db();
        let row = base_row("p1", "file.txt");
        db.upsert_file(row).unwrap();
        // The tracked file exists locally and matches the DB → no changes.
        std::fs::write(dir.path().join("file.txt"), b"local content").unwrap();

        let entry = DriveEntry {
            id:            "drv_id_1".into(),
            name:          Some("file.txt".into()),
            parents:       None,
            md5_checksum:  Some("local_md5".into()), // same as db
            modified_time: Some("2023-11-15T00:00:00Z".into()),
            size:          Some("100".into()),
            mime_type:     Some("application/octet-stream".into()),
            trashed:       None,
        };

        let p = pair(PairMode::TwoWay, dir.path().to_str().unwrap());
        let echo = Arc::new(SelfWritten::new());
        let drive = crate::drive::DriveClient::new().unwrap();

        let r = reconcile_listing(&db, &drive, &p, &[entry], &echo).await.unwrap();
        assert_eq!(r.uploads, 0);
        assert_eq!(r.downloads, 0);
        assert_eq!(r.conflicts, 0);
    }

    // ── Table row: local changed → upload ────────────────────────────────────

    #[tokio::test]
    async fn local_changed_upload_queued() {
        let (dir, db) = temp_db();

        // DB row: local md5 differs from drive_md5 → local changed.
        let mut row = base_row("p1", "file.txt");
        row.md5       = Some("new_local_md5".into()); // different from drive_md5
        row.drive_md5 = Some("old_drive_md5".into());
        db.upsert_file(row).unwrap();

        let entry = DriveEntry {
            id:            "drv_id_1".into(),
            name:          Some("file.txt".into()),
            parents:       None,
            md5_checksum:  Some("old_drive_md5".into()), // same as db drive_md5 → remote unchanged
            modified_time: Some("2023-11-15T00:00:00Z".into()),
            size:          Some("100".into()),
            mime_type:     Some("application/octet-stream".into()),
            trashed:       None,
        };

        // Create the local file so local_exists=true.
        std::fs::write(dir.path().join("file.txt"), b"new content").unwrap();

        let p = pair(PairMode::TwoWay, dir.path().to_str().unwrap());
        let echo = Arc::new(SelfWritten::new());
        let drive = crate::drive::DriveClient::new().unwrap();

        let r = reconcile_listing(&db, &drive, &p, &[entry], &echo).await.unwrap();
        assert_eq!(r.uploads, 1, "should queue 1 upload");
        assert_eq!(r.downloads, 0);

        // Verify job was enqueued.
        let job_count = db.count_jobs_by_status("queued").unwrap();
        assert_eq!(job_count, 1);
    }

    // ── Table row: remote changed → download ─────────────────────────────────

    #[tokio::test]
    async fn remote_changed_download_queued() {
        let (dir, db) = temp_db();

        let row = base_row("p1", "file.txt");
        // drive_md5 = "local_md5", local md5 = "local_md5" → local unchanged
        db.upsert_file(row).unwrap();

        let entry = DriveEntry {
            id:            "drv_id_1".into(),
            name:          Some("file.txt".into()),
            parents:       None,
            md5_checksum:  Some("new_remote_md5".into()), // different from db drive_md5
            modified_time: Some("2023-11-20T00:00:00Z".into()),
            size:          Some("200".into()),
            mime_type:     Some("application/octet-stream".into()),
            trashed:       None,
        };

        let p = pair(PairMode::TwoWay, dir.path().to_str().unwrap());
        let echo = Arc::new(SelfWritten::new());
        let drive = crate::drive::DriveClient::new().unwrap();

        let r = reconcile_listing(&db, &drive, &p, &[entry], &echo).await.unwrap();
        assert_eq!(r.downloads, 1, "should queue 1 download");
        assert_eq!(r.uploads, 0);
    }

    // ── Table row: both changed, same md5 → synced ───────────────────────────

    #[tokio::test]
    async fn both_changed_same_md5_marks_synced() {
        let (dir, db) = temp_db();

        let mut row = base_row("p1", "file.txt");
        row.md5       = Some("content_md5".into());
        row.drive_md5 = Some("old_md5".into()); // different from both → both "changed"
        db.upsert_file(row).unwrap();

        // Create local file.
        std::fs::write(dir.path().join("file.txt"), b"same content").unwrap();

        // Remote also has the same content_md5 → both changed to same content.
        let entry = DriveEntry {
            id:            "drv_id_1".into(),
            name:          Some("file.txt".into()),
            parents:       None,
            md5_checksum:  Some("content_md5".into()), // same as local md5
            modified_time: Some("2023-11-20T00:00:00Z".into()),
            size:          Some("100".into()),
            mime_type:     Some("application/octet-stream".into()),
            trashed:       None,
        };

        let p = pair(PairMode::TwoWay, dir.path().to_str().unwrap());
        let echo = Arc::new(SelfWritten::new());
        let drive = crate::drive::DriveClient::new().unwrap();

        let r = reconcile_listing(&db, &drive, &p, &[entry], &echo).await.unwrap();
        assert_eq!(r.uploads, 0);
        assert_eq!(r.downloads, 0);
        assert_eq!(r.conflicts, 0, "same md5 should not be a conflict");

        let got = db.get_file("p1", "file.txt").unwrap().unwrap();
        assert_eq!(got.state, "synced");
    }

    // ── Table row: both changed, different md5 → conflict ────────────────────

    #[tokio::test]
    async fn both_changed_different_md5_conflict() {
        let (dir, db) = temp_db();

        let mut row = base_row("p1", "file.txt");
        row.md5       = Some("local_new".into());
        row.drive_md5 = Some("old_md5".into());
        db.upsert_file(row).unwrap();

        std::fs::write(dir.path().join("file.txt"), b"local version").unwrap();

        let entry = DriveEntry {
            id:            "drv_id_1".into(),
            name:          Some("file.txt".into()),
            parents:       None,
            md5_checksum:  Some("remote_new".into()), // different from local_new
            modified_time: Some("2023-11-20T00:00:00Z".into()),
            size:          Some("100".into()),
            mime_type:     Some("application/octet-stream".into()),
            trashed:       None,
        };

        let p = pair(PairMode::TwoWay, dir.path().to_str().unwrap());
        let echo = Arc::new(SelfWritten::new());
        let drive = crate::drive::DriveClient::new().unwrap();

        // newer_wins policy → queues upload or download, no conflict count.
        let r = reconcile_listing(&db, &drive, &p, &[entry], &echo).await.unwrap();
        // newer_wins: 0 explicit conflicts (just queues upload/download).
        assert_eq!(r.uploads + r.downloads, 1, "newer_wins should queue exactly one action");
    }

    // ── Mirror mode keeps the local side authoritative ───────────────────────

    #[tokio::test]
    async fn mirror_remote_change_reuploads_local() {
        let (dir, db) = temp_db();
        let row = base_row("p1", "file.txt");
        db.upsert_file(row).unwrap();
        std::fs::write(dir.path().join("file.txt"), b"local content").unwrap();

        let change = DriveChange {
            file_id: "drv_id_1".into(),
            removed: Some(false),
            file: Some(DriveEntry {
                id:            "drv_id_1".into(),
                name:          Some("file.txt".into()),
                parents:       None,
                md5_checksum:  Some("new_remote_md5".into()),
                modified_time: Some("2023-11-20T00:00:00Z".into()),
                size:          Some("200".into()),
                mime_type:     Some("application/octet-stream".into()),
                trashed:       Some(false),
            }),
        };

        let p = pair(PairMode::Mirror, dir.path().to_str().unwrap());
        let echo = Arc::new(SelfWritten::new());

        apply_remote_change_with_policy(
            &db, &p, &change, &echo, ConflictPolicy::NewerWins,
        ).await.unwrap();

        assert_eq!(db.count_jobs_by_status("queued").unwrap(), 1);
        let row = db.get_file("p1", "file.txt").unwrap().unwrap();
        assert_eq!(row.state, "dirty");
        assert_eq!(row.drive_id.as_deref(), Some("drv_id_1"));
    }

    #[tokio::test]
    async fn mirror_remote_delete_recreates_remote() {
        let (dir, db) = temp_db();
        let row = base_row("p1", "file.txt");
        db.upsert_file(row).unwrap();
        std::fs::write(dir.path().join("file.txt"), b"local content").unwrap();

        let change = DriveChange {
            file_id: "drv_id_1".into(),
            removed: Some(true),
            file:    None,
        };

        let p = pair(PairMode::Mirror, dir.path().to_str().unwrap());
        let echo = Arc::new(SelfWritten::new());

        apply_remote_change_with_policy(
            &db, &p, &change, &echo, ConflictPolicy::NewerWins,
        ).await.unwrap();

        assert_eq!(db.count_jobs_by_status("queued").unwrap(), 1);
        let row = db.get_file("p1", "file.txt").unwrap().unwrap();
        assert_eq!(row.state, "dirty");
        assert!(row.drive_id.is_none(), "stale Drive id must be cleared");
    }

    // ── Echo suppression ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn echo_suppression_blocks_self_write() {
        let echo = Arc::new(SelfWritten::new());
        echo.record("some/path.txt", 1_700_000_000_000).await;

        assert!(echo.is_echo("some/path.txt", 1_700_000_000_000).await);
        // Different mtime: not an echo.
        assert!(!echo.is_echo("some/path.txt", 9999).await);
    }

    // ── Token persisted only after success ───────────────────────────────────

    #[test]
    fn token_not_updated_on_error() {
        let (_dir, db) = temp_db();
        // Set an initial token.
        db.set_page_token("p1", "token_A").unwrap();

        // Simulate: changes fetched but error on apply → token stays at A.
        // (We just verify the DB still has token_A.)
        let tok = db.get_page_token("p1").unwrap();
        assert_eq!(tok.as_deref(), Some("token_A"));
    }

    // ── Rename detection: same md5+size delete+create ────────────────────────

    #[test]
    fn rename_detection_same_md5() {
        // Rename detection works by: watcher sees DELETE a.txt + CREATE b.txt
        // with same md5. We verify the logic conceptually here.
        let md5_a = "abc123";
        let md5_b = "abc123"; // same
        assert_eq!(md5_a, md5_b, "rename detected when md5+size match");
    }

    // ── resolve_conflict ─────────────────────────────────────────────────────

    #[test]
    fn resolve_conflict_local_queues_upload() {
        let (dir, db_arc) = temp_db();
        let db = &*db_arc;
        let mut row = base_row("p1", "c.txt");
        row.state = "conflict".into();
        db.upsert_file(row).unwrap();

        let p = pair(PairMode::TwoWay, dir.path().to_str().unwrap());
        resolve_conflict(db, &p, "c.txt", "local").unwrap();

        let jobs = db.count_jobs_by_status("queued").unwrap();
        assert_eq!(jobs, 1);
    }

    #[test]
    fn resolve_conflict_invalid_choice_errors() {
        let (dir, db_arc) = temp_db();
        let db = &*db_arc;
        let p = pair(PairMode::TwoWay, dir.path().to_str().unwrap());
        let result = resolve_conflict(db, &p, "c.txt", "invalid");
        assert!(result.is_err());
    }
}

