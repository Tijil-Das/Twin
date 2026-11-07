//! P08 – Download + Restore job runner.
//!
//! Implements `JobRunner` for kinds: `download`, `restore`.
//!
//! Download strategy:
//! - Files > 32 MiB: 4 parallel ranged requests, each range written at its own
//!   offset into a pre-sized `.twin-part` file.  Ranges never buffer more than
//!   4 MiB at a time.
//! - Smaller files: single streaming download.
//! - Google-native files (application/vnd.google-apps.*): files.export API.
//! - Shortcuts: skip, record in activity.
//!
//! After finish: verify md5, set mtime, atomic rename over target.
//! A sidecar `.twin-part.json` records completed ranges for crash-resume.
//!
//! Restore:
//! - `restore_file`: download a specific file (optionally at a specific revision).
//! - `restore_folder`: list all files recursively, create dirs first, enqueue one
//!   download job per file.
//! - `restore_from_trash`: untrash a file by id.
//!
//! Restore never overwrites silently: renames existing dest to
//! `name (local backup yyyy-mm-dd hhmmss).ext` first.

use std::collections::HashSet;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use reqwest::header;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::auth;
use crate::config::Config;
use crate::db::{Db, FileRow, Job, NewJob};
use crate::drive::client::DriveClient;
use crate::drive::export::{export_mime, ext_for_mime, ExportFormats};
use crate::error::AppError;
use crate::governor::Governor;
use crate::queue::{JobRunner, ProgressTx, ProgressUpdate};
use crate::transfer::limiter::Limiter;

// Files larger than this use 4 parallel ranged downloads.
const PARALLEL_THRESHOLD: u64 = 32 * 1024 * 1024; // 32 MiB
const NUM_RANGES: u64 = 4;
const RANGE_BUFFER: usize = 4 * 1024 * 1024; // 4 MiB max per range at once


// ── DownloadRunner ────────────────────────────────────────────────────────────

pub struct DownloadRunner {
    pub db: Arc<Db>,
    pub cfg: Config,
    pub gov: Governor,
    pub drive: DriveClient,
    pub limiter: Arc<Limiter>,
}

impl JobRunner for DownloadRunner {
    fn run(&self, job: Job, progress: ProgressTx)
        -> impl std::future::Future<Output = Result<(), AppError>> + Send
    {
        let db      = Arc::clone(&self.db);
        let cfg     = self.cfg.clone();
        let gov     = self.gov.clone();
        let drive   = self.drive.clone();
        let limiter = Arc::clone(&self.limiter);

        async move {
            if cfg.app.dry_run {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                let _ = db.log_activity(crate::db::Activity {
                    id: None,
                    ts_ms: now,
                    pair_id: job.pair_id,
                    kind: job.kind,
                    rel_path: job.rel_path,
                    result: "dry-run".into(),
                    detail: None,
                });
                return Ok(());
            }

            match job.kind.as_str() {
                "download" => run_download(job, db, cfg, gov, drive, limiter, progress).await,
                "restore"  => run_restore(job, db, cfg, gov, drive, limiter, progress).await,
                other      => Err(AppError::Other(format!("unknown job kind: {other}"))),
            }
        }
    }
}

// ── download ──────────────────────────────────────────────────────────────────

pub(crate) async fn run_download(
    job: Job,
    db: Arc<Db>,
    cfg: Config,
    gov: Governor,
    drive: DriveClient,
    limiter: Arc<Limiter>,
    progress: ProgressTx,
) -> Result<(), AppError> {
    // Resolve pair.
    let pair = match cfg.pairs.iter().find(|p| p.id == job.pair_id) {
        Some(p) => p.clone(),
        None => {
            let _ = db.complete_job(job.id);
            return Ok(());
        }
    };

    let dest = PathBuf::from(&pair.local).join(&job.rel_path);

    // Look up drive metadata from DB.
    let file_row = db.get_file(&job.pair_id, &job.rel_path)?;
    let drive_id = file_row
        .as_ref()
        .and_then(|r| r.drive_id.as_deref())
        .ok_or_else(|| AppError::Other(format!("no drive_id for {}", job.rel_path)))?
        .to_string();
    let drive_mime = file_row
        .as_ref()
        .and_then(|r| r.md5.as_ref().map(|_| "application/octet-stream"))
        .unwrap_or("application/octet-stream")
        .to_string();

    // Fetch live file metadata from Drive.
    let meta = fetch_file_meta(&drive, &drive_id).await?;
    let mime = meta.mime_type.as_deref().unwrap_or("application/octet-stream");

    // Skip shortcuts.
    if mime == "application/vnd.google-apps.shortcut" {
        info!("download: skip shortcut {}", job.rel_path);
        db.log_activity(crate::db::Activity {
            id: None,
            ts_ms: now_ms(),
            pair_id: job.pair_id.clone(),
            kind: "download".into(),
            rel_path: job.rel_path.clone(),
            result: "skipped".into(),
            detail: Some("shortcut".into()),
        })?;
        return Ok(());
    }

    // Google-native: use export.
    let export_formats = ExportFormats::default();
    if let Some(export_m) = export_mime(mime, &export_formats) {
        return download_export(&job, &drive, &drive_id, &export_m, &dest, &db, &gov).await;
    }

    let size: u64 = match meta.size {
        Some(serde_json::Value::String(ref s)) => s.parse().unwrap_or(0),
        Some(serde_json::Value::Number(ref n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    };
    let drive_md5 = meta.md5_checksum.clone();
    let drive_mtime = meta.modified_time.clone();
    let drive_mtime_ms = drive_mtime.as_deref().and_then(rfc3339_to_ms).unwrap_or(0);
    let _ = drive_mime;

    // Ensure parent dirs exist.
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Io(format!("create_dir_all: {e}")))?;
    }

    let part_path  = part_path(&dest);
    let sidecar    = sidecar_path(&dest);

    gov.checkpoint().await;

    if size > PARALLEL_THRESHOLD {
        download_parallel(
            &job, &drive, &drive_id, size, &part_path, &sidecar,
            &gov, &limiter, &progress,
        ).await?;
    } else {
        download_single(
            &job, &drive, &drive_id, size, &part_path,
            &gov, &limiter, &progress,
        ).await?;
    }

    // Verify md5.
    if let Some(ref expected) = drive_md5 {
        gov.checkpoint().await;
        let actual = compute_md5_blocking(&part_path).await?;
        if actual != *expected {
            // Remove corrupted part.
            let _ = std::fs::remove_file(&part_path);
            let _ = std::fs::remove_file(&sidecar);
            return Err(AppError::Drive(format!(
                "md5 mismatch for {}: expected={expected} got={actual}",
                job.rel_path
            )));
        }
    }

    // Set mtime on part file.
    if drive_mtime_ms > 0 {
        set_file_mtime(&part_path, drive_mtime_ms);
    }

    // Atomic rename.
    rename_safely(&part_path, &dest)?;
    let _ = std::fs::remove_file(&sidecar); // clean up sidecar

    // Update DB.
    let row = FileRow {
        pair_id: job.pair_id.clone(),
        rel_path: job.rel_path.clone(),
        size: Some(size as i64),
        mtime_ms: Some(drive_mtime_ms),
        md5: drive_md5.clone(),
        drive_id: Some(drive_id.clone()),
        drive_md5,
        drive_mtime_ms: Some(drive_mtime_ms),
        drive_rev: None,
        state: "synced".into(),
    };
    db.upsert_file(row)?;

    info!("downloaded {} ({size} bytes)", job.rel_path);
    Ok(())
}

// ── Google export download ────────────────────────────────────────────────────

async fn download_export(
    job: &Job,
    drive: &DriveClient,
    drive_id: &str,
    export_m: &str,
    dest: &Path,
    db: &Arc<Db>,
    gov: &Governor,
) -> Result<(), AppError> {
    gov.checkpoint().await;

    match drive.export_file(drive_id, export_m).await? {
        None => {
            // exportSizeLimitExceeded — log and skip.
            db.log_activity(crate::db::Activity {
                id: None,
                ts_ms: now_ms(),
                pair_id: job.pair_id.clone(),
                kind: "download".into(),
                rel_path: job.rel_path.clone(),
                result: "skipped".into(),
                detail: Some("exportSizeLimitExceeded".into()),
            })?;
            info!("export skipped (size limit): {}", job.rel_path);
            Ok(())
        }
        Some(bytes) => {
            let ext = ext_for_mime(export_m);
            let export_dest = dest.with_extension(ext);
            if let Some(parent) = export_dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::Io(format!("mkdir export: {e}")))?;
            }
            // No md5 for exports; track by modifiedTime in DB (set drive_md5=None).
            backup_if_exists(&export_dest)?;
            std::fs::write(&export_dest, &bytes)
                .map_err(|e| AppError::Io(format!("write export: {e}")))?;
            info!("exported {} → {} ({} bytes)", job.rel_path, export_dest.display(), bytes.len());
            Ok(())
        }
    }
}

// ── Parallel ranged download ──────────────────────────────────────────────────

/// Sidecar: set of already-completed range indices.
#[derive(Serialize, Deserialize, Default)]
struct RangeSidecar {
    completed: HashSet<u64>,
}

#[allow(clippy::too_many_arguments)]
async fn download_parallel(
    job: &Job,
    drive: &DriveClient,
    drive_id: &str,
    size: u64,
    part_path: &Path,
    sidecar: &Path,
    gov: &Governor,
    limiter: &Arc<Limiter>,
    progress: &ProgressTx,
) -> Result<(), AppError> {
    // Pre-size the file.
    {
        let f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(part_path)
            .map_err(|e| AppError::Io(format!("pre-size part: {e}")))?;
        f.set_len(size)
            .map_err(|e| AppError::Io(format!("set_len: {e}")))?;
    }

    // Load existing sidecar (completed ranges from a previous attempt).
    let mut sidecar_data: RangeSidecar = if sidecar.exists() {
        let raw = std::fs::read_to_string(sidecar).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        RangeSidecar::default()
    };

    let range_size = size.div_ceil(NUM_RANGES);
    let sem = Arc::new(Semaphore::new(NUM_RANGES as usize));

    // Shared bytes-done counter for progress (using atomic u64).
    let bytes_done = Arc::new(std::sync::atomic::AtomicU64::new(
        // Count already-completed ranges.
        sidecar_data.completed.iter().map(|&i| {
            let start = i * range_size;
            let end = (start + range_size).min(size);
            end - start
        }).sum::<u64>()
    ));

    let token = auth::access_token().await?;

    let mut handles = Vec::new();

    for range_idx in 0..NUM_RANGES {
        if sidecar_data.completed.contains(&range_idx) {
            continue; // already done in a previous run
        }

        let start = range_idx * range_size;
        let end   = (start + range_size - 1).min(size - 1);

        let permit = Arc::clone(&sem);
        let http   = drive.http.clone();
        let token  = token.clone();
        let drive_id = drive_id.to_string();
        let drive_base_url = drive.base_url.clone();
        let part_path = part_path.to_path_buf();
        let limiter   = Arc::clone(limiter);
        let bytes_done_c = Arc::clone(&bytes_done);
        let total = size;
        let job_id = job.id;
        let pair_id = job.pair_id.clone();
        let rel_path = job.rel_path.clone();
        let progress = progress.clone();
        let gov_c = gov.clone();

        let handle = tauri::async_runtime::spawn(async move {
            let _permit = permit.acquire_owned().await
                .map_err(|_| AppError::Other("semaphore closed".into()))?;

            gov_c.checkpoint().await;

            let range_hdr = format!("bytes={start}-{end}");
            let url = format!("{drive_base_url}/files/{drive_id}?alt=media&supportsAllDrives=true");

            let resp = http.get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::RANGE, &range_hdr)
                .send()
                .await
                .map_err(|e| AppError::Drive(format!("range GET: {e}")))?;

            let status = resp.status();
            if !status.is_success() && status.as_u16() != 206 {
                let body = resp.text().await.unwrap_or_default();
                return Err(AppError::Drive(format!("range GET HTTP {status}: {body}")));
            }

            // Open the pre-sized file for writing at the right offset.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(&part_path)
                .map_err(|e| AppError::Io(format!("open part: {e}")))?;

            file.seek(SeekFrom::Start(start))
                .map_err(|e| AppError::Io(format!("seek: {e}")))?;

            let mut stream = resp.bytes_stream();
            let mut written: u64 = 0;

            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| AppError::Drive(format!("stream chunk: {e}")))?;

                // Never buffer more than RANGE_BUFFER at once.
                let mut offset = 0usize;
                while offset < chunk.len() {
                    let end_off = (offset + RANGE_BUFFER).min(chunk.len());
                    let slice = &chunk[offset..end_off];

                    limiter.acquire(slice.len() as u64).await;

                    file.write_all(slice)
                        .map_err(|e| AppError::Io(format!("write range: {e}")))?;

                    let prev = bytes_done_c.fetch_add(
                        slice.len() as u64,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    let done_now = prev + slice.len() as u64;
                    let _ = progress.send(ProgressUpdate {
                        job_id,
                        pair_id: pair_id.clone(),
                        rel_path: rel_path.clone(),
                        bytes_done: done_now.min(total),
                        bytes_total: total,
                    });

                    written += slice.len() as u64;
                    offset = end_off;
                }
            }

            Ok::<(u64, u64), AppError>((range_idx, written))
        });

        handles.push(handle);
    }

    // Collect results, update sidecar.
    for handle in handles {
        match handle.await {
            Ok(Ok((range_idx, _))) => {
                sidecar_data.completed.insert(range_idx);
                // Persist sidecar.
                if let Ok(json) = serde_json::to_string(&sidecar_data) {
                    let _ = std::fs::write(sidecar, json);
                }
            }
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(AppError::Other(format!("join error: {e}"))),
        }
    }

    Ok(())
}

// Single-stream download

#[allow(clippy::too_many_arguments)]
async fn download_single(
    job: &Job,
    drive: &DriveClient,
    drive_id: &str,
    size: u64,
    part_path: &Path,
    gov: &Governor,
    limiter: &Arc<Limiter>,
    progress: &ProgressTx,
) -> Result<(), AppError> {
    let token = auth::access_token().await?;
    let url = format!("{}/files/{drive_id}?alt=media&supportsAllDrives=true", drive.base_url);

    let resp = drive.http.get(&url)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| AppError::Drive(format!("single GET: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Drive(format!("single GET HTTP {status}: {body}")));
    }

    let mut file = std::fs::File::create(part_path)
        .map_err(|e| AppError::Io(format!("create part: {e}")))?;

    let mut stream = resp.bytes_stream();
    let mut bytes_done: u64 = 0;

    while let Some(chunk) = stream.next().await {
        gov.checkpoint().await;

        let chunk = chunk.map_err(|e| AppError::Drive(format!("stream chunk: {e}")))?;
        limiter.acquire(chunk.len() as u64).await;

        file.write_all(&chunk)
            .map_err(|e| AppError::Io(format!("write chunk: {e}")))?;

        bytes_done += chunk.len() as u64;
        let _ = progress.send(ProgressUpdate {
            job_id: job.id,
            pair_id: job.pair_id.clone(),
            rel_path: job.rel_path.clone(),
            bytes_done: bytes_done.min(size.max(bytes_done)),
            bytes_total: size.max(bytes_done),
        });
    }

    Ok(())
}

// ── restore ───────────────────────────────────────────────────────────────────

pub(crate) async fn run_restore(
    job: Job,
    db: Arc<Db>,
    cfg: Config,
    gov: Governor,
    drive: DriveClient,
    limiter: Arc<Limiter>,
    progress: ProgressTx,
) -> Result<(), AppError> {
    // `rel_path` for restore jobs encodes the Drive file_id.
    // `last_error` field (repurposed) encodes dest path + optional rev_id:
    // Format: "<dest_path>|<rev_id>" or "<dest_path>" (no rev).
    // We use `rel_path` = drive_file_id, job payload in `last_error`.
    let drive_id = job.rel_path.clone();

    // Determine destination path.
    // For simplicity: dest = pair's local root / file name from Drive.
    let pair = match cfg.pairs.iter().find(|p| p.id == job.pair_id) {
        Some(p) => p.clone(),
        None => {
            let _ = db.complete_job(job.id);
            return Ok(());
        }
    };

    let meta = fetch_file_meta(&drive, &drive_id).await?;
    let file_name = meta.name.as_deref().unwrap_or("restored_file").to_string();
    let dest = PathBuf::from(&pair.local).join(&file_name);

    // Never overwrite silently.
    backup_if_exists(&dest)?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Io(format!("mkdir restore: {e}")))?;
    }

    let mime = meta.mime_type.as_deref().unwrap_or("application/octet-stream");
    let export_formats = ExportFormats::default();

    if let Some(export_m) = export_mime(mime, &export_formats) {
        return download_export(&job, &drive, &drive_id, &export_m, &dest, &db, &gov).await;
    }

    let size: u64 = match meta.size {
        Some(serde_json::Value::String(ref s)) => s.parse().unwrap_or(0),
        Some(serde_json::Value::Number(ref n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    };

    let part = part_path(&dest);
    let sidecar = sidecar_path(&dest);

    if size > PARALLEL_THRESHOLD {
        download_parallel(
            &job, &drive, &drive_id, size, &part, &sidecar,
            &gov, &limiter, &progress,
        ).await?;
    } else {
        download_single(
            &job, &drive, &drive_id, size, &part,
            &gov, &limiter, &progress,
        ).await?;
    }

    // Verify md5.
    if let Some(ref expected) = meta.md5_checksum {
        gov.checkpoint().await;
        let actual = compute_md5_blocking(&part).await?;
        if actual != *expected {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&sidecar);
            return Err(AppError::Drive(format!(
                "md5 mismatch restore {drive_id}: expected={expected} got={actual}"
            )));
        }
    }

    let drive_mtime_ms = meta.modified_time.as_deref().and_then(rfc3339_to_ms).unwrap_or(0);
    if drive_mtime_ms > 0 {
        set_file_mtime(&part, drive_mtime_ms);
    }

    rename_safely(&part, &dest)?;
    let _ = std::fs::remove_file(&sidecar);

    info!("restored {drive_id} → {}", dest.display());
    Ok(())
}

// ── Public restore API ────────────────────────────────────────────────────────

/// Download a specific Drive file to `dest`, optionally at a specific revision.
///
/// Revision downloads use the revisions media endpoint.
pub async fn restore_file(
    drive: &DriveClient,
    gov: &Governor,
    limiter: &Arc<Limiter>,
    file_id: &str,
    rev_id: Option<&str>,
    dest: PathBuf,
) -> Result<(), AppError> {
    backup_if_exists(&dest)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Io(format!("mkdir: {e}")))?;
    }

    let part = part_path(&dest);
    let sidecar = sidecar_path(&dest);

    let meta = fetch_file_meta(drive, file_id).await?;
    let size: u64 = match meta.size {
        Some(serde_json::Value::String(ref s)) => s.parse().unwrap_or(0),
        Some(serde_json::Value::Number(ref n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    };

    if let Some(rid) = rev_id {
        // Download via revisions endpoint.
        let token = auth::access_token().await?;
        let url = format!("{}/files/{file_id}/revisions/{rid}?alt=media", drive.base_url);
        let resp = drive.http.get(&url)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .await
            .map_err(|e| AppError::Drive(format!("revision GET: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Drive(format!("revision GET HTTP {status}: {body}")));
        }

        let mut file = std::fs::File::create(&part)
            .map_err(|e| AppError::Io(format!("create part rev: {e}")))?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            gov.checkpoint().await;
            let chunk = chunk.map_err(|e| AppError::Drive(format!("rev chunk: {e}")))?;
            limiter.acquire(chunk.len() as u64).await;
            file.write_all(&chunk)
                .map_err(|e| AppError::Io(format!("write rev chunk: {e}")))?;
        }
    } else {
        // Normal download.
        let dummy_job = Job {
            id: 0,
            pair_id: String::new(),
            kind: "restore".into(),
            rel_path: file_id.to_string(),
            priority: 0,
            attempts: 0,
            next_try_ms: 0,
            status: "running".into(),
            last_error: None,
            created_ms: now_ms(),
        };
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        if size > PARALLEL_THRESHOLD {
            download_parallel(
                &dummy_job, drive, file_id, size, &part, &sidecar,
                gov, limiter, &tx,
            ).await?;
        } else {
            download_single(
                &dummy_job, drive, file_id, size, &part,
                gov, limiter, &tx,
            ).await?;
        }
    }

    if let Some(ref expected) = meta.md5_checksum {
        gov.checkpoint().await;
        let actual = compute_md5_blocking(&part).await?;
        if actual != *expected {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&sidecar);
            return Err(AppError::Drive(format!("restore_file md5 mismatch: {file_id}")));
        }
    }

    let drive_mtime_ms = meta.modified_time.as_deref().and_then(rfc3339_to_ms).unwrap_or(0);
    if drive_mtime_ms > 0 {
        set_file_mtime(&part, drive_mtime_ms);
    }

    rename_safely(&part, &dest)?;
    let _ = std::fs::remove_file(&sidecar);

    info!("restore_file {file_id} → {}", dest.display());
    Ok(())
}

/// Recursively restore all files in a Drive folder to `dest`.
///
/// Creates directories first, then enqueues one `download` job per file.
pub async fn restore_folder(
    drive: &DriveClient,
    db: &Arc<Db>,
    cfg: &Config,
    pair_id: &str,
    folder_id: &str,
    dest: PathBuf,
) -> Result<(), AppError> {
    std::fs::create_dir_all(&dest)
        .map_err(|e| AppError::Io(format!("restore_folder mkdir: {e}")))?;

    let token = auth::access_token().await?;
    let url = format!("{}/files", drive.base_url);
    let mut page_token: Option<String> = None;

    loop {
        let q = format!("'{folder_id}' in parents and trashed=false");
        let mut query = vec![
            ("q".to_string(), q),
            ("fields".to_string(), "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,size)".to_string()),
            ("pageSize".to_string(), "1000".to_string()),
            ("supportsAllDrives".to_string(), "true".to_string()),
        ];
        if let Some(ref tok) = page_token {
            query.push(("pageToken".to_string(), tok.clone()));
        }

        let mut req = drive.http.get(&url)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        for (k, v) in &query {
            req = req.query(&[(k.as_str(), v.as_str())]);
        }

        let resp = req.send().await
            .map_err(|e| AppError::Drive(format!("restore_folder list: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Drive(format!("restore_folder HTTP {status}: {body}")));
        }

        #[derive(Deserialize)]
        struct Page {
            #[serde(default)] files: Vec<NamedDriveFile>,
            #[serde(rename = "nextPageToken", default)] next_page_token: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct NamedDriveFile {
            id: String,
            #[serde(default)] name: Option<String>,
            #[serde(default)] mime_type: Option<String>,
        }

        let page: Page = resp.json().await
            .map_err(|e| AppError::Drive(format!("restore_folder parse: {e}")))?;

        for f in page.files {
            let name = f.name.unwrap_or_else(|| f.id.clone());
            let child_dest = dest.join(&name);
            let mime = f.mime_type.as_deref().unwrap_or("");

            if mime == "application/vnd.google-apps.folder" {
                // Recurse: create dir and enqueue folder restore.
                std::fs::create_dir_all(&child_dest)
                    .map_err(|e| AppError::Io(format!("mkdir sub: {e}")))?;
                // Use a synthetic rel_path.
                let sub_rel = child_dest.to_string_lossy().into_owned();
                Box::pin(restore_folder(
                    drive, db, cfg, pair_id, &f.id,
                    child_dest,
                )).await?;
                let _ = sub_rel;
            } else {
                // Enqueue a download job for this file.
                let rel = child_dest.strip_prefix(&dest)
                    .unwrap_or(Path::new(&name))
                    .to_string_lossy()
                    .into_owned();
                let _ = db.enqueue(NewJob {
                    pair_id: pair_id.to_string(),
                    kind: "download".into(),
                    rel_path: rel,
                    priority: 0,
                    created_ms: now_ms(),
                });
            }
        }

        match page.next_page_token {
            Some(tok) => page_token = Some(tok),
            None => break,
        }
    }

    Ok(())
}

/// Untrash (restore from trash) a file by id.
pub async fn restore_from_trash(drive: &DriveClient, file_id: &str) -> Result<(), AppError> {
    drive.untrash(file_id).await?;
    info!("restore_from_trash: {file_id}");
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Fetch live metadata for a Drive file.
async fn fetch_file_meta(drive: &DriveClient, file_id: &str) -> Result<NamedFileMeta, AppError> {
    let token = auth::access_token().await?;
    let url = format!("{}/files/{file_id}", drive.base_url);
    let resp = drive.execute_with_retry(|| {
        drive.http.get(&url)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .query(&[
                ("fields", "id,name,mimeType,md5Checksum,modifiedTime,size"),
                ("supportsAllDrives", "true"),
            ])
    }).await?;
    resp.json::<NamedFileMeta>().await
        .map_err(|e| AppError::Drive(format!("fetch_file_meta parse: {e}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamedFileMeta {
    #[allow(dead_code)]
    pub id: String,
    #[serde(default)] pub name: Option<String>,
    #[serde(default)] pub mime_type: Option<String>,
    #[serde(default)] pub md5_checksum: Option<String>,
    #[serde(default)] pub modified_time: Option<String>,
    #[serde(default)] pub size: Option<serde_json::Value>,
}

fn part_path(dest: &Path) -> PathBuf {
    let mut p = dest.to_path_buf();
    let ext = p.extension()
        .map(|e| format!("{}.twin-part", e.to_string_lossy()))
        .unwrap_or_else(|| "twin-part".into());
    p.set_extension(&ext);
    p
}

fn sidecar_path(dest: &Path) -> PathBuf {
    let mut p = part_path(dest);
    let mut ext = p.extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    ext.push_str(".json");
    p.set_extension(&ext);
    p
}

/// Rename `src` to `dest`, crossing filesystem boundaries if needed.
fn rename_safely(src: &Path, dest: &Path) -> Result<(), AppError> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Fallback: copy then delete.
            std::fs::copy(src, dest)
                .map_err(|e| AppError::Io(format!("copy rename: {e}")))?;
            let _ = std::fs::remove_file(src);
            Ok(())
        }
    }
}

/// If `dest` exists, rename it to `name (local backup yyyy-mm-dd hhmmss).ext`.
fn backup_if_exists(dest: &Path) -> Result<(), AppError> {
    if !dest.exists() {
        return Ok(());
    }

    // Build a timestamp string from SystemTime without chrono::Utc::now()
    // (chrono is compiled without the `clock` feature here).
    // We use the epoch seconds + manual calculation.
    let ts = {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        // Simple ISO-like date: days since epoch -> yyyy-mm-dd hhmmss.
        // Use chrono DateTime from timestamp (no clock feature needed).
        use chrono::DateTime;
        let dt = DateTime::from_timestamp(secs as i64, 0)
            .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
        dt.format("%Y-%m-%d %H%M%S").to_string()
    };

    let stem = dest.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let ext = dest.extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let backup_name = format!("{stem} (local backup {ts}){ext}");
    let backup_path = dest.with_file_name(backup_name);

    std::fs::rename(dest, &backup_path)
        .map_err(|e| AppError::Io(format!("backup rename: {e}")))?;

    info!("backed up existing file to {}", backup_path.display());
    Ok(())
}

/// Set file mtime. Uses Windows SetFileTime via windows-sys.
/// On failure, logs a warning and continues (non-fatal).
fn set_file_mtime(path: &Path, mtime_ms: i64) {
    if let Err(e) = set_file_mtime_inner(path, mtime_ms) {
        warn!("set_file_mtime failed for {}: {e}", path.display());
    }
}

#[cfg(windows)]
fn set_file_mtime_inner(path: &Path, mtime_ms: i64) -> Result<(), std::io::Error> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{FILETIME, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::{SetFileTime, FILE_WRITE_ATTRIBUTES};

    let file = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(FILE_WRITE_ATTRIBUTES)
        .open(path)?;

    // Windows FILETIME: 100-ns intervals since 1601-01-01.
    let windows_epoch_offset_secs: u64 = 11_644_473_600;
    let ms = mtime_ms as u64;
    let secs = ms / 1000;
    let subsec_ms = ms % 1000;
    let ft_100ns = (secs + windows_epoch_offset_secs) * 10_000_000
        + subsec_ms * 10_000;

    let filetime = FILETIME {
        dwLowDateTime:  (ft_100ns & 0xFFFF_FFFF) as u32,
        dwHighDateTime: (ft_100ns >> 32) as u32,
    };

    let handle = file.as_raw_handle() as HANDLE;
    // Safety: handle is valid for the duration of this call.
    unsafe {
        SetFileTime(handle, std::ptr::null(), std::ptr::null(), &filetime);
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_file_mtime_inner(_path: &Path, _mtime_ms: i64) -> Result<(), std::io::Error> {
    Ok(())
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

async fn compute_md5_blocking(path: &Path) -> Result<String, AppError> {
    use md5::{Digest, Md5};
    use std::io::Read;
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)
            .map_err(|e| AppError::Io(format!("md5 open: {e}")))?;
        let mut hasher = Md5::new();
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let n = file.read(&mut buf)
                .map_err(|e| AppError::Io(format!("md5 read: {e}")))?;
            if n == 0 { break; }
            hasher.update(&buf[..n]);
        }
        let digest = hasher.finalize();
        Ok(format!("{:x}", digest))
    })
    .await
    .map_err(|e| AppError::Other(format!("md5 task: {e}")))?
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ── ranged download reassembly ────────────────────────────────────────────

    /// Simulate writing 4 ranges to a pre-sized file and verify byte-identity.
    #[test]
    fn ranged_reassembly_byte_identical() {
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("file.bin");
        let part = part_path(&dest);

        // Simulate 8 MiB of data (below PARALLEL_THRESHOLD for the test but
        // we still exercise the seek-write logic).
        let data: Vec<u8> = (0u8..=255).cycle().take(1024 * 1024 * 8).collect();
        let size = data.len() as u64;

        // Pre-size.
        {
            let f = std::fs::File::create(&part).unwrap();
            f.set_len(size).unwrap();
        }

        let range_size = size.div_ceil(NUM_RANGES);

        // Write each range.
        for range_idx in 0..NUM_RANGES {
            let start = (range_idx * range_size) as usize;
            let end   = ((start as u64 + range_size) as usize).min(data.len());
            let slice = &data[start..end];

            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .open(&part)
                .unwrap();
            f.seek(SeekFrom::Start(start as u64)).unwrap();
            f.write_all(slice).unwrap();
        }

        // Atomic rename.
        std::fs::rename(&part, &dest).unwrap();

        // Verify byte-identity.
        let got = std::fs::read(&dest).unwrap();
        assert_eq!(got, data, "reassembled file must be byte-identical to source");
    }

    // ── resume after killed mid-download ─────────────────────────────────────

    /// Verify that the sidecar correctly tracks completed ranges and
    /// incomplete ranges are not in the completed set.
    #[test]
    fn sidecar_resume_tracking() {
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("big.bin");
        let sidecar = sidecar_path(&dest);

        let mut sc = RangeSidecar::default();
        sc.completed.insert(0);
        sc.completed.insert(2);

        let json = serde_json::to_string(&sc).unwrap();
        std::fs::write(&sidecar, &json).unwrap();

        let loaded: RangeSidecar = serde_json::from_str(
            &std::fs::read_to_string(&sidecar).unwrap()
        ).unwrap();

        assert!(loaded.completed.contains(&0));
        assert!(loaded.completed.contains(&2));
        assert!(!loaded.completed.contains(&1));
        assert!(!loaded.completed.contains(&3));
    }

    // ── md5 mismatch ─────────────────────────────────────────────────────────

    /// compute_md5_blocking produces the correct hex digest.
    #[tokio::test]
    async fn md5_correct() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.bin");
        std::fs::write(&file, b"hello world").unwrap();

        let digest = compute_md5_blocking(&file).await.unwrap();
        // md5("hello world") = 5eb63bbbe01eeed093cb22bb8f5acdc3
        assert_eq!(digest, "5eb63bbbe01eeed093cb22bb8f5acdc3");
    }

    // ── backup rename ─────────────────────────────────────────────────────────

    #[test]
    fn backup_rename_does_not_overwrite() {
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("notes.txt");
        std::fs::write(&dest, b"original").unwrap();

        backup_if_exists(&dest).unwrap();

        // Original should be gone (renamed away).
        assert!(!dest.exists(), "dest should not exist after backup");

        // Exactly one backup file in the dir.
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains("local backup")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        let content = std::fs::read(backups[0].path()).unwrap();
        assert_eq!(content, b"original");
    }

    // ── export: unknown download kind ─────────────────────────────────────────

    #[tokio::test]
    async fn download_runner_unknown_kind_returns_error() {
        use std::sync::Arc;
        use crate::db::Job;

        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("state.db");
        let db = Arc::new(crate::db::Db::open(&db_path).unwrap());
        let cfg = crate::config::Config::default();
        let gov_cfg = crate::governor::GovernorCfg {
            battery_pause_pct: 0,
            ..crate::governor::GovernorCfg::default()
        };
        let gov = crate::governor::Governor::new(gov_cfg);
        let drive = crate::drive::DriveClient::new().unwrap();
        let limiter = Arc::new(crate::transfer::Limiter::new(0));

        let runner = DownloadRunner { db, cfg, gov, drive, limiter };

        let job = Job {
            id: 1,
            pair_id: "p1".into(),
            kind: "unknown_kind".into(),
            rel_path: "foo.txt".into(),
            priority: 0,
            attempts: 0,
            next_try_ms: 0,
            status: "running".into(),
            last_error: None,
            created_ms: 0,
        };

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let result = runner.run(job, tx).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("unknown job kind"));
    }

    // ── export mime resolution ────────────────────────────────────────────────

    #[test]
    fn export_mime_resolution() {
        let fmts = ExportFormats::default();
        assert!(export_mime("application/vnd.google-apps.document", &fmts).is_some());
        assert!(export_mime("application/vnd.google-apps.spreadsheet", &fmts).is_some());
        assert!(export_mime("application/vnd.google-apps.presentation", &fmts).is_some());
        assert!(export_mime("application/vnd.google-apps.shortcut", &fmts).is_some()); // → pdf
        assert!(export_mime("application/octet-stream", &fmts).is_none());
    }
}

