//! P07 – Upload job runner.
//!
//! Implements `JobRunner` for kinds: `upload`, `delete`, `mkdir`.
//! - Small files (< 5 MiB): multipart upload.
//! - Large files (>= 5 MiB): resumable chunked upload with resume-on-restart.
//! - Respects governor checkpoint and bandwidth limiter between chunks.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::time::sleep;
use tracing::{info, warn};

use crate::config::Config;
use crate::db::{Db, FileRow};
use crate::error::AppError;
use crate::governor::Governor;
use crate::queue::{JobRunner, ProgressTx, ProgressUpdate};
use crate::db::Job;
use crate::drive::client::{DriveClient, ResumableStatus};
use crate::transfer::limiter::Limiter;

const SMALL_FILE_THRESHOLD: u64 = 5 * 1024 * 1024; // 5 MiB

// ── UploadRunner ──────────────────────────────────────────────────────────────

pub struct UploadRunner {
    pub db: Arc<Db>,
    pub cfg: Config,
    pub gov: Governor,
    pub drive: DriveClient,
    pub limiter: Arc<Limiter>,
}

impl JobRunner for UploadRunner {
    fn run(&self, job: Job, progress: ProgressTx)
        -> impl std::future::Future<Output = Result<(), AppError>> + Send
    {
        // Build owned copies of everything the future needs.
        let db = Arc::clone(&self.db);
        let cfg = self.cfg.clone();
        let gov = self.gov.clone();
        let drive = self.drive.clone();
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
                "upload"   => run_upload(job, db, cfg, gov, drive, limiter, progress).await,
                "delete"   => run_delete(job, db, cfg, drive).await,
                "mkdir"    => run_mkdir(job, db, cfg, drive).await,
                "download" => crate::transfer::download::run_download(job, db, cfg, gov, drive, limiter, progress).await,
                "restore"  => crate::transfer::download::run_restore(job, db, cfg, gov, drive, limiter, progress).await,
                other      => Err(AppError::Other(format!("unknown job kind: {other}"))),
            }
        }
    }
}

// ── upload ────────────────────────────────────────────────────────────────────

async fn run_upload(
    job: Job,
    db: Arc<Db>,
    cfg: Config,
    gov: Governor,
    drive: DriveClient,
    limiter: Arc<Limiter>,
    progress: ProgressTx,
) -> Result<(), AppError> {
    // Find the pair config.
    let pair = match cfg.pairs.iter().find(|p| p.id == job.pair_id) {
        Some(p) => p.clone(),
        None => {
            let _ = db.complete_job(job.id);
            return Ok(());
        }
    };

    let local_path = PathBuf::from(&pair.local).join(&job.rel_path);

    // Skip if file no longer exists (delete job will handle it separately).
    if !local_path.exists() {
        info!("upload: skip {}, file gone", job.rel_path);
        return Ok(());
    }

    let meta = std::fs::metadata(&local_path)
        .map_err(|e| AppError::Io(format!("upload metadata: {e}")))?;
    let size = meta.len();
    let mtime_ms = meta.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    // Get DB row for this file.
    let mut existing = db.get_file(&job.pair_id, &job.rel_path)?;
    if existing.as_ref().and_then(|r| r.drive_id.as_ref()).is_none() {
        if let Ok(Some(alt)) = db.find_any_file_by_rel_path(&job.rel_path) {
            if let Some(ref did) = alt.drive_id {
                let _ = db.set_drive_meta(
                    &job.pair_id,
                    &job.rel_path,
                    did,
                    alt.drive_md5.as_deref(),
                    alt.drive_mtime_ms,
                    alt.drive_rev.as_deref(),
                );
                existing = db.get_file(&job.pair_id, &job.rel_path)?;
            }
        }
    }

    // Compute local md5.
    gov.checkpoint().await;
    let local_md5 = compute_md5_blocking(&local_path).await?;

    // Skip if Drive already has the same content in local DB.
    if let Some(ref row) = existing {
        if row.drive_md5.as_deref() == Some(&local_md5)
            && row.size == Some(size as i64)
            && row.drive_id.is_some()
        {
            info!("upload: skip {} (unchanged)", job.rel_path);
            db.mark_state(&job.pair_id, &job.rel_path, "synced")?;
            return Ok(());
        }
    }

    // Resolve Drive parent folder.
    let rel_dir = parent_dir(&job.rel_path);
    let parent_id = drive.ensure_path(&job.pair_id, &pair.drive_folder_id, &rel_dir).await?;
    let file_name = file_name(&job.rel_path);
    let mut existing_drive_id = existing.as_ref().and_then(|r| r.drive_id.clone());

    // Google Drive remote deduplication guard:
    // If not known locally, verify directly with Google Drive before creating a new file.
    if existing_drive_id.is_none() {
        if let Ok(Some(remote_child)) = drive.find_child(&parent_id, &file_name).await {
            let remote_id = remote_child.id.clone();
            let remote_md5 = remote_child.md5_checksum;
            let remote_size = remote_child.size.and_then(|s| s.parse::<i64>().ok());

            // If Drive already has identical content, skip upload and record metadata.
            if remote_md5.as_deref() == Some(&local_md5)
                && (remote_size.is_none() || remote_size == Some(size as i64))
            {
                info!("upload: skip {} (already exists on Drive: {})", job.rel_path, remote_id);
                let _ = db.set_drive_meta(
                    &job.pair_id,
                    &job.rel_path,
                    &remote_id,
                    remote_md5.as_deref(),
                    None,
                    None,
                );
                db.mark_state(&job.pair_id, &job.rel_path, "synced")?;
                return Ok(());
            }

            // Remote file exists but differs: update it in-place instead of creating a duplicate!
            existing_drive_id = Some(remote_id);
        }
    }
    let modified_time = ms_to_rfc3339(mtime_ms);
    let mime = "application/octet-stream";

    let meta_result = if size < SMALL_FILE_THRESHOLD {
        // ── Multipart upload ──────────────────────────────────────────────────
        gov.checkpoint().await;
        limiter.acquire(size).await;

        let data = read_file_blocking(&local_path).await?;
        let bytes_total = data.len() as u64;

        let _ = progress.send(ProgressUpdate {
            job_id: job.id,
            pair_id: job.pair_id.clone(),
            rel_path: job.rel_path.clone(),
            bytes_done: 0,
            bytes_total,
        });

        let m = drive.multipart_upload(
            &parent_id, &file_name,
            existing_drive_id.as_deref(),
            &modified_time, data, mime,
        ).await?;

        let _ = progress.send(ProgressUpdate {
            job_id: job.id,
            pair_id: job.pair_id.clone(),
            rel_path: job.rel_path.clone(),
            bytes_done: bytes_total,
            bytes_total,
        });

        m
    } else {
        // ── Resumable upload ──────────────────────────────────────────────────
        resumable_upload(
            &job, size, &local_path, &modified_time, &parent_id, &file_name,
            existing_drive_id.as_deref(), mime,
            &db, &cfg, &gov, &drive, &limiter, &progress,
        ).await?
    };

    // Verify md5 returned by Drive.
    if let Some(ref server_md5) = meta_result.md5_checksum {
        if *server_md5 != local_md5 {
            return Err(AppError::Drive(format!(
                "md5 mismatch for {}: local={local_md5} server={server_md5}",
                job.rel_path
            )));
        }
    }

    // Update DB.
    let file_row = FileRow {
        pair_id: job.pair_id.clone(),
        rel_path: job.rel_path.clone(),
        size: Some(size as i64),
        mtime_ms: Some(mtime_ms),
        md5: Some(local_md5),
        drive_id: Some(meta_result.id.clone()),
        drive_md5: meta_result.md5_checksum.clone(),
        drive_mtime_ms: Some(mtime_ms),
        drive_rev: meta_result.head_revision_id.clone(),
        state: "synced".into(),
    };
    db.upsert_file(file_row)?;

    // Clear any stale upload session.
    let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);

    info!("uploaded {} ({} bytes, drive_id={})", job.rel_path, size, meta_result.id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn resumable_upload(
    job: &Job,
    total_size: u64,
    local_path: &Path,
    modified_time: &str,
    parent_id: &str,
    file_name: &str,
    existing_drive_id: Option<&str>,
    mime: &str,
    db: &Arc<Db>,
    cfg: &Config,
    gov: &Governor,
    drive: &DriveClient,
    limiter: &Arc<Limiter>,
    progress: &ProgressTx,
) -> Result<crate::drive::client::DriveFileMeta, AppError> {
    let chunk_size = (cfg.app.chunk_mib as u64) * 1024 * 1024;
    let _now_ms = now_ms();

    // Check for existing session and query offset.
    let (session_uri, start_offset) = match db.get_upload_session(&job.pair_id, &job.rel_path)? {
        Some(uri) => {
            // Try to resume.
            match drive.query_resumable_status(&uri, total_size).await {
                Ok(ResumableStatus::Complete(meta)) => {
                    info!("upload session for {} was already completed remotely", job.rel_path);
                    let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);
                    return Ok(meta);
                }
                Ok(ResumableStatus::Incomplete(offset)) if offset < total_size => {
                    info!("resuming upload {} from byte {offset}", job.rel_path);
                    (uri, offset)
                }
                _ => {
                    // Session gone, completed, or corrupted; start fresh.
                    let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);
                    let new_uri = init_new_session(
                        job, total_size, modified_time, parent_id, file_name,
                        existing_drive_id, mime, db, drive,
                    ).await?;
                    (new_uri, 0)
                }
            }
        }
        None => {
            let new_uri = init_new_session(
                job, total_size, modified_time, parent_id, file_name,
                existing_drive_id, mime, db, drive,
            ).await?;
            (new_uri, 0)
        }
    };

    // Stream chunks.
    let mut file = std::fs::File::open(local_path)
        .map_err(|e| AppError::Io(format!("open for upload: {e}")))?;

    let mut offset = start_offset;

    while offset < total_size {
        gov.checkpoint().await;

        let remaining = total_size - offset;
        let this_chunk = remaining.min(chunk_size) as usize;
        let mut buf = vec![0u8; this_chunk];

        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(offset))
            .map_err(|e| AppError::Io(format!("seek to byte {offset}: {e}")))?;

        let mut read_bytes = 0;
        while read_bytes < this_chunk {
            let n = file.read(&mut buf[read_bytes..])
                .map_err(|e| AppError::Io(format!("read chunk: {e}")))?;
            if n == 0 {
                break;
            }
            read_bytes += n;
        }

        if read_bytes == 0 {
            break;
        }
        buf.truncate(read_bytes);

        limiter.acquire(read_bytes as u64).await;

        let _ = progress.send(ProgressUpdate {
            job_id: job.id,
            pair_id: job.pair_id.clone(),
            rel_path: job.rel_path.clone(),
            bytes_done: offset,
            bytes_total: total_size,
        });

        // Retry individual chunk on transient error (up to 4 retries).
        let mut chunk_delay = Duration::from_millis(500);
        let mut chunk_attempts = 0;
        let mut chunk_done = false;

        while !chunk_done {
            chunk_attempts += 1;
            match drive.upload_chunk(&session_uri, buf.clone(), offset, total_size).await {
                Ok(Some(meta)) => {
                    // Upload complete!
                    let _ = progress.send(ProgressUpdate {
                        job_id: job.id,
                        pair_id: job.pair_id.clone(),
                        rel_path: job.rel_path.clone(),
                        bytes_done: total_size,
                        bytes_total: total_size,
                    });
                    let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);
                    return Ok(meta);
                }
                Ok(None) => {
                    // 308 Resume Incomplete: this chunk was successfully saved by Drive.
                    offset += read_bytes as u64;
                    chunk_done = true;
                }
                Err(e) => {
                    let err_str = e.to_string();
                    let is_fatal_session = err_str.contains("400")
                        || err_str.contains("404")
                        || err_str.contains("410")
                        || err_str.contains("expired");

                    if is_fatal_session || chunk_attempts > 4 {
                        if is_fatal_session {
                            warn!("resumable session rejected ({err_str}), purging session cache to restart cleanly");
                            let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);
                        }
                        return Err(e);
                    }

                    warn!("chunk error (attempt {chunk_attempts}), checking session offset and retrying: {e}");
                    sleep(chunk_delay).await;
                    chunk_delay = (chunk_delay * 2).min(Duration::from_secs(30));

                    // Query server for the real current offset
                    match drive.query_resumable_status(&session_uri, total_size).await {
                        Ok(ResumableStatus::Complete(meta)) => {
                            let _ = progress.send(ProgressUpdate {
                                job_id: job.id,
                                pair_id: job.pair_id.clone(),
                                rel_path: job.rel_path.clone(),
                                bytes_done: total_size,
                                bytes_total: total_size,
                            });
                            let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);
                            return Ok(meta);
                        }
                        Ok(ResumableStatus::Incomplete(server_offset)) => {
                            if server_offset >= offset + read_bytes as u64 {
                                // Server actually received the ENTIRE chunk before the network dropped!
                                offset = server_offset;
                                chunk_done = true;
                            } else if server_offset > offset {
                                // Server received partial chunk: advance offset, break out to outer loop to re-slice file buffer
                                offset = server_offset;
                                break;
                            }
                            // If server_offset <= offset, server received nothing; retry uploading this same buffer.
                        }
                        Err(q_err) => {
                            let q_str = q_err.to_string();
                            if q_str.contains("400") || q_str.contains("404") || q_str.contains("expired") {
                                let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);
                                return Err(q_err);
                            }
                        }
                    }
                }
            }
        }
    }

    // Final check if server already has the complete file.
    match drive.query_resumable_status(&session_uri, total_size).await {
        Ok(ResumableStatus::Complete(meta)) => {
            let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);
            Ok(meta)
        }
        _ => {
            let _ = db.delete_upload_session(&job.pair_id, &job.rel_path);
            Err(AppError::Drive("resumable upload ended without completion response".into()))
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn init_new_session(
    job: &Job,
    total_size: u64,
    modified_time: &str,
    parent_id: &str,
    file_name: &str,
    existing_drive_id: Option<&str>,
    mime: &str,
    db: &Arc<Db>,
    drive: &DriveClient,
) -> Result<String, AppError> {
    let uri = drive.init_resumable(
        parent_id, file_name, existing_drive_id,
        modified_time, total_size, mime,
    ).await?;
    db.set_upload_session(&job.pair_id, &job.rel_path, &uri, total_size as i64, now_ms())?;
    Ok(uri)
}

// ── delete ────────────────────────────────────────────────────────────────────

async fn run_delete(
    job: Job,
    db: Arc<Db>,
    cfg: Config,
    drive: DriveClient,
) -> Result<(), AppError> {
    use crate::config::DeletionPolicy;

    if !cfg.pairs.iter().any(|p| p.id == job.pair_id) {
        let _ = db.complete_job(job.id);
        return Ok(());
    }

    let existing = db.get_file(&job.pair_id, &job.rel_path)?;
    let drive_id = match existing.as_ref().and_then(|r| r.drive_id.as_deref()) {
        Some(id) => id.to_string(),
        None => {
            info!("delete: no drive_id for {}, skipping", job.rel_path);
            return Ok(());
        }
    };

    match cfg.policy.deletion {
        DeletionPolicy::Ignore => {}
        DeletionPolicy::DriveTrash => {
            drive.trash(&drive_id).await?;
            db.mark_state(&job.pair_id, &job.rel_path, "trashed")?;
        }
        DeletionPolicy::Delete => {
            drive.delete(&drive_id).await?;
            db.mark_state(&job.pair_id, &job.rel_path, "deleted")?;
        }
    }

    info!("deleted/trashed {} (policy={:?})", job.rel_path, cfg.policy.deletion);
    Ok(())
}

// ── mkdir ─────────────────────────────────────────────────────────────────────

async fn run_mkdir(
    job: Job,
    db: Arc<Db>,
    cfg: Config,
    drive: DriveClient,
) -> Result<(), AppError> {
    let pair = match cfg.pairs.iter().find(|p| p.id == job.pair_id) {
        Some(p) => p,
        None => {
            let _ = db.complete_job(job.id);
            return Ok(());
        }
    };

    drive.ensure_path(&job.pair_id, &pair.drive_folder_id, &job.rel_path).await?;
    info!("mkdir: ensured {}", job.rel_path);
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn parent_dir(rel_path: &str) -> String {
    let normalized = rel_path.replace('\\', "/");
    match normalized.rfind('/') {
        Some(idx) => normalized[..idx].to_string(),
        None => String::new(),
    }
}

fn file_name(rel_path: &str) -> String {
    let normalized = rel_path.replace('\\', "/");
    match normalized.rfind('/') {
        Some(idx) => normalized[idx + 1..].to_string(),
        None => normalized,
    }
}

fn ms_to_rfc3339(ms: i64) -> String {
    // Produce RFC 3339 from epoch milliseconds without chrono dep.
    let secs = ms / 1000;
    let dur = Duration::from_secs(secs as u64);
    let epoch = UNIX_EPOCH + dur;
    // Use SystemTime to get a formatted string via chrono.
    use chrono::{DateTime, Utc};
    let dt: DateTime<Utc> = epoch.into();
    dt.to_rfc3339()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

async fn read_file_blocking(path: &Path) -> Result<Vec<u8>, AppError> {
    let path = path.to_path_buf();
    let path = path.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::read(&path).map_err(|e| AppError::Io(format!("read file: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("spawn_blocking: {e}")))?
}

async fn compute_md5_blocking(path: &Path) -> Result<String, AppError> {
    use md5::{Digest, Md5};
    let path = path.to_path_buf();
    let path = path.clone();
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
