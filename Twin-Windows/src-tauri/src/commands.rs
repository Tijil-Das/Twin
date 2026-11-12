//! P12 – Tauri commands for autostart, Drive extras, etc.

use serde::{Deserialize, Serialize};
use tauri_plugin_autostart::ManagerExt;

use crate::drive::{DriveClient, DriveFile, SharedDrive, StorageQuota};

// ── Autostart ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enable {
        autolaunch.enable().map_err(|e| e.to_string())
    } else {
        autolaunch.disable().map_err(|e| e.to_string())
    }
}

// ── Drive Extras ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn drive_share_link(
    file_id: String,
    role: String,
    anyone: bool,
) -> Result<String, String> {
    let drive = DriveClient::new().map_err(|e| e.to_string())?;
    drive
        .share_link(&file_id, &role, anyone)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_storage_quota() -> Result<StorageQuota, String> {
    let drive = DriveClient::new().map_err(|e| e.to_string())?;
    drive.get_storage_quota().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_shared_drives() -> Result<Vec<SharedDrive>, String> {
    let drive = DriveClient::new().map_err(|e| e.to_string())?;
    drive.list_shared_drives().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_description(file_id: String, text: String) -> Result<(), String> {
    let drive = DriveClient::new().map_err(|e| e.to_string())?;
    drive
        .set_description(&file_id, &text)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_starred(file_id: String, starred: bool) -> Result<(), String> {
    let drive = DriveClient::new().map_err(|e| e.to_string())?;
    drive
        .set_starred(&file_id, starred)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn drive_search(
    query: String,
    mime: Option<String>,
    after: Option<String>,
) -> Result<Vec<DriveFile>, String> {
    let drive = DriveClient::new().map_err(|e| e.to_string())?;
    drive
        .search(&query, mime.as_deref(), after.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ── Selective Sync & Subfolders ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubfolderItem {
    pub name: String,
    pub rel_path: String,
    pub is_excluded: bool,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[tauri::command]
pub fn list_pair_subfolders(
    pair_id: String,
    db_state: tauri::State<'_, crate::db::DbState>,
) -> Result<Vec<SubfolderItem>, String> {
    let cfg = crate::config::load().map_err(|e| e.to_string())?;
    let pair = cfg.pairs.iter().find(|p| p.id == pair_id).ok_or_else(|| "Pair not found".to_string())?;
    let local_path = std::path::Path::new(&pair.local);
    if !local_path.exists() {
        return Ok(Vec::new());
    }

    let files = db_state.0.list_all_files(&pair_id).unwrap_or_default();

    let mut items = Vec::new();
    let entries = match std::fs::read_dir(local_path) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };

    for entry in entries.flatten() {
        if let Ok(file_type) = entry.file_type() {
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') && name != ".github" {
                    continue; // Skip hidden dirs
                }
                let rel = name.clone();
                let prefix = format!("{rel}/");
                let (count, bytes) = files
                    .iter()
                    .filter(|f| f.rel_path.starts_with(&prefix))
                    .fold((0usize, 0u64), |(c, b), f| {
                        (c + 1, b + (f.size.unwrap_or(0).max(0) as u64))
                    });
                let is_excluded = pair.excluded_folders.iter().any(|f| f == &rel)
                    || pair.exclude.iter().any(|p| p == &rel || p == &format!("{rel}/**") || p == &format!("{rel}/*"));

                items.push(SubfolderItem {
                    name,
                    rel_path: rel,
                    is_excluded,
                    file_count: count,
                    total_bytes: bytes,
                });
            }
        }
    }

    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(items)
}

// ── On-Demand Hash & Data Integrity Audit ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMismatch {
    pub rel_path: String,
    pub local_md5: String,
    pub drive_md5: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrityReport {
    pub pair_id: String,
    pub total_scanned: usize,
    pub matched: usize,
    pub mismatches: Vec<FileMismatch>,
    pub local_missing: Vec<String>,
    pub remote_missing: Vec<String>,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn verify_pair_integrity(
    pair_id: String,
    db_state: tauri::State<'_, crate::db::DbState>,
) -> Result<IntegrityReport, String> {
    let cfg = crate::config::load().map_err(|e| e.to_string())?;
    let pair = cfg.pairs.iter().find(|p| p.id == pair_id).ok_or_else(|| "Pair not found".to_string())?.clone();
    let local_root = std::path::PathBuf::from(&pair.local);
    let files = db_state.0.list_all_files(&pair_id).map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();
    let mut matched = 0;
    let mut mismatches = Vec::new();
    let mut local_missing = Vec::new();
    let mut remote_missing = Vec::new();
    let mut scanned = 0;

    for file in files {
        if matches!(file.state.as_str(), "deleted" | "trashed" | "deleted_local" | "deleted_remote") {
            continue;
        }
        scanned += 1;
        let local_path = crate::transfer::resolve_under_root(&local_root, &file.rel_path)
            .map_err(|e| e.to_string())?;
        if local_path.is_file() {
            match crate::transfer::upload::compute_md5_blocking(&local_path).await {
                Ok(local_hash) => {
                    if let Some(ref drive_hash) = file.drive_md5 {
                        if local_hash.eq_ignore_ascii_case(drive_hash) {
                            matched += 1;
                        } else {
                            mismatches.push(FileMismatch {
                                rel_path: file.rel_path,
                                local_md5: local_hash,
                                drive_md5: drive_hash.clone(),
                                size_bytes: file.size.unwrap_or(0).max(0) as u64,
                            });
                        }
                    } else {
                        remote_missing.push(file.rel_path);
                    }
                }
                Err(_) => {
                    local_missing.push(file.rel_path);
                }
            }
        } else if file.drive_id.is_some() {
            local_missing.push(file.rel_path);
        }
    }

    Ok(IntegrityReport {
        pair_id,
        total_scanned: scanned,
        matched,
        mismatches,
        local_missing,
        remote_missing,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub fn repair_pair_mismatches(
    pair_id: String,
    paths: Vec<String>,
    db_state: tauri::State<'_, crate::db::DbState>,
    queue_state: tauri::State<'_, crate::queue::QueueState>,
) -> Result<usize, String> {
    let mut repaired = 0;
    for rel in paths {
        if let Some(mut row) = db_state.0.get_file(&pair_id, &rel).map_err(|e| e.to_string())? {
            row.state = "dirty".to_string();
            row.drive_md5 = None;
            db_state.0.upsert_file(row).map_err(|e| e.to_string())?;
            repaired += 1;
        }
    }
    queue_state.0.wake();
    Ok(repaired)
}

// ── File Explorer Icon Overlays ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayStatus {
    pub enabled: bool,
    pub placement: String,
    pub is_registered: bool,
}

#[tauri::command]
pub fn get_overlay_status() -> Result<OverlayStatus, String> {
    let cfg = crate::config::load().map_err(|e| e.to_string())?;
    let is_registered = crate::overlay::is_overlay_registered();
    Ok(OverlayStatus {
        enabled: cfg.overlay.enabled,
        placement: cfg.overlay.placement,
        is_registered,
    })
}

#[tauri::command]
pub fn set_overlay_settings(
    enabled: bool,
    placement: String,
    _db_state: tauri::State<'_, crate::db::DbState>,
) -> Result<(), String> {
    let mut cfg = crate::config::load().map_err(|e| e.to_string())?;
    cfg.overlay.enabled = enabled;
    cfg.overlay.placement = placement;
    cfg.validate().map_err(|e| e.to_string())?;
    crate::config::save_shared(&cfg).map_err(|e| e.to_string())?;

    let _ = crate::overlay::sync_registry_settings(&cfg.overlay);

    // Refresh Explorer to pick up new overlay settings (enabled/placement).
    // The live tray-loop supervisor (main.rs) keeps shared-memory sync status
    // up to date using the same 7 signals as the system tray icon; we must NOT
    // overwrite it here with a hardcoded false, which would force the badge to
    // stay green even while a transfer is in flight.
    crate::overlay::refresh_all_folder_overlays(&cfg.pairs);

    Ok(())
}

#[tauri::command]
pub fn register_overlay_extension() -> Result<(), String> {
    crate::overlay::register_overlay_handler()
}

#[tauri::command]
pub fn unregister_overlay_extension() -> Result<(), String> {
    crate::overlay::unregister_overlay_handler()
}

#[tauri::command]
pub fn restart_explorer_shell() -> Result<(), String> {
    crate::overlay::restart_explorer()
}

#[tauri::command]
pub fn cancel_pair_jobs(
    db_state: tauri::State<'_, crate::db::DbState>,
    pair_id: String,
    kind: Option<String>,
) -> Result<usize, String> {
    db_state
        .0
        .cancel_jobs_by_kind(&pair_id, kind.as_deref())
        .map_err(|e| e.to_string())
}
