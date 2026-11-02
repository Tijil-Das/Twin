//! P12 – Tauri commands for autostart, Drive extras, etc.

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
