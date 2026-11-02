//! Google Drive AppData Folder Sync module.
//!
//! Stores and syncs Twin's configuration and device states directly inside
//! the user's hidden Google Drive `appDataFolder`.
//!
//! No GitHub account, tokens, or repositories needed by the user. Everything
//! stays securely and privately inside the consumer's own Google account.

use std::time::{Duration, SystemTime};
use tracing::{debug, info, warn};

use crate::auth;
use crate::config::{self, Config};
use crate::drive::DriveClient;
use crate::error::AppError;
use crate::governor::Governor;

const CONFIG_FILENAME: &str = "twin-config.toml";

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-device".into())
}

/// Push local configuration and device state to Google Drive's `appDataFolder`.
pub async fn push_to_appdata(drive: &DriveClient, cfg: &Config) -> Result<(), AppError> {
    if !auth::is_logged_in() {
        return Ok(());
    }

    // 1. Upload shared config
    let toml_str = toml::to_string_pretty(cfg)
        .map_err(|e| AppError::Config(format!("serialize config for appdata: {e}")))?;
    drive.upload_appdata(CONFIG_FILENAME, toml_str.as_bytes()).await?;

    // 2. Upload device-specific state (segregated by device name)
    let host = hostname();
    let device_filename = format!("device-{host}.json");
    let now = chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).to_rfc3339();
    let device_state = serde_json::json!({
        "device": host,
        "updated": now,
        "pairs": cfg.pairs.iter().map(|p| serde_json::json!({
            "id": p.id,
            "drive_folder_id": p.drive_folder_id,
            "mode": format!("{:?}", p.mode).to_lowercase(),
            "enabled": p.enabled,
        })).collect::<Vec<_>>()
    });

    let device_bytes = serde_json::to_vec_pretty(&device_state)
        .map_err(|e| AppError::Other(format!("serialize device state: {e}")))?;

    drive.upload_appdata(&device_filename, &device_bytes).await?;
    info!("AppData: Synced config and device state ({device_filename}) to Drive");
    Ok(())
}

/// Pull shared configuration from Google Drive's `appDataFolder` and merge locally.
pub async fn pull_from_appdata(drive: &DriveClient) -> Result<Option<Config>, AppError> {
    if !auth::is_logged_in() {
        return Ok(None);
    }

    let file_opt = drive.get_appdata_file(CONFIG_FILENAME).await?;
    let Some(file) = file_opt else {
        debug!("AppData: No remote config found in appDataFolder yet");
        return Ok(None);
    };

    let bytes = drive.download_appdata(&file.id).await?;
    let remote_str = String::from_utf8(bytes)
        .map_err(|e| AppError::Config(format!("utf8 decode appdata config: {e}")))?;

    let remote_cfg: Config = toml::from_str(&remote_str)
        .map_err(|e| AppError::Config(format!("parse appdata config: {e}")))?;

    // Save shared config locally
    config::save_shared(&remote_cfg)?;
    info!("AppData: Successfully pulled and applied remote config from Drive");
    Ok(Some(remote_cfg))
}

/// Background loop that periodically synchronizes configuration with Drive's `appDataFolder`.
pub async fn appdata_sync_loop(drive: DriveClient, gov: Governor, interval_mins: u64) {
    loop {
        tokio::time::sleep(Duration::from_secs(interval_mins.max(1) * 60)).await;
        gov.checkpoint().await;

        if auth::is_logged_in() {
            let cfg = config::load().unwrap_or_default();
            if let Err(e) = push_to_appdata(&drive, &cfg).await {
                warn!("AppData sync push error: {e}");
            }
        }
    }
}
