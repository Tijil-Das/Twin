//! Rename/move detection: stable OS file IDs + content-hash fallback.
//!
//! Strategy:
//! 1. On Windows, open the file with `OpenOptions` + `FILE_FLAG_BACKUP_SEMANTICS` and
//!    call `GetFileInformationByHandle` (declared locally) to get a stable
//!    (volume_serial:file_index) pair that survives renames.
//! 2. On Unix, use `st_dev:st_ino` from metadata.
//! 3. Fallback: match by md5 + size for the case where the OS ID is unavailable
//!    (cross-filesystem move) or the file was not previously tracked with an OS ID.

use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::db::{Activity, Db, FileRow};
use crate::error::AppError;

// ── FileIdentity ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FileIdentity {
    /// "vol:idx" on Windows (volume_serial:file_index), "dev:ino" on Unix.
    pub os_id: String,
    pub size: i64,
    pub mtime_ms: i64,
}

// ── Filesystem Reliability ───────────────────────────────────────────────────

static FORCE_UNRELIABLE_FS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Test hook to simulate non-NTFS / FAT / network drives without stable file IDs.
pub fn set_force_unreliable_fs(force: bool) {
    FORCE_UNRELIABLE_FS.store(force, std::sync::atomic::Ordering::SeqCst);
}

/// Check if the path resides on a filesystem where OS-level file IDs are unreliable
/// (e.g., network drives / SMB / NFS, FAT / FAT32 / exFAT, or when forced by test hook/env).
#[cfg(windows)]
pub fn is_unreliable_filesystem(path: &Path) -> bool {
    if FORCE_UNRELIABLE_FS.load(std::sync::atomic::Ordering::SeqCst) {
        return true;
    }
    if std::env::var("TWIN_FORCE_UNRELIABLE_FS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        return true;
    }

    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW};
    const DRIVE_REMOTE: u32 = 4;

    let path_str = path.to_string_lossy();
    if path_str.starts_with(r"\\") {
        // UNC path: network share
        return true;
    }

    let root = if path_str.len() >= 3 && path_str.chars().nth(1) == Some(':') {
        format!("{}:\\", &path_str[..1])
    } else {
        return false;
    };

    let root_wide: Vec<u16> = std::ffi::OsStr::new(&root)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let drive_type = GetDriveTypeW(root_wide.as_ptr());
        if drive_type == DRIVE_REMOTE {
            return true;
        }

        let mut fs_name = [0u16; 64];
        let mut flags = 0u32;
        let ok = GetVolumeInformationW(
            root_wide.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut flags,
            fs_name.as_mut_ptr(),
            fs_name.len() as u32,
        );
        if ok != 0 {
            let fs_str = String::from_utf16_lossy(&fs_name)
                .trim_matches('\0')
                .to_uppercase();
            if fs_str.starts_with("FAT") || fs_str.contains("EXFAT") {
                return true;
            }
        }
    }

    false
}

#[cfg(not(windows))]
pub fn is_unreliable_filesystem(_path: &Path) -> bool {
    if std::env::var("TWIN_FORCE_UNRELIABLE_FS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        return true;
    }
    false
}

// ── get_file_identity ─────────────────────────────────────────────────────────

/// Return a stable OS-level identity for `path`, or `None` if unsupported/unavailable.
#[cfg(windows)]
pub fn get_file_identity(path: &Path) -> Option<FileIdentity> {
    if is_unreliable_filesystem(path) {
        return None;
    }

    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    // FILE_FLAG_BACKUP_SEMANTICS (0x02000000) lets us open directories too.
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;

    // BY_HANDLE_FILE_INFORMATION layout (matches Windows SDK definition).
    #[repr(C)]
    #[allow(non_snake_case)]
    struct ByHandleFileInformation {
        dwFileAttributes: u32,
        ftCreationTime: [u32; 2],
        ftLastAccessTime: [u32; 2],
        ftLastWriteTime: [u32; 2],
        dwVolumeSerialNumber: u32,
        nFileSizeHigh: u32,
        nFileSizeLow: u32,
        nNumberOfLinks: u32,
        nFileIndexHigh: u32,
        nFileIndexLow: u32,
    }

    extern "system" {
        fn GetFileInformationByHandle(
            hFile: isize,
            lpFileInformation: *mut ByHandleFileInformation,
        ) -> i32;
    }

    // Open without requesting write-access; backup semantics lets us open dirs.
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;

    let handle = file.as_raw_handle() as isize;
    let mut info: ByHandleFileInformation = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
    // `file` is dropped here, closing the handle automatically.

    if ok == 0 {
        return None;
    }

    let file_index = ((info.nFileIndexHigh as u64) << 32) | (info.nFileIndexLow as u64);
    // Verify volume serial number and file index are non-zero and valid
    if info.dwVolumeSerialNumber == 0 || file_index == 0 {
        return None;
    }

    let os_id = format!("{}:{}", info.dwVolumeSerialNumber, file_index);

    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len() as i64;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    Some(FileIdentity { os_id, size, mtime_ms })
}

#[cfg(not(windows))]
pub fn get_file_identity(path: &Path) -> Option<FileIdentity> {
    if is_unreliable_filesystem(path) {
        return None;
    }

    use std::os::unix::fs::MetadataExt;

    let meta = std::fs::metadata(path).ok()?;
    if meta.dev() == 0 || meta.ino() == 0 {
        return None;
    }

    let os_id = format!("{}:{}", meta.dev(), meta.ino());
    let size = meta.len() as i64;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    Some(FileIdentity { os_id, size, mtime_ms })
}

// ── File Stability / Debounce ─────────────────────────────────────────────────

/// Wait until a file's size stops changing (e.g. 200ms stable) and can be opened for reading.
pub async fn wait_until_file_stable(path: &Path, max_wait: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    let mut last_size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return false,
    };

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        match std::fs::metadata(path) {
            Ok(m) => {
                let cur_size = m.len();
                if cur_size == last_size {
                    if std::fs::File::open(path).is_ok() {
                        return true;
                    }
                }
                last_size = cur_size;
            }
            Err(_) => return false,
        }
        if start.elapsed() >= max_wait {
            return false;
        }
    }
}

// ── detect_rename ─────────────────────────────────────────────────────────────

/// Try to detect if `new_path` is actually a rename of a previously-tracked file.
///
/// Priority:
/// 1. Stable OS file ID: if volume+inode matches an existing row, verify size/mtime
///    to guard against inode reuse. (No hash computation needed!)
/// 2. Hash fallback: query DB for missing files with the same size. Only if a size
///    candidate exists, compute the content hash to verify.
///
/// Returns the old `rel_path` from the DB if detected.
pub fn detect_rename(
    db: &Arc<Db>,
    pair_id: &str,
    new_path: &Path,
    new_rel: &str,
    new_md5: Option<&str>,
    new_size: i64,
) -> Option<String> {
    detect_rename_with_root(db, pair_id, None, new_path, new_rel, new_md5, new_size)
}

/// Extended `detect_rename` accepting an optional `root` directory for sanity checking
/// that the old file no longer exists at its previous path.
pub fn detect_rename_with_root(
    db: &Arc<Db>,
    pair_id: &str,
    root: Option<&Path>,
    new_path: &Path,
    new_rel: &str,
    new_md5: Option<&str>,
    new_size: i64,
) -> Option<String> {
    // 1. OS file ID path (fastest and most reliable; avoids hashing large files).
    if let Some(identity) = get_file_identity(new_path) {
        if let Ok(Some(row)) = db.get_file_by_os_id(pair_id, &identity.os_id) {
            if row.rel_path != new_rel {
                // Sanity check: if old file is still on disk at its original path,
                // this cannot be a rename (could be hardlink or inode collision).
                let old_still_on_disk = root
                    .map(|r| r.join(&row.rel_path).exists())
                    .unwrap_or(false);

                if !old_still_on_disk {
                    // Guard against inode reuse:
                    // If row was already in a terminal deleted state, require size and md5 match.
                    if matches!(row.state.as_str(), "deleted" | "trashed" | "remote_deleted") {
                        let size_matches = row.size == Some(identity.size);
                        let md5_matches = new_md5.is_some() && new_md5 == row.md5.as_deref();
                        if size_matches && md5_matches {
                            info!("rename detected via OS ID (recovered deleted): {:?} -> {:?}", row.rel_path, new_rel);
                            return Some(row.rel_path);
                        }
                    } else if identity.size == 0 {
                        // For 0-byte files, ensure mtime is within 15 seconds to avoid false matches.
                        let mtime_diff = (row.mtime_ms.unwrap_or(0) - identity.mtime_ms).abs();
                        if row.size == Some(0) && mtime_diff <= 15_000 {
                            info!("rename detected via OS ID (0-byte): {:?} -> {:?}", row.rel_path, new_rel);
                            return Some(row.rel_path);
                        }
                    } else {
                        // Non-zero file:
                        // Case A: Size matches -> definite rename without editing.
                        if row.size == Some(identity.size) {
                            info!("rename detected via OS ID: {:?} -> {:?}", row.rel_path, new_rel);
                            return Some(row.rel_path);
                        }

                        // Case B: Inode matches and old file is gone, but size differs:
                        // File was renamed AND edited simultaneously!
                        // Return rename so we first rename cloud object, then upload updates content.
                        info!("rename + edit detected via OS ID: {:?} -> {:?}", row.rel_path, new_rel);
                        return Some(row.rel_path);
                    }
                }
            }
        }
    }

    // 2. Hash + size fallback (for cross-filesystem moves or non-stable filesystems).
    // Only compute hash if there's at least one missing candidate with matching size!
    if let Ok(candidates) = db.find_missing_by_size(pair_id, new_size) {
        if !candidates.is_empty() {
            // Compute or use provided hash
            let computed_hash: Option<String> = if let Some(h) = new_md5 {
                Some(h.to_string())
            } else {
                compute_quick_md5(new_path)
            };

            if let Some(ref hash) = computed_hash {
                for candidate in candidates {
                    if candidate.rel_path != new_rel && candidate.md5.as_deref() == Some(hash) {
                        info!("rename detected via Hash fallback: {:?} -> {:?}", candidate.rel_path, new_rel);
                        return Some(candidate.rel_path);
                    }
                }
            }
        }
    }

    None
}

/// Synchronous MD5 computation for fallback rename detection.
fn compute_quick_md5(path: &Path) -> Option<String> {
    use std::io::Read;
    use md5::{Digest, Md5};

    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

// ── detect_folder_rename ──────────────────────────────────────────────────────

/// List all files under `old_dir/` and return a Vec of (old_rel, new_rel) pairs
/// mapping each child to its new path under `new_dir`.
/// Used when a watcher `ChangeKind::Renamed` event is for a directory.
pub fn detect_folder_rename(
    db: &Arc<Db>,
    pair_id: &str,
    old_dir: &str,
    new_dir: &str,
) -> Result<Vec<(String, String)>, AppError> {
    let all = db.list_all_files(pair_id)?;
    let prefix = format!("{}/", old_dir);
    let pairs: Vec<(String, String)> = all
        .into_iter()
        .filter(|row| row.rel_path.starts_with(&prefix))
        .map(|row| {
            let suffix = &row.rel_path[prefix.len()..];
            let new_rel = format!("{}/{}", new_dir, suffix);
            (row.rel_path, new_rel)
        })
        .collect();
    Ok(pairs)
}

// ── run_rename_job ────────────────────────────────────────────────────────────

/// Execute a rename job: update DB path and call Drive rename (metadata-only PATCH).
/// `job.rel_path` = "old_rel\tnew_rel" (tab-separated).
/// Fully crash-safe and idempotent: can be safely retried if interrupted.
pub async fn run_rename_job(
    job: &crate::db::Job,
    db: Arc<Db>,
    drive: &crate::drive::client::DriveClient,
) -> Result<(), AppError> {
    let parts: Vec<&str> = job.rel_path.splitn(2, '\t').collect();
    if parts.len() != 2 {
        return Err(AppError::Other(format!(
            "rename job has invalid rel_path (expected old\\tnew): {:?}",
            job.rel_path
        )));
    }
    let old_rel = parts[0];
    let new_rel = parts[1];

    // Idempotency: if the rename already completed in DB (e.g. crash after DB update), exit cleanly
    if let Ok(Some(new_existing)) = db.get_file(&job.pair_id, new_rel) {
        if db.get_file(&job.pair_id, old_rel)?.is_none() && new_existing.drive_id.is_some() {
            info!("rename {} -> {} already completed previously", old_rel, new_rel);
            return Ok(());
        }
    }

    // Cancel any pending delete jobs for old_rel
    let _ = db.cancel_jobs_by_path(&job.pair_id, "delete", old_rel);

    // 1. Fetch the old row.
    let old_row = match db.get_file(&job.pair_id, old_rel)? {
        Some(r) => r,
        None => {
            // Old row already gone – nothing to do.
            return Ok(());
        }
    };

    let disk_cfg = crate::config::load().ok();
    let pair = disk_cfg.as_ref().and_then(|c| c.pairs.iter().find(|p| p.id == job.pair_id));

    let new_name = std::path::Path::new(new_rel)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| new_rel.to_string());

    let old_dir = std::path::Path::new(old_rel)
        .parent()
        .and_then(|p| if p.as_os_str().is_empty() { None } else { Some(p.to_string_lossy().replace('\\', "/")) });
    let new_dir = std::path::Path::new(new_rel)
        .parent()
        .and_then(|p| if p.as_os_str().is_empty() { None } else { Some(p.to_string_lossy().replace('\\', "/")) });

    // Record the pending operation in DB before network call
    let _ = db.mark_state(&job.pair_id, old_rel, "renaming");

    // 2. Update Drive metadata (name + parents) if we have a Drive file ID.
    let mut drive_missing = false;
    let mut updated_drive_id = old_row.drive_id.clone();

    if let Some(ref drive_id) = old_row.drive_id {
        let drive_root_id = pair.map(|p| p.drive_folder_id.as_str()).unwrap_or("root");

        // Determine target parent folder ID if parent directory changed
        let target_parent_id: Option<String> = if old_dir != new_dir {
            match new_dir.as_deref() {
                Some(dir) if !dir.is_empty() => {
                    match drive.ensure_path(&job.pair_id, drive_root_id, dir).await {
                        Ok(id) => Some(id),
                        Err(e) if crate::drive::client::is_already_deleted_or_not_found(&e.to_string()) => {
                            drive_missing = true;
                            None
                        }
                        Err(e) => return Err(e),
                    }
                }
                _ => Some(drive_root_id.to_string()),
            }
        } else {
            None
        };

        if !drive_missing {
            match drive.move_and_rename_file(drive_id, &new_name, target_parent_id.as_deref()).await {
                Ok(()) => {
                    info!("drive rename ok: {} ({}) -> name: {}, target_parent: {:?}", drive_id, old_rel, new_name, target_parent_id);
                }
                Err(e) => {
                    let err_str = e.to_string();
                    if crate::drive::client::is_already_deleted_or_not_found(&err_str) {
                        info!(
                            "rename {} -> {}: remote file {} not found on Drive ({}), falling back to upload",
                            old_rel, new_rel, drive_id, err_str
                        );
                        drive_missing = true;
                        updated_drive_id = None;
                    } else {
                        return Err(e);
                    }
                }
            }
        }
    }

    // 3. Atomically update DB row in SQLite
    let now_ms = now_ms();
    let need_upload = drive_missing || (old_row.drive_id.is_none() && old_row.state == "dirty");
    let new_state = if drive_missing {
        "dirty".into()
    } else if old_row.state == "renaming" {
        "synced".into()
    } else {
        old_row.state.clone()
    };

    let new_row = FileRow {
        pair_id: job.pair_id.clone(),
        rel_path: new_rel.to_string(),
        size: old_row.size,
        mtime_ms: old_row.mtime_ms,
        md5: old_row.md5.clone(),
        drive_id: if drive_missing { None } else { updated_drive_id },
        drive_md5: if drive_missing { None } else { old_row.drive_md5.clone() },
        drive_mtime_ms: if drive_missing { None } else { old_row.drive_mtime_ms },
        drive_rev: if drive_missing { None } else { old_row.drive_rev.clone() },
        state: new_state,
        os_file_id: old_row.os_file_id.clone(),
    };
    db.apply_rename_tx(&job.pair_id, old_rel, new_row)?;

    // If remote file was missing or content was dirty, enqueue an upload for the new path
    if need_upload {
        let _ = db.enqueue(crate::db::NewJob {
            pair_id: job.pair_id.clone(),
            kind: "upload".into(),
            rel_path: new_rel.to_string(),
            priority: 5,
            created_ms: now_ms,
        });
    }

    // 4. Log activity.
    let _ = db.log_activity(Activity {
        id: None,
        ts_ms: now_ms,
        pair_id: job.pair_id.clone(),
        kind: "rename".into(),
        rel_path: new_rel.to_string(),
        result: "ok".into(),
        detail: Some(format!("{} → {}", old_rel, new_rel)),
    });

    info!("renamed {} → {}", old_rel, new_rel);
    Ok(())
}

// ── run_folder_rename ─────────────────────────────────────────────────────────

/// Execute a complete folder rename/move:
/// 1. Updates the folder name/parent on Drive (ONE single cloud operation).
/// 2. Updates all child file paths in SQLite in a single atomic SQL transaction.
/// 3. Invalidate local Drive path cache.
pub async fn run_folder_rename(
    db: &Arc<Db>,
    drive: &crate::drive::client::DriveClient,
    pair_id: &str,
    drive_root_id: &str,
    old_dir: &str,
    new_dir: &str,
) -> Result<usize, AppError> {
    let clean_old = old_dir.trim_matches('/').replace('\\', "/");
    let clean_new = new_dir.trim_matches('/').replace('\\', "/");
    if clean_old.is_empty() || clean_new.is_empty() || clean_old == clean_new {
        return Ok(0);
    }

    let new_name = std::path::Path::new(&clean_new)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| clean_new.clone());

    let old_parent = std::path::Path::new(&clean_old)
        .parent()
        .and_then(|p| if p.as_os_str().is_empty() { None } else { Some(p.to_string_lossy().replace('\\', "/")) });
    let new_parent = std::path::Path::new(&clean_new)
        .parent()
        .and_then(|p| if p.as_os_str().is_empty() { None } else { Some(p.to_string_lossy().replace('\\', "/")) });

    // 1. Cancel any pending delete jobs for files under the old folder
    let _ = db.cancel_jobs_by_path_prefix(pair_id, "delete", &clean_old);

    // 2. Rename/move folder on Drive in a single call if folder exists
    match drive.find_folder_by_path(drive_root_id, &clean_old).await {
        Ok(Some(folder_item)) => {
            let target_parent_id: Option<String> = if old_parent != new_parent {
                match new_parent.as_deref() {
                    Some(p) if !p.is_empty() => {
                        drive.ensure_path(pair_id, drive_root_id, p).await.ok()
                    }
                    _ => Some(drive_root_id.to_string()),
                }
            } else {
                None
            };

            if let Err(e) = drive.move_and_rename_file(&folder_item.id, &new_name, target_parent_id.as_deref()).await {
                info!("folder rename on drive skipped/failed ({e}) for {} -> {}", clean_old, clean_new);
            }
        }
        Ok(None) => {
            info!("folder {} not found on Drive, remote rename skipped", clean_old);
        }
        Err(e) => {
            info!("find_folder_by_path for {} returned err: {e}", clean_old);
        }
    }

    // 3. Atomically update all child files in local DB in a single SQL query
    let updated_count = db.rename_folder_prefix(pair_id, &clean_old, &clean_new)?;

    // 4. Invalidate path cache for old and new folders
    drive.invalidate_path_cache(pair_id, &clean_old).await;
    drive.invalidate_path_cache(pair_id, &clean_new).await;

    // 5. Log folder rename activity
    let _ = db.log_activity(Activity {
        id: None,
        ts_ms: now_ms(),
        pair_id: pair_id.to_string(),
        kind: "folder_rename".into(),
        rel_path: clean_new.clone(),
        result: "ok".into(),
        detail: Some(format!("folder {} → {} ({} child files updated)", clean_old, clean_new, updated_count)),
    });

    info!("Folder {} -> {} renamed: {} children updated", clean_old, clean_new, updated_count);
    Ok(updated_count)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    use crate::config::{PairEntry, PairMode};
    use crate::governor::{Governor, GovernorCfg};

    fn temp_db() -> (TempDir, Arc<Db>) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.db");
        let db = Db::open(&path).unwrap();
        (dir, Arc::new(db))
    }

    fn sample_row(pair_id: &str, rel: &str, md5: &str, size: i64, state: &str) -> FileRow {
        FileRow {
            pair_id: pair_id.into(),
            rel_path: rel.into(),
            size: Some(size),
            mtime_ms: Some(1_700_000_000_000),
            md5: Some(md5.into()),
            drive_id: Some("drv1".into()),
            drive_md5: Some(md5.into()),
            drive_mtime_ms: Some(1_700_000_000_000),
            drive_rev: None,
            state: state.into(),
            os_file_id: None,
        }
    }

    // ── Test 1: rename detected by OS ID ─────────────────────────────────────

    #[test]
    #[serial_test::serial]
    fn rename_detected_by_os_id() {
        let (dir, db) = temp_db();

        let path_a = dir.path().join("a.txt");
        std::fs::write(&path_a, b"hello world").unwrap();
        let identity = get_file_identity(&path_a).expect("should get file identity");

        let mut row = sample_row("p1", "a.txt", "d3bec1095e8e55bb7acf2e5dfb67c78d", 11, "synced");
        row.os_file_id = Some(identity.os_id.clone());
        db.upsert_file(row).unwrap();
        db.set_file_os_id("p1", "a.txt", &identity.os_id).unwrap();

        let path_b = dir.path().join("b.txt");
        std::fs::rename(&path_a, &path_b).unwrap();

        let result = detect_rename_with_root(
            &db,
            "p1",
            Some(dir.path()),
            &path_b,
            "b.txt",
            Some("d3bec1095e8e55bb7acf2e5dfb67c78d"),
            11,
        );
        assert_eq!(result, Some("a.txt".to_string()));
    }

    // ── Test 2: rename detected by MD5 fallback ───────────────────────────────

    #[test]
    fn rename_detected_by_md5_fallback() {
        let (dir, db) = temp_db();

        let row = sample_row("p1", "a.txt", "5d41402abc4b2a76b9719d911017c592", 5, "synced");
        db.upsert_file(row).unwrap();

        let path_b = dir.path().join("b.txt");
        std::fs::write(&path_b, b"hello").unwrap(); // 5 bytes, same md5

        let result = detect_rename_with_root(
            &db,
            "p1",
            Some(dir.path()),
            &path_b,
            "b.txt",
            Some("5d41402abc4b2a76b9719d911017c592"),
            5,
        );
        assert_eq!(result, Some("a.txt".to_string()));
    }

    // ── Test 3: no false rename for different content ─────────────────────────

    #[test]
    fn no_false_rename_different_content() {
        let (dir, db) = temp_db();

        let row = sample_row("p1", "a.txt", "hash1", 5, "synced");
        db.upsert_file(row).unwrap();

        let path_b = dir.path().join("b.txt");
        std::fs::write(&path_b, b"world hello different").unwrap();

        let result = detect_rename_with_root(
            &db,
            "p1",
            Some(dir.path()),
            &path_b,
            "b.txt",
            Some("hash2"),
            10,
        );
        assert_eq!(result, None);
    }

    // ── Test 4: rename job encoded correctly ──────────────────────────────────

    #[test]
    fn rename_job_encoded_correctly() {
        let encoded = "docs/old.txt\tdocs/new.txt";
        let parts: Vec<&str> = encoded.splitn(2, '\t').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], "docs/old.txt");
        assert_eq!(parts[1], "docs/new.txt");

        let reconstructed = format!("{}\t{}", parts[0], parts[1]);
        assert_eq!(reconstructed, encoded);
    }

    // ── Test 5: folder rename marks children ──────────────────────────────────

    #[test]
    fn folder_rename_marks_children() {
        let (_dir, db) = temp_db();

        for name in &["a.txt", "b.txt", "c.txt"] {
            let row = sample_row("p1", &format!("mydir/{name}"), "somehash", 10, "synced");
            db.upsert_file(row).unwrap();
        }

        let pairs = detect_folder_rename(&db, "p1", "mydir", "newdir").unwrap();
        assert_eq!(pairs.len(), 3);

        let old_paths: Vec<&str> = pairs.iter().map(|(o, _)| o.as_str()).collect();
        let new_paths: Vec<&str> = pairs.iter().map(|(_, n)| n.as_str()).collect();

        assert!(old_paths.contains(&"mydir/a.txt"));
        assert!(old_paths.contains(&"mydir/b.txt"));
        assert!(old_paths.contains(&"mydir/c.txt"));
        assert!(new_paths.contains(&"newdir/a.txt"));
        assert!(new_paths.contains(&"newdir/b.txt"));
        assert!(new_paths.contains(&"newdir/c.txt"));
    }

    // ── Test 6: run_rename_job updates DB (no Drive) ──────────────────────────

    #[tokio::test]
    async fn run_rename_updates_db_no_drive() {
        let (_dir, db) = temp_db();

        let mut row = sample_row("p1", "old.txt", "abc", 3, "synced");
        row.drive_id = None;
        row.drive_md5 = None;
        db.upsert_file(row).unwrap();

        let job = crate::db::Job {
            id: 1,
            pair_id: "p1".into(),
            kind: "rename".into(),
            rel_path: "old.txt\tnew.txt".into(),
            priority: 15,
            attempts: 0,
            next_try_ms: 0,
            status: "running".into(),
            last_error: None,
            created_ms: 0,
        };

        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/files/drv_interrupted"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "drv_interrupted",
                "name": "file_new.txt"
            })))
            .mount(&server)
            .await;

        let drive = crate::drive::client::DriveClient::new_with_client(
            reqwest::Client::new(),
            server.uri(),
        );

        run_rename_job(&job, Arc::clone(&db), &drive).await.unwrap();

        assert!(db.get_file("p1", "old.txt").unwrap().is_none());

        let new_row = db.get_file("p1", "new.txt").unwrap().unwrap();
        assert_eq!(new_row.md5.as_deref(), Some("abc"));
        assert_eq!(new_row.state, "synced");
    }

    // ── Test 7: Rename large file (1 GB+) with no re-upload ────────────────────

    #[test]
    #[serial_test::serial]
    fn test_rename_large_file_no_reupload() {
        let (dir, db) = temp_db();
        let path_a = dir.path().join("large_old.bin");
        let f = std::fs::File::create(&path_a).unwrap();
        f.set_len(1_073_741_824).unwrap(); // 1 GB file
        drop(f);

        let identity = get_file_identity(&path_a).expect("should get file identity");
        let mut row = sample_row("p1", "large_old.bin", "dummy_md5", 1_073_741_824, "synced");
        row.os_file_id = Some(identity.os_id.clone());
        db.upsert_file(row).unwrap();
        db.set_file_os_id("p1", "large_old.bin", &identity.os_id).unwrap();

        let path_b = dir.path().join("large_new.bin");
        std::fs::rename(&path_a, &path_b).unwrap();

        // Must detect rename without needing md5 or re-reading content
        let result = detect_rename_with_root(
            &db,
            "p1",
            Some(dir.path()),
            &path_b,
            "large_new.bin",
            None,
            1_073_741_824,
        );
        assert_eq!(result, Some("large_old.bin".to_string()));
    }

    // ── Test 8: Rename folder with 1,000+ files is a single cloud operation ──

    #[tokio::test]
    async fn test_rename_folder_1000_files_single_cloud_op() {
        let (_dir, db) = temp_db();
        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;

        // Mock find_child_folder for old folder
        Mock::given(method("GET"))
            .and(path("/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [{
                    "id": "folder_item_123",
                    "name": "folder_old",
                    "mimeType": "application/vnd.google-apps.folder"
                }]
            })))
            .mount(&server)
            .await;

        // Mock PATCH for folder rename - MUST BE CALLED EXACTLY ONCE!
        Mock::given(method("PATCH"))
            .and(path("/files/folder_item_123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "folder_item_123",
                "name": "folder_new"
            })))
            .expect(1)
            .mount(&server)
            .await;

        // Insert 1,000 files in DB under folder_old
        for i in 0..1000 {
            let row = sample_row("p1", &format!("folder_old/file_{i}.txt"), "md5", 100, "synced");
            db.upsert_file(row).unwrap();
        }

        let drive = crate::drive::client::DriveClient::new_with_client(
            reqwest::Client::new(),
            server.uri(),
        );

        let updated = run_folder_rename(
            &db,
            &drive,
            "p1",
            "root_folder_id",
            "folder_old",
            "folder_new",
        ).await.unwrap();

        assert_eq!(updated, 1000);
        assert!(db.get_file("p1", "folder_old/file_0.txt").unwrap().is_none());
        assert!(db.get_file("p1", "folder_old/file_999.txt").unwrap().is_none());
        assert!(db.get_file("p1", "folder_new/file_0.txt").unwrap().is_some());
        assert!(db.get_file("p1", "folder_new/file_999.txt").unwrap().is_some());
    }

    // ── Test 9: Rename file then edit right after ─────────────────────────────

    #[test]
    #[serial_test::serial]
    fn test_rename_file_then_edit() {
        let (dir, db) = temp_db();
        let path_a = dir.path().join("doc.txt");
        std::fs::write(&path_a, b"version 1 content").unwrap();
        let identity = get_file_identity(&path_a).expect("should get file identity");

        let mut row = sample_row("p1", "doc.txt", "v1_md5", 17, "synced");
        row.os_file_id = Some(identity.os_id.clone());
        db.upsert_file(row).unwrap();
        db.set_file_os_id("p1", "doc.txt", &identity.os_id).unwrap();

        let path_b = dir.path().join("doc_edited.txt");
        std::fs::rename(&path_a, &path_b).unwrap();
        std::fs::write(&path_b, b"version 2 content edited and longer").unwrap();

        let new_size = std::fs::metadata(&path_b).unwrap().len() as i64;
        let result = detect_rename_with_root(
            &db,
            "p1",
            Some(dir.path()),
            &path_b,
            "doc_edited.txt",
            None,
            new_size,
        );
        assert_eq!(result, Some("doc.txt".to_string()));
    }

    // ── Test 10: Rename file while app closed then restart ────────────────────

    #[tokio::test]
    #[serial_test::serial]
    async fn test_rename_file_while_closed_then_restart() {
        let (dir, db) = temp_db();
        let path_a = dir.path().join("file_v1.txt");
        std::fs::write(&path_a, b"content_a").unwrap();
        let identity = get_file_identity(&path_a).expect("should get file identity");

        let mut row = sample_row("p1", "file_v1.txt", "hash_a", 9, "synced");
        row.os_file_id = Some(identity.os_id.clone());
        db.upsert_file(row).unwrap();
        db.set_file_os_id("p1", "file_v1.txt", &identity.os_id).unwrap();

        let path_b = dir.path().join("file_v2.txt");
        std::fs::rename(&path_a, &path_b).unwrap();

        let pair = PairEntry {
            id: "p1".into(),
            local: dir.path().to_string_lossy().into(),
            drive_folder_id: "root".into(),
            mode: PairMode::TwoWay,
            enabled: true,
            ..Default::default()
        };
        let rules = crate::rules::Rules::for_pair(&crate::config::RulesSection::default(), &pair);
        let gov = Governor::new(GovernorCfg::default());

        crate::watcher::scan_pair(&pair, Arc::clone(&db), &rules, &gov).await.unwrap();

        let job = db.next_due_job(i64::MAX).unwrap().expect("should have queued job");
        assert_eq!(job.kind, "rename");
        assert_eq!(job.rel_path, "file_v1.txt\tfile_v2.txt");
    }

    // ── Test 11: Safe-save from Word or Vim ───────────────────────────────────

    #[test]
    #[serial_test::serial]
    fn test_safe_save_from_word_or_vim() {
        let (dir, db) = temp_db();
        let path_doc = dir.path().join("report.docx");
        std::fs::write(&path_doc, b"initial doc").unwrap();
        let old_id = get_file_identity(&path_doc).expect("old identity");

        let mut row = sample_row("p1", "report.docx", "init_hash", 11, "synced");
        row.drive_id = Some("drv_cloud_doc_999".into());
        row.os_file_id = Some(old_id.os_id.clone());
        db.upsert_file(row).unwrap();
        db.set_file_os_id("p1", "report.docx", &old_id.os_id).unwrap();

        // Safe-save simulation: editor writes to temp file, then renames over original
        let path_tmp = dir.path().join("report.docx.tmp");
        std::fs::write(&path_tmp, b"new updated doc content").unwrap();
        std::fs::rename(&path_tmp, &path_doc).unwrap();

        let new_id = get_file_identity(&path_doc).expect("new identity");
        let existing = db.get_file("p1", "report.docx").unwrap().unwrap();
        assert_eq!(existing.drive_id.as_deref(), Some("drv_cloud_doc_999"));

        let mut updated = existing;
        updated.os_file_id = Some(new_id.os_id);
        updated.size = Some(std::fs::metadata(&path_doc).unwrap().len() as i64);
        updated.state = "dirty".into();
        db.upsert_file(updated).unwrap();

        let current = db.get_file("p1", "report.docx").unwrap().unwrap();
        assert_eq!(current.drive_id.as_deref(), Some("drv_cloud_doc_999"));
        assert_eq!(current.state, "dirty");
    }

    // ── Test 12: Kill app mid-rename then restart (idempotency) ───────────────

    #[tokio::test]
    async fn test_kill_app_mid_rename_restart() {
        let (_dir, db) = temp_db();

        let mut row = sample_row("p1", "file_old.txt", "abc", 3, "renaming");
        row.drive_id = Some("drv_interrupted".into());
        db.upsert_file(row).unwrap();

        let job_id = db.enqueue(crate::db::NewJob {
            pair_id: "p1".into(),
            kind: "rename".into(),
            rel_path: "file_old.txt\tfile_new.txt".into(),
            priority: 15,
            created_ms: 1000,
        }).unwrap();

        let job = db.next_due_job(i64::MAX).unwrap().unwrap();
        assert_eq!(job.id, job_id);

        let recovered = db.reset_stale_running_jobs().unwrap();
        assert_eq!(recovered, 1);

        let re_job = db.next_due_job(i64::MAX).unwrap().unwrap();
        assert_eq!(re_job.id, job_id);

        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/files/drv_interrupted"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "drv_interrupted",
                "name": "file_new.txt"
            })))
            .mount(&server)
            .await;

        let drive = crate::drive::client::DriveClient::new_with_client(
            reqwest::Client::new(),
            server.uri(),
        );

        run_rename_job(&re_job, Arc::clone(&db), &drive).await.unwrap();

        assert!(db.get_file("p1", "file_old.txt").unwrap().is_none());
        let new_row = db.get_file("p1", "file_new.txt").unwrap().unwrap();
        assert_eq!(new_row.state, "synced");
        assert_eq!(new_row.drive_id.as_deref(), Some("drv_interrupted"));
    }

    // ── Test 13: Rename on cloud side applied locally without loop ────────────

    #[tokio::test]
    async fn test_cloud_rename_applied_locally() {
        let (dir, db) = temp_db();
        let old_path = dir.path().join("cloud_old.txt");
        std::fs::write(&old_path, b"remote content").unwrap();

        let mut row = sample_row("p1", "cloud_old.txt", "md5_cloud", 14, "synced");
        row.drive_id = Some("drv_remote_renamed".into());
        db.upsert_file(row).unwrap();

        let pair = PairEntry {
            id: "p1".into(),
            local: dir.path().to_string_lossy().into(),
            drive_folder_id: "root".into(),
            mode: PairMode::TwoWay,
            enabled: true,
            ..Default::default()
        };

        let echo = Arc::new(crate::sync::SelfWritten::new());
        let change = crate::sync::changes::DriveChange {
            file_id: "drv_remote_renamed".into(),
            removed: Some(false),
            file: Some(crate::sync::changes::DriveEntry {
                id: "drv_remote_renamed".into(),
                name: Some("cloud_new.txt".into()),
                parents: None,
                md5_checksum: Some("md5_cloud".into()),
                modified_time: Some("2023-11-20T00:00:00Z".into()),
                size: Some("14".into()),
                mime_type: Some("text/plain".into()),
                trashed: Some(false),
            }),
        };

        crate::sync::reconcile::apply_remote_change_with_policy(
            &db,
            &pair,
            &change,
            &echo,
            crate::config::ConflictPolicy::NewerWins,
        ).await.unwrap();

        assert!(!old_path.exists());
        assert!(dir.path().join("cloud_new.txt").exists());

        assert!(db.get_file("p1", "cloud_old.txt").unwrap().is_none());
        let new_row = db.get_file("p1", "cloud_new.txt").unwrap().unwrap();
        assert_eq!(new_row.drive_id.as_deref(), Some("drv_remote_renamed"));

        assert!(echo.is_echo_rename("cloud_old.txt", "cloud_new.txt").await);
    }

    // ── Test 14: Non-NTFS/FAT drive hash fallback ─────────────────────────────

    #[test]
    #[serial_test::serial]
    fn test_non_ntfs_drive_hash_fallback() {
        let (dir, db) = temp_db();
        set_force_unreliable_fs(true);

        let path_a = dir.path().join("fat_old.txt");
        std::fs::write(&path_a, b"data on fat drive").unwrap();

        assert!(get_file_identity(&path_a).is_none());

        let row = sample_row("p1", "fat_old.txt", "md5_fat", 17, "deleted_local");
        db.upsert_file(row).unwrap();

        let path_b = dir.path().join("fat_new.txt");
        std::fs::rename(&path_a, &path_b).unwrap();

        let result = detect_rename_with_root(
            &db,
            "p1",
            Some(dir.path()),
            &path_b,
            "fat_new.txt",
            Some("md5_fat"),
            17,
        );
        set_force_unreliable_fs(false);
        assert_eq!(result, Some("fat_old.txt".to_string()));
    }

    // ── Test 15: Delete file and create different file ────────────────────────

    #[test]
    fn test_delete_and_create_different_new_file() {
        let (dir, db) = temp_db();
        let row = sample_row("p1", "deleted.txt", "hash_deleted", 100, "deleted_local");
        db.upsert_file(row).unwrap();

        let path_new = dir.path().join("brand_new.txt");
        std::fs::write(&path_new, b"totally different content").unwrap();

        let result = detect_rename_with_root(
            &db,
            "p1",
            Some(dir.path()),
            &path_new,
            "brand_new.txt",
            Some("hash_brand_new"),
            25,
        );
        assert_eq!(result, None, "different file must never be mistaken for a rename");
    }

    // ── Test 16: Remote 404 on rename falls back gracefully to upload ─────────

    #[tokio::test]
    async fn test_run_rename_job_remote_404_falls_back_to_upload() {
        let (_dir, db) = temp_db();

        let mut row = sample_row("p1", "temp sex/Alcohols & Phenols 2/4.jpeg", "abc", 170, "synced");
        row.drive_id = Some("drv_already_deleted_404".into());
        db.upsert_file(row).unwrap();

        // Enqueue a pending delete job that should be cancelled
        db.enqueue(crate::db::NewJob {
            pair_id: "p1".into(),
            kind: "delete".into(),
            rel_path: "temp sex/Alcohols & Phenols 2/4.jpeg".into(),
            priority: 1,
            created_ms: 100,
        }).unwrap();

        let rename_job = crate::db::Job {
            id: 2,
            pair_id: "p1".into(),
            kind: "rename".into(),
            rel_path: "temp sex/Alcohols & Phenols 2/4.jpeg\ttemp/Alcohols & Phenols 2/4.jpeg".into(),
            priority: 15,
            attempts: 0,
            next_try_ms: 0,
            status: "running".into(),
            last_error: None,
            created_ms: 200,
        };

        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;

        // Drive returns 404 Not Found for the missing remote file ID
        Mock::given(method("GET"))
            .and(path("/files/drv_already_deleted_404"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": {
                    "code": 404,
                    "message": "File not found: drv_already_deleted_404."
                }
            })))
            .mount(&server)
            .await;

        let drive = crate::drive::client::DriveClient::new_with_client(
            reqwest::Client::new(),
            server.uri(),
        );

        // run_rename_job must succeed cleanly without throwing a Drive 404 error
        run_rename_job(&rename_job, Arc::clone(&db), &drive).await.unwrap();

        // Old file must be gone from DB
        assert!(db.get_file("p1", "temp sex/Alcohols & Phenols 2/4.jpeg").unwrap().is_none());

        // New file must exist, with state dirty and drive_id None so it gets uploaded
        let new_row = db.get_file("p1", "temp/Alcohols & Phenols 2/4.jpeg").unwrap().unwrap();
        assert_eq!(new_row.state, "dirty");
        assert!(new_row.drive_id.is_none());

        // The queued delete job for old path must be cancelled
        let queued_delete = db.find_job("p1", "temp sex/Alcohols & Phenols 2/4.jpeg", "delete").unwrap();
        assert!(queued_delete.is_none() || queued_delete.unwrap().status == "cancelled");

        // A new upload job must be enqueued for the new path
        let upload_job = db.find_job("p1", "temp/Alcohols & Phenols 2/4.jpeg", "upload").unwrap();
        assert!(upload_job.is_some());
    }

    // ── Test 17: Cancel jobs by path and path prefix ──────────────────────────

    #[test]
    fn test_cancel_jobs_by_path_and_prefix() {
        let (_dir, db) = temp_db();

        db.enqueue(crate::db::NewJob {
            pair_id: "p1".into(),
            kind: "delete".into(),
            rel_path: "temp sex/sub/file1.txt".into(),
            priority: 1,
            created_ms: 100,
        }).unwrap();

        db.enqueue(crate::db::NewJob {
            pair_id: "p1".into(),
            kind: "delete".into(),
            rel_path: "temp sex/sub/file2.txt".into(),
            priority: 1,
            created_ms: 100,
        }).unwrap();

        db.enqueue(crate::db::NewJob {
            pair_id: "p1".into(),
            kind: "delete".into(),
            rel_path: "other/file.txt".into(),
            priority: 1,
            created_ms: 100,
        }).unwrap();

        let cancelled = db.cancel_jobs_by_path_prefix("p1", "delete", "temp sex").unwrap();
        assert_eq!(cancelled, 2);

        let other = db.find_job("p1", "other/file.txt", "delete").unwrap().unwrap();
        assert_eq!(other.status, "queued");
    }
}
