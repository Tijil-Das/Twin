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

use crate::config::{PairEntry, PairMode};
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
    let queued = reconcile::reconcile_listing(
        &ctx.db, &ctx.drive, &cfg_pair, &files, &ctx.echo,
    ).await?;
    report.uploads_queued   += queued.uploads;
    report.downloads_queued += queued.downloads;
    report.conflicts        += queued.conflicts;
    report.deletes_queued   += queued.deletes;
    report.errors.extend(queued.errors);

    info!(
        "pair {}: cycle complete — up={} down={} conflict={} del={}",
        pair.id,
        report.uploads_queued,
        report.downloads_queued,
        report.conflicts,
        report.deletes_queued,
    );

    Ok(report)
}

/// Long-running Changes API poll loop. Spawned once per pair.
///
/// Polls every 60 s while governor is Running.  Persists
/// `newStartPageToken` only after all changes are applied.
pub async fn poll_changes_loop(pair: PairEntry, ctx: Ctx) {
    info!("pair {}: changes poll loop started", pair.id);

    loop {
        // Wait 60 s between polls (await checkpoint for governor respect).
        sleep(Duration::from_secs(60)).await;
        ctx.gov.checkpoint().await;

        let page_token = match ctx.db.get_page_token(&pair.id) {
            Ok(Some(t)) => t,
            Ok(None) => {
                // Not bootstrapped yet; skip.
                continue;
            }
            Err(e) => {
                warn!("pair {}: get_page_token error: {e}", pair.id);
                continue;
            }
        };

        match changes::fetch_changes(&ctx.drive, &page_token, &pair.drive_folder_id).await {
            Ok(result) => {
                // Apply each change through the decision table.
                for change in &result.changes {
                    ctx.gov.checkpoint().await;
                    if let Err(e) = reconcile::apply_remote_change(
                        &ctx.db, &pair, change, &ctx.echo,
                    ).await {
                        warn!("pair {}: apply change error: {e}", pair.id);
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
            }
        }
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

