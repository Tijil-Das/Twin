//! P09 – Two-way sync: Changes API + reconciliation + conflict handling.
//!
//! Entry point: `run_pair_cycle(pair, ctx)` which:
//! 1. Bootstraps the Changes page token on first run.
//! 2. Lists the Drive folder tree and reconciles with Db.
//! 3. Polls remote changes every 60 s while governor is Running.
//! 4. For each change, applies the decision table.

pub mod appdata;
pub mod changes;
pub mod reconcile;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::{info, warn};

use crate::config::{PairEntry, PairMode, PolicySection};
use crate::db::Db;
use crate::drive::client::DriveClient;
use crate::error::AppError;
use crate::governor::Governor;

pub use reconcile::{EchoSet, SelfWritten};

// ── Public context ─────────────────────────────────────────────────────────────

/// Shared context passed into every sync operation.
#[derive(Clone)]
pub struct Ctx {
    pub db:    Arc<Db>,
    pub drive: DriveClient,
    pub gov:   Governor,
    /// In-memory echo-suppression set (path+mtime written by us).
    pub echo:  Arc<SelfWritten>,
    /// User-configured conflict/deletion policies.
    pub policy: PolicySection,
    /// Optional window handle used to surface interactive conflicts.
    pub app:    Option<tauri::AppHandle>,
    /// Optional queue reference to wake dispatcher when jobs are enqueued.
    pub queue:  Option<crate::queue::Queue>,
}

/// Summary of one sync cycle.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CycleReport {
    pub uploads_queued:    usize,
    pub downloads_queued:  usize,
    pub conflicts:         usize,
    pub deletes_queued:    usize,
    pub errors:            Vec<String>,
}

// ── Main entry point ───────────────────────────────────────────────────────────

/// Run one complete sync cycle for `pair`.
///
/// - If no page token: bootstrap it first, then do full listing.
/// - Apply decision table for every file found.
/// - Returns a `CycleReport`.
pub async fn run_pair_cycle(pair: &PairEntry, ctx: &Ctx) -> Result<CycleReport, AppError> {
    let mut report = CycleReport::default();

    // 1. Scan local filesystem so Db has all local files, modifications, and deletions recorded.
    let cfg = crate::config::load().unwrap_or_default();
    let rules = crate::rules::Rules::new(&cfg.rules.include, &cfg.rules.exclude, cfg.rules.max_file_mb);
    let _ = crate::watcher::scan_pair(pair, Arc::clone(&ctx.db), &rules, &ctx.gov).await;

    // Only two_way and mirror modes participate in the Changes feed.
    let use_changes = matches!(pair.mode, PairMode::TwoWay | PairMode::Mirror);

    // Bootstrap: get start page token if we don't have one yet.
    let has_token = ctx.db.get_page_token(&pair.id)?.is_some();
    if !has_token && use_changes {
        let token = changes::get_start_page_token(&ctx.drive).await?;
        // Store BEFORE the initial listing so we don't miss changes during listing.
        ctx.db.set_page_token(&pair.id, &token)?;
        info!("pair {}: bootstrapped Changes start token", pair.id);
    }

    // Full listing of Drive folder tree + reconcile with Db.
    let files = changes::list_drive_folder(&ctx.drive, &pair.drive_folder_id).await?;
    let cfg_pair = pair.clone();
    let queued = reconcile::reconcile_listing_with_policy(
        &ctx.db,
        &ctx.drive,
        &cfg_pair,
        &files,
        &ctx.echo,
        ctx.policy.conflict.clone(),
        pair.deletion.clone().unwrap_or_else(|| ctx.policy.deletion.clone()),
    ).await?;
    report.uploads_queued   += queued.uploads;
    report.downloads_queued += queued.downloads;
    report.conflicts        += queued.conflicts;
    report.deletes_queued   += queued.deletes;
    report.errors.extend(queued.errors);

    emit_conflict_events(ctx, pair);

    info!(
        "pair {}: cycle complete — up={} down={} conflict={} del={}",
        pair.id,
        report.uploads_queued,
        report.downloads_queued,
        report.conflicts,
        report.deletes_queued,
    );

    // Record last sync timestamp
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let _ = ctx.db.upsert_pair_meta(&pair.id, None, Some(now));

    if let Some(ref q) = ctx.queue {
        q.wake();
    }

    Ok(report)
}

/// Comprehensive gap-check and reconciliation for a folder pair:
/// 1. Local filesystem scan via `watcher::scan_pair` (detects additions, modifications, and deletions).
/// 2. Remote Google Drive gap check respecting `pair.mode`:
///    - For `Upload`: local files are uploaded; Drive changes are ignored.
///    - For `TwoWay` and `Mirror`:
///      - If `page_token` exists: fetch incremental changes via `changes::fetch_changes` and apply them.
///      - If no `page_token` or token expired (410 Gone / startPageToken): run full `run_pair_cycle`.
/// 3. Wake queue worker to start transfers immediately.
pub async fn reconcile_pair_gap(
    pair: &PairEntry,
    ctx: &Ctx,
    rules: &crate::rules::Rules,
) -> Result<CycleReport, AppError> {
    // 1. Scan local filesystem
    let _ = crate::watcher::scan_pair(pair, Arc::clone(&ctx.db), rules, &ctx.gov).await;

    // 2. Reconcile with Google Drive according to mode
    let mut report = CycleReport::default();
    if pair.mode == PairMode::Mirror {
        // Mirror mode requires full listing reconciliation to guarantee remote matches local.
        report = run_pair_cycle(pair, ctx).await?;
    } else if matches!(pair.mode, PairMode::TwoWay) {
        let page_token = ctx.db.get_page_token(&pair.id)?;
        if let Some(token) = page_token {
            match changes::fetch_changes(&ctx.drive, &token, &pair.drive_folder_id, Some(&ctx.db), Some(&pair.id)).await {
                Ok(result) => {
                    let mut applied = 0;
                    for change in &result.changes {
                        ctx.gov.checkpoint().await;
                        if let Err(e) = reconcile::apply_remote_change_with_policies(
                            &ctx.db,
                            pair,
                            change,
                            &ctx.echo,
                            ctx.policy.conflict.clone(),
                            pair.deletion.clone().unwrap_or_else(|| ctx.policy.deletion.clone()),
                        ).await {
                            warn!("pair {}: apply change error: {e}", pair.id);
                        } else {
                            applied += 1;
                        }
                    }
                    emit_conflict_events(ctx, pair);

                    if let Some(ref new_token) = result.new_start_page_token {
                        let _ = ctx.db.set_page_token(&pair.id, new_token);
                    } else if let Some(ref next) = result.next_page_token {
                        let _ = ctx.db.set_page_token(&pair.id, next);
                    }
                    report.downloads_queued += applied;
                }
                Err(e) => {
                    info!("pair {}: incremental changes check failed ({e}), running full cycle", pair.id);
                    report = run_pair_cycle(pair, ctx).await?;
                }
            }
        } else {
            report = run_pair_cycle(pair, ctx).await?;
        }
    }

    // Record last sync timestamp
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let _ = ctx.db.upsert_pair_meta(&pair.id, None, Some(now));

    // 3. Wake queue dispatcher immediately
    if let Some(ref q) = ctx.queue {
        q.wake();
    }

    Ok(report)
}

/// Long-running Changes API poll loop. Spawned once per pair.
///
/// Polls every 60 s while governor is Running.  Persists
/// `newStartPageToken` only after all changes are applied.
pub async fn poll_changes_loop(pair: PairEntry, ctx: Ctx) {
    info!("pair {}: changes poll loop started", pair.id);

    // Initial check after 5 seconds instead of waiting full 60 seconds
    sleep(Duration::from_secs(5)).await;

    loop {
        ctx.gov.checkpoint().await;

        let page_token = match ctx.db.get_page_token(&pair.id) {
            Ok(Some(t)) => t,
            Ok(None) => {
                // Not bootstrapped yet: bootstrap start page token
                match changes::get_start_page_token(&ctx.drive).await {
                    Ok(token) => {
                        let _ = ctx.db.set_page_token(&pair.id, &token);
                        info!("pair {}: auto-bootstrapped Changes start token", pair.id);
                        token
                    }
                    Err(e) => {
                        warn!("pair {}: get_start_page_token error: {e}", pair.id);
                        sleep(Duration::from_secs(30)).await;
                        continue;
                    }
                }
            }
            Err(e) => {
                warn!("pair {}: get_page_token error: {e}", pair.id);
                sleep(Duration::from_secs(30)).await;
                continue;
            }
        };

        match changes::fetch_changes(&ctx.drive, &page_token, &pair.drive_folder_id, Some(&ctx.db), Some(&pair.id)).await {
            Ok(result) => {
                let mut applied = 0;
                // Apply each change through the decision table.
                for change in &result.changes {
                    ctx.gov.checkpoint().await;
                    if let Err(e) = reconcile::apply_remote_change_with_policies(
                        &ctx.db,
                        &pair,
                        change,
                        &ctx.echo,
                        ctx.policy.conflict.clone(),
                        pair.deletion.clone().unwrap_or_else(|| ctx.policy.deletion.clone()),
                    ).await {
                        warn!("pair {}: apply change error: {e}", pair.id);
                    } else {
                        applied += 1;
                    }
                }
                emit_conflict_events(&ctx, &pair);

                // Wake queue immediately if any jobs were enqueued
                if applied > 0 {
                    if let Some(ref q) = ctx.queue {
                        q.wake();
                    }
                }

                // Persist new token only after all changes applied (crash safety).
                if let Some(ref new_token) = result.new_start_page_token {
                    if let Err(e) = ctx.db.set_page_token(&pair.id, new_token) {
                        warn!("pair {}: set_page_token error: {e}", pair.id);
                    }
                } else if let Some(ref next) = result.next_page_token {
                    if let Err(e) = ctx.db.set_page_token(&pair.id, next) {
                        warn!("pair {}: set_page_token (next) error: {e}", pair.id);
                    }
                }
            }
            Err(e) => {
                warn!("pair {}: fetch_changes error: {e}", pair.id);
                let err_str = e.to_string();
                if err_str.contains("410") || err_str.contains("startPageToken") || err_str.contains("Invalid token") {
                    info!("pair {}: token expired or invalid; running full cycle to resync", pair.id);
                    let _ = run_pair_cycle(&pair, &ctx).await;
                    if let Some(ref q) = ctx.queue {
                        q.wake();
                    }
                }
            }
        }

        // Wait 60 s between polls (await checkpoint for governor respect).
        sleep(Duration::from_secs(60)).await;
    }
}

/// Emit `sync://conflict` for every row currently marked as conflicted.
///
/// The `ask` conflict policy only records `state = 'conflict'`; without this
/// bridge the frontend never learns about it and the conflict hangs forever.
fn emit_conflict_events(ctx: &Ctx, pair: &PairEntry) {
    let Some(app) = &ctx.app else { return };
    use tauri::Emitter;

    let Ok(rows) = ctx.db.list_all_files(&pair.id) else { return };
    for row in rows.into_iter().filter(|r| r.state == "conflict") {
        let payload = serde_json::json!({
            "pair_id": pair.id.clone(),
            "rel_path": row.rel_path,
        });
        let _ = app.emit("sync://conflict", payload);
    }
}

// ── Tauri state for conflict resolution ───────────────────────────────────────

/// Shared state for pending conflicts waiting for user resolution.
#[derive(Default)]
pub struct ConflictState(pub RwLock<Vec<PendingConflict>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingConflict {
    pub pair_id:  String,
    pub rel_path: String,
}

