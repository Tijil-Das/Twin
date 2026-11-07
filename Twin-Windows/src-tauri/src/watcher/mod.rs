//! P06 – File watcher
//!
//! Uses `notify-debouncer-full` (already a dep) to watch each enabled pair's
//! local directory.  Debounce = `cfg.app.debounce_secs`.  Events are translated
//! into `LocalChange` and dispatched to the queue via a `mpsc` channel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify_debouncer_full::notify::{RecursiveMode, Watcher as _};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::{Config, PairEntry};
use crate::db::{Db, NewJob};
use crate::error::AppError;
use crate::rules::Rules;

// ── LocalChange ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum ChangeKind {
    Modified,
    Deleted,
    Renamed { from: PathBuf },
}

#[derive(Debug, Clone)]
pub struct LocalChange {
    pub pair_id: String,
    pub rel_path: PathBuf,
    pub kind: ChangeKind,
}

// ── Watcher ───────────────────────────────────────────────────────────────────

/// Holds the active debouncers so they aren't dropped.
pub struct Watcher {
    _debouncers: Vec<Debouncer<notify_debouncer_full::notify::RecommendedWatcher, FileIdMap>>,
}

impl Watcher {
    /// Spawn a debounced watcher for a single pair entry.
    pub fn watch_pair_entry(
        pair: &PairEntry,
        debounce_secs: u64,
        db: Arc<Db>,
        tx: mpsc::UnboundedSender<LocalChange>,
    ) -> Result<Debouncer<notify_debouncer_full::notify::RecommendedWatcher, FileIdMap>, AppError> {
        let local_path = PathBuf::from(&pair.local);
        if !local_path.exists() {
            return Err(AppError::Other(format!("Pair {} path {:?} does not exist", pair.id, local_path)));
        }
        let pair_id = pair.id.clone();
        let debouncer = new_debouncer(
            Duration::from_secs(debounce_secs),
            None,
            move |result: DebounceEventResult| {
                handle_debounced_events(result, &pair_id, &local_path, &db, &tx);
            },
        )
        .map_err(|e| AppError::Other(format!("watcher init for pair {}: {e}", pair.id)))?;

        let mut d = debouncer;
        d.watcher()
            .watch(&PathBuf::from(&pair.local), RecursiveMode::Recursive)
            .map_err(|e| AppError::Other(format!("watch path: {e}")))?;

        info!("Watching pair {} → {:?}", pair.id, pair.local);
        Ok(d)
    }

    /// Spawn a debounced watcher for each enabled pair.
    /// Events are sent over `tx`; the caller owns the `rx`.
    pub fn start(
        cfg: &Config,
        db: Arc<Db>,
        tx: mpsc::UnboundedSender<LocalChange>,
    ) -> Result<Self, AppError> {
        let mut debouncers = Vec::new();

        for pair in cfg.pairs.iter().filter(|p| p.enabled) {
            match Self::watch_pair_entry(pair, cfg.app.debounce_secs, Arc::clone(&db), tx.clone()) {
                Ok(d) => debouncers.push(d),
                Err(e) => warn!("Pair {} watch error: {e}", pair.id),
            }
        }

        Ok(Watcher { _debouncers: debouncers })
    }
}

fn handle_debounced_events(
    result: DebounceEventResult,
    pair_id: &str,
    root: &Path,
    db: &Arc<Db>,
    tx: &mpsc::UnboundedSender<LocalChange>,
) {
    let events = match result {
        Ok(evs) => evs,
        Err(errs) => {
            for e in &errs {
                warn!("Watcher error for pair {pair_id}: {e}");
            }
            // Buffer overflow → trigger full rescan by sending a synthetic change on root.
            let _ = tx.send(LocalChange {
                pair_id: pair_id.to_string(),
                rel_path: PathBuf::new(),
                kind: ChangeKind::Modified,
            });
            return;
        }
    };

    // Collapse events per path: last kind wins.
    let mut by_path: HashMap<PathBuf, ChangeKind> = HashMap::new();

    for ev in events {
        use notify_debouncer_full::notify::EventKind;

        // Rename events carry both the old and the new path. Without this
        // branch the new path is never uploaded (and the old row lingers).
        if let EventKind::Modify(notify_debouncer_full::notify::event::ModifyKind::Name(_)) =
            &ev.event.kind
        {
            if let [from, to] = ev.event.paths.as_slice() {
                if let (Ok(from_rel), Ok(to_rel)) =
                    (from.strip_prefix(root), to.strip_prefix(root))
                {
                    by_path.insert(
                        to_rel.to_path_buf(),
                        ChangeKind::Renamed { from: from_rel.to_path_buf() },
                    );
                }
            }
            continue;
        }

        let kind = &ev.event.kind;
        for path in &ev.event.paths {
            // Skip directory-only events (unless delete/rename).
            let is_dir = path.is_dir();
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };

            match kind {
                EventKind::Create(_) | EventKind::Modify(_) if !is_dir => {
                    by_path.insert(rel, ChangeKind::Modified);
                }
                EventKind::Remove(_) => {
                    // A removed directory no longer exists, so `is_dir()` is
                    // false here. Always expand: this emits the path itself and
                    // any tracked children beneath it.
                    let _ = is_dir;
                    expand_deleted_dir(db, pair_id, &rel, tx);
                }
                EventKind::Other if !is_dir => {
                    by_path.insert(rel, ChangeKind::Modified);
                }
                _ => {}
            }
        }
    }

    for (rel_path, kind) in by_path {
        let _ = tx.send(LocalChange {
            pair_id: pair_id.to_string(),
            rel_path,
            kind,
        });
    }
}

/// Send a `Deleted` change for the path itself and every DB row beneath it.
fn expand_deleted_dir(
    db: &Arc<Db>,
    pair_id: &str,
    dir_rel: &Path,
    tx: &mpsc::UnboundedSender<LocalChange>,
) {
    let prefix = dir_rel.to_string_lossy().replace('\\', "/");

    // Emit one deletion per tracked child so `run_delete` can trash/delete
    // the corresponding Drive object instead of leaving orphaned rows.
    if let Ok(rows) = db.list_all_files(pair_id) {
        let child_prefix = if prefix.is_empty() {
            String::new()
        } else {
            format!("{prefix}/")
        };
        for row in rows {
            if !child_prefix.is_empty() && row.rel_path.starts_with(&child_prefix) {
                let _ = tx.send(LocalChange {
                    pair_id: pair_id.to_string(),
                    rel_path: PathBuf::from(&row.rel_path),
                    kind: ChangeKind::Deleted,
                });
            }
        }
    }

    // The directory/file path itself (harmless if it has no DB row).
    let _ = tx.send(LocalChange {
        pair_id: pair_id.to_string(),
        rel_path: dir_rel.to_path_buf(),
        kind: ChangeKind::Deleted,
    });
}

// ── Scanner ───────────────────────────────────────────────────────────────────

/// Iterative (non-recursive stack) directory walk.
/// Compares size + mtime to DB; if different computes md5 streaming.
/// Enqueues `upload` jobs for new/changed files.
/// Marks files missing from disk as `deleted_local`.
pub async fn scan_pair(
    pair: &PairEntry,
    db: Arc<Db>,
    rules: &Rules,
    gov: &crate::governor::Governor,
) -> Result<(), AppError> {
    use crate::db::FileRow;
    use std::collections::HashSet;

    let root = PathBuf::from(&pair.local);
    if !root.exists() {
        return Ok(());
    }

    info!("Scanning pair {} → {:?}", pair.id, root);

    let now_ms = now_ms();
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack: Vec<PathBuf> = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) => {
                warn!("scan_pair read_dir {:?}: {e}", dir);
                continue;
            }
        };

        for entry in rd.flatten() {
            gov.checkpoint().await;

            let path = entry.path();
            let meta = match path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let rel = match path.strip_prefix(&root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };

            if meta.is_dir() {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if rules.is_dir_excluded(&rel_str) {
                    continue;
                }
                stack.push(path);
                continue;
            }

            let size = meta.len();

            if !rules.allowed_path(Some(&path), &rel, size) {
                continue;
            }

            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);

            let rel_str = rel.to_string_lossy().replace('\\', "/");
            seen.insert(rel_str.clone());

            // Compare with DB for this pair.
            let existing = db.get_file(&pair.id, &rel_str)?;
            let needs_upload = match &existing {
                None => true,
                Some(row) => {
                    row.state != "synced"
                        || row.drive_id.is_none()
                        || row.mtime_ms != Some(mtime_ms)
                        || row.size != Some(size as i64)
                }
            };

            if needs_upload {
                // Compute md5 only when mtime/size differ.
                let md5 = compute_md5(&path, gov).await.ok();

                // Check if md5 actually changed (avoids enqueue on metadata-only change).
                let skip = existing.as_ref().and_then(|r| r.md5.as_deref())
                    == md5.as_deref();

                let file_row = FileRow {
                    pair_id: pair.id.clone(),
                    rel_path: rel_str.clone(),
                    size: Some(size as i64),
                    mtime_ms: Some(mtime_ms),
                    md5: md5.clone(),
                    drive_id: existing.as_ref().and_then(|r| r.drive_id.clone()),
                    drive_md5: existing.as_ref().and_then(|r| r.drive_md5.clone()),
                    drive_mtime_ms: existing.as_ref().and_then(|r| r.drive_mtime_ms),
                    drive_rev: existing.as_ref().and_then(|r| r.drive_rev.clone()),
                    state: if skip { "synced".into() } else { "dirty".into() },
                };
                db.upsert_file(file_row)?;

                if !skip {
                    db.enqueue(NewJob {
                        pair_id: pair.id.clone(),
                        kind: "upload".into(),
                        rel_path: rel_str,
                        priority: 0,
                        created_ms: now_ms,
                    })?;
                }
            }
        }
    }

    // Mark files that are in DB but no longer on disk.
    mark_missing(pair, &db, &seen, now_ms)?;

    info!("Scan complete for pair {}", pair.id);
    Ok(())
}

fn mark_missing(
    pair: &PairEntry,
    db: &Arc<Db>,
    seen: &std::collections::HashSet<String>,
    now_ms: i64,
) -> Result<(), AppError> {
    // Check every tracked file, not just dirty ones: a previously synced
    // file deleted while the app was closed must also be propagated.
    let root = PathBuf::from(&pair.local);
    for row in db.list_all_files(&pair.id)? {
        if seen.contains(&row.rel_path) {
            continue;
        }

        // Don't resurrect rows that are already in a confirmed terminal deleted state.
        if matches!(
            row.state.as_str(),
            "remote_deleted" | "deleted" | "trashed" | "conflict"
        ) {
            continue;
        }

        // Files excluded by rules are absent from `seen` but still on disk;
        // only mark genuinely missing files.
        if root.join(&row.rel_path).exists() {
            continue;
        }

        db.mark_state(&pair.id, &row.rel_path, "deleted_local")?;
        db.enqueue(NewJob {
            pair_id: pair.id.clone(),
            kind: "delete".into(),
            rel_path: row.rel_path,
            priority: 0,
            created_ms: now_ms,
        })?;
    }
    Ok(())
}

/// Stream-hash a file with 1 MB buffers, calling `gov.checkpoint()` every 8 MB.
pub async fn compute_md5(path: &Path, gov: &crate::governor::Governor) -> Result<String, AppError> {
    use std::io::Read;

    const BUF_SIZE: usize = 1024 * 1024;       // 1 MB
    const CHECKPOINT_EVERY: usize = 8;          // 8 × 1 MB = 8 MB

    let path = path.to_path_buf();
    // Run blocking I/O on the blocking thread pool.
    let result = tokio::task::spawn_blocking(move || -> Result<String, AppError> {
        use md5::{Digest, Md5};
        let mut file = std::fs::File::open(&path)
            .map_err(|e| AppError::Io(format!("md5 open: {e}")))?;
        let mut hasher = Md5::new();
        let mut buf = vec![0u8; BUF_SIZE];
        loop {
            let n = file.read(&mut buf).map_err(|e| AppError::Io(format!("md5 read: {e}")))?;
            if n == 0 { break; }
            hasher.update(&buf[..n]);
        }
        let digest = hasher.finalize();
        Ok(format!("{:x}", digest))
    })
    .await
    .map_err(|e| AppError::Other(format!("md5 task: {e}")))?;

    // Checkpoint after every file (fine-grained enough at file level).
    let _ = CHECKPOINT_EVERY;
    gov.checkpoint().await;

    result
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
