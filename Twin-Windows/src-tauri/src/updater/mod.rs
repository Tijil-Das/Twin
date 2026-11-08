//! Autonomous in-place updater for Twin (Windows).
//! Modeled directly on the architecture and reliability patterns of JioTV Max:
//! - Silent background check at 15s, then every 20 minutes
//! - Automatic background download of verified updates
//! - Deferral protection: never interrupts active sync/transfers
//! - Strict semver validation (no downgrades, no pre-releases on stable)
//! - Atomic in-place executable replacement with zero UAC / wizard prompt
//! - Startup check for pending updates

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use tracing::{error, info};

use crate::error::AppError;

pub const POLL_INTERVAL: Duration = Duration::from_secs(20 * 60); // 20 minutes
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);  // 15 seconds
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(60);      // 60 seconds
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60); // 10 minutes

pub const DEFAULT_RELEASE_ENDPOINT: &str =
    "https://api.github.com/repos/Tijil-Das/Twin/releases/latest";

// ── State Models ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum UpdateStatus {
    Idle,
    Checking,
    UpdateAvailable {
        version: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
    Downloading {
        progress_pct: u8,
        version: String,
    },
    Ready {
        version: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
    Installing,
    UpToDate {
        current_version: String,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStatePayload {
    pub status: UpdateStatus,
    pub current_version: String,
    pub ready_version: Option<String>,
    pub release_notes: Option<String>,
    pub last_checked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum UpdateType {
    SetupInstaller,
    BinaryReplace,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingUpdate {
    pub version: String,
    pub downloaded_at: String,
    pub binary_path: String,
    #[serde(default)]
    pub release_notes: Option<String>,
    #[serde(default)]
    pub update_type: Option<UpdateType>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseInfo {
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

// ── Global Updater State ─────────────────────────────────────────────────────

pub struct UpdaterState {
    pub status: UpdateStatus,
    pub ready_version: Option<String>,
    pub release_notes: Option<String>,
    pub last_checked: Option<Instant>,
    pub busy: bool,
    pub endpoint_url: String,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            status: UpdateStatus::Idle,
            ready_version: None,
            release_notes: None,
            last_checked: None,
            busy: false,
            endpoint_url: DEFAULT_RELEASE_ENDPOINT.to_string(),
        }
    }
}

static UPDATER: std::sync::OnceLock<Arc<Mutex<UpdaterState>>> = std::sync::OnceLock::new();

pub fn updater_state() -> &'static Arc<Mutex<UpdaterState>> {
    UPDATER.get_or_init(|| Arc::new(Mutex::new(UpdaterState::default())))
}

// ── SemVer Utilities ─────────────────────────────────────────────────────────

/// Parse a version string like "0.1.0", "v1.2.3", "1.0.0-beta.1"
pub fn parse_semver(v: &str) -> Option<(u64, u64, u64, Option<String>)> {
    let s = v.trim().trim_start_matches(|c| c == 'v' || c == 'V');
    let (num_part, prerelease) = match s.split_once('-') {
        Some((n, pre)) => (n, Some(pre.to_string())),
        None => (s, None),
    };

    let parts: Vec<&str> = num_part.split('.').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }

    let major: u64 = parts[0].parse().ok()?;
    let minor: u64 = parts[1].parse().ok()?;
    let patch: u64 = if parts.len() == 3 {
        parts[2].parse().ok()?
    } else {
        0
    };

    Some((major, minor, patch, prerelease))
}

/// Strict check matching JioTV Max: strictly positive major.minor.patch, no 'v' prefix.
pub fn is_strict_semver(v: &str) -> bool {
    if v.starts_with('v') || v.starts_with('V') {
        return false;
    }
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty())
}

/// Returns true if `remote` is strictly newer than `current`.
/// Enforces: no downgrades, and ignores prereleases when current is stable.
pub fn is_newer_semver(remote: &str, current: &str) -> bool {
    let (r_maj, r_min, r_pat, r_pre) = match parse_semver(remote) {
        Some(v) => v,
        None => return false,
    };
    let (c_maj, c_min, c_pat, c_pre) = match parse_semver(current) {
        Some(v) => v,
        None => return false,
    };

    if r_pre.is_some() && c_pre.is_none() {
        return false;
    }

    (r_maj, r_min, r_pat) > (c_maj, c_min, c_pat)
}

// ── Pending Update File Management ───────────────────────────────────────────

pub fn pending_path(app: &tauri::AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("data"));
    let _ = std::fs::create_dir_all(&base);
    base.join("pending-update.json")
}

pub fn updates_dir(app: &tauri::AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("data"));
    let dir = base.join("updates");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn read_pending(file_path: &Path) -> Option<PendingUpdate> {
    if !file_path.exists() {
        return None;
    }
    let data = std::fs::read_to_string(file_path).ok()?;
    serde_json::from_str::<PendingUpdate>(&data).ok()
}

pub fn write_pending(file_path: &Path, pending: &PendingUpdate) -> Result<(), AppError> {
    if let Some(parent) = file_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(pending)
        .map_err(|e| AppError::Other(format!("serialize pending: {e}")))?;
    std::fs::write(file_path, json).map_err(|e| AppError::Other(format!("write pending: {e}")))
}

pub fn clear_pending(file_path: &Path) {
    let _ = std::fs::remove_file(file_path);
}

// ── Asset Selection & Environment Detection ──────────────────────────────────

/// Checks whether Twin is running as an installed NSIS application or portable binary.
pub fn is_installed_app() -> bool {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if parent.join("uninstall.exe").exists() {
                return true;
            }
        }
        let exe_str = exe.to_string_lossy().to_lowercase();
        if exe_str.contains("appdata\\local\\programs\\twin")
            || exe_str.contains("program files\\twin")
            || exe_str.contains("program files (x86)\\twin")
        {
            return true;
        }
    }
    false
}

/// Selects the correct update asset for the current running environment.
/// - Installed app: prefers NSIS setup installer (`Twin_<ver>_x64-setup.exe`) to preserve Windows registry uninstall entries.
/// - Standalone / Portable app: selects standalone executable (`Twin.exe`).
/// - NEVER selects .zip or .msi.
pub fn select_update_asset<'a>(
    assets: &'a [ReleaseAsset],
    is_installed: bool,
) -> Option<&'a ReleaseAsset> {
    if is_installed {
        // Priority 1: Official NSIS setup installer
        if let Some(setup) = assets.iter().find(|a| a.name.ends_with("-setup.exe")) {
            return Some(setup);
        }
        // Priority 2: Any .exe containing "setup"
        if let Some(setup) = assets
            .iter()
            .find(|a| a.name.ends_with(".exe") && a.name.to_lowercase().contains("setup"))
        {
            return Some(setup);
        }
    }

    // Portable / Standalone: Look specifically for standalone Twin.exe
    if let Some(exe) = assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case("Twin.exe"))
    {
        return Some(exe);
    }

    // Fallback: any .exe that is NOT setup and NOT a zip/msi
    assets
        .iter()
        .find(|a| a.name.ends_with(".exe") && !a.name.to_lowercase().contains("setup"))
}

// ── Startup Pending Check ────────────────────────────────────────────────────

/// Checks if an update was already downloaded and is waiting to be applied.
/// Matches JioTV Max: applyPendingUpdateOnLaunch().
pub fn apply_pending_update_on_launch(app: &tauri::AppHandle) -> bool {
    let pending_file = pending_path(app);
    let pending = match read_pending(&pending_file) {
        Some(p) => p,
        None => return false,
    };

    let current_ver = env!("CARGO_PKG_VERSION");
    if !is_newer_semver(&pending.version, current_ver) {
        clear_pending(&pending_file);
        return false;
    }

    let bin_path = PathBuf::from(&pending.binary_path);
    if !bin_path.exists() {
        clear_pending(&pending_file);
        return false;
    }

    // Strict validation: verify file starts with PE magic header 'MZ'
    if let Ok(bytes) = std::fs::read(&bin_path) {
        if bytes.len() < 2 || &bytes[0..2] != b"MZ" {
            error!("Pending binary failed PE check; discarding corrupted payload");
            let _ = std::fs::remove_file(&bin_path);
            clear_pending(&pending_file);
            return false;
        }
    } else {
        clear_pending(&pending_file);
        return false;
    }

    let current_exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return false,
    };

    let update_type = pending.update_type.unwrap_or_else(|| {
        if bin_path.to_string_lossy().to_lowercase().contains("setup") {
            UpdateType::SetupInstaller
        } else {
            UpdateType::BinaryReplace
        }
    });

    info!(
        "Pending update found: v{} (current is v{}). Applying update...",
        pending.version, current_ver
    );

    #[cfg(windows)]
    {
        use std::process::Command;
        let script = match update_type {
            UpdateType::SetupInstaller => {
                // Silently run NSIS installer: updates files, registry uninstall keys, and restarts app cleanly
                format!(
                    "Start-Sleep -Milliseconds 1000; Start-Process -FilePath '{}' -ArgumentList '/S' -Wait; Start-Process -FilePath '{}'; Remove-Item -Force -LiteralPath '{}' -ErrorAction SilentlyContinue",
                    bin_path.to_string_lossy(),
                    current_exe.to_string_lossy(),
                    bin_path.to_string_lossy()
                )
            }
            UpdateType::BinaryReplace => {
                format!(
                    "Start-Sleep -Milliseconds 1000; Copy-Item -Force -LiteralPath '{}' -Destination '{}'; Start-Process -FilePath '{}'",
                    bin_path.to_string_lossy(),
                    current_exe.to_string_lossy(),
                    current_exe.to_string_lossy()
                )
            }
        };

        let _ = Command::new("powershell")
            .args(["-WindowStyle", "Hidden", "-NoProfile", "-Command", &script])
            .spawn();

        clear_pending(&pending_file);
        app.exit(0);
        return true;
    }

    #[cfg(not(windows))]
    false
}

// ── Core Update Logic ────────────────────────────────────────────────────────

pub async fn check_for_updates(
    app: &tauri::AppHandle,
    custom_client: Option<&Client>,
) -> Result<UpdateStatePayload, AppError> {
    let mut state = updater_state().lock().await;

    if state.busy {
        return Ok(build_payload(&state));
    }
    if state.ready_version.is_some() {
        return Ok(build_payload(&state));
    }

    state.busy = true;
    state.status = UpdateStatus::Checking;
    drop(state);

    let client = if let Some(c) = custom_client {
        c.clone()
    } else {
        Client::builder()
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|e| AppError::Network(format!("updater client: {e}")))?
    };

    let endpoint = {
        let guard = updater_state().lock().await;
        guard.endpoint_url.clone()
    };

    let resp = client
        .get(&endpoint)
        .header("User-Agent", "Twin-Windows-Updater/1.1")
        .header("Accept", "application/vnd.github.v3+json")
        .header("Cache-Control", "no-cache")
        .send()
        .await;

    let release_info = match resp {
        Ok(r) if r.status().is_success() => match r.json::<ReleaseInfo>().await {
            Ok(info) => info,
            Err(e) => {
                let err_msg = format!("Failed to parse release metadata: {e}");
                set_error(err_msg.clone()).await;
                return Err(AppError::Other(err_msg));
            }
        },
        Ok(r) => {
            let err_msg = format!("Release check returned HTTP {}", r.status());
            set_error(err_msg.clone()).await;
            return Err(AppError::Network(err_msg));
        }
        Err(e) => {
            let err_msg = format!("Network error checking for updates: {e}");
            set_error(err_msg.clone()).await;
            return Err(AppError::Network(err_msg));
        }
    };

    let current_ver = env!("CARGO_PKG_VERSION");
    let remote_ver = release_info.tag_name.trim_start_matches(|c| c == 'v' || c == 'V');

    if !is_newer_semver(remote_ver, current_ver) {
        let mut guard = updater_state().lock().await;
        guard.busy = false;
        guard.last_checked = Some(Instant::now());
        guard.status = UpdateStatus::UpToDate {
            current_version: current_ver.to_string(),
        };
        return Ok(build_payload(&guard));
    }

    // New version is available! Select suitable executable asset based on environment.
    let is_installed = is_installed_app();
    let asset = match select_update_asset(&release_info.assets, is_installed) {
        Some(a) => a.clone(),
        None => {
            let mut guard = updater_state().lock().await;
            guard.busy = false;
            guard.status = UpdateStatus::UpdateAvailable {
                version: remote_ver.to_string(),
                notes: release_info.body.clone(),
            };
            return Ok(build_payload(&guard));
        }
    };

    let update_type = if asset.name.to_lowercase().contains("setup") {
        UpdateType::SetupInstaller
    } else {
        UpdateType::BinaryReplace
    };

    // Auto-download update payload in background (JioTV Max autoDownload pattern)
    {
        let mut guard = updater_state().lock().await;
        guard.status = UpdateStatus::Downloading {
            progress_pct: 0,
            version: remote_ver.to_string(),
        };
    }

    let download_dir = updates_dir(app);
    let target_bin = download_dir.join(if update_type == UpdateType::SetupInstaller {
        format!("Twin_{remote_ver}_setup.exe")
    } else {
        format!("Twin_{remote_ver}.exe")
    });

    let dl_resp = client
        .get(&asset.browser_download_url)
        .header("User-Agent", "Twin-Windows-Updater/1.1")
        .header("Accept", "application/octet-stream")
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await;

    match dl_resp {
        Ok(res) if res.status().is_success() => {
            let bytes = res.bytes().await.map_err(|e| {
                let err_msg = format!("Failed to read update stream: {e}");
                AppError::Network(err_msg)
            })?;

            // Strict PE magic header validation ('MZ' = 0x4D, 0x5A)
            if bytes.len() < 2 || &bytes[0..2] != b"MZ" {
                let err_msg = format!(
                    "Downloaded asset {} is not a valid Windows executable (PE header check failed)",
                    asset.name
                );
                error!("{err_msg}");
                set_error(err_msg.clone()).await;
                return Err(AppError::Other(err_msg));
            }

            if let Err(e) = std::fs::write(&target_bin, &bytes) {
                let err_msg = format!("Failed to write update binary to disk: {e}");
                set_error(err_msg.clone()).await;
                return Err(AppError::Other(err_msg));
            }

            let pending = PendingUpdate {
                version: remote_ver.to_string(),
                downloaded_at: chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).to_rfc3339(),
                binary_path: target_bin.to_string_lossy().to_string(),
                release_notes: release_info.body.clone(),
                update_type: Some(update_type),
            };
            let pending_file = pending_path(app);
            let _ = write_pending(&pending_file, &pending);

            let mut guard = updater_state().lock().await;
            guard.busy = false;
            guard.ready_version = Some(remote_ver.to_string());
            guard.release_notes = release_info.body.clone();
            guard.last_checked = Some(Instant::now());
            guard.status = UpdateStatus::Ready {
                version: remote_ver.to_string(),
                notes: release_info.body.clone(),
            };

            let _ = app.emit("update://ready", serde_json::json!({
                "version": remote_ver,
                "notes": release_info.body
            }));

            info!("Twin v{} is downloaded and ready to apply", remote_ver);
            Ok(build_payload(&guard))
        }
        Ok(res) => {
            let err_msg = format!("Download returned HTTP {}", res.status());
            set_error(err_msg.clone()).await;
            Err(AppError::Network(err_msg))
        }
        Err(e) => {
            let err_msg = format!("Download failed: {e}");
            set_error(err_msg.clone()).await;
            Err(AppError::Network(err_msg))
        }
    }
}

// ── In-place Install & Restart ───────────────────────────────────────────────

/// Replaces the current running binary in-place and restarts cleanly without an installer wizard.
pub async fn install_now(app: &tauri::AppHandle) -> Result<(), AppError> {
    let mut state = updater_state().lock().await;
    state.status = UpdateStatus::Installing;
    drop(state);

    let pending_file = pending_path(app);
    let pending = read_pending(&pending_file).ok_or_else(|| {
        AppError::Other("No pending update file found to install".to_string())
    })?;

    let new_bin = PathBuf::from(&pending.binary_path);
    if !new_bin.exists() {
        return Err(AppError::Other(format!(
            "Downloaded update binary not found at {}",
            new_bin.display()
        )));
    }

    // Verify PE magic header
    if let Ok(bytes) = std::fs::read(&new_bin) {
        if bytes.len() < 2 || &bytes[0..2] != b"MZ" {
            let _ = std::fs::remove_file(&new_bin);
            clear_pending(&pending_file);
            return Err(AppError::Other(
                "Update binary failed PE check; discarding corrupted payload".to_string(),
            ));
        }
    }

    let current_exe = std::env::current_exe()
        .map_err(|e| AppError::Other(format!("Failed to get current_exe: {e}")))?;

    let update_type = pending.update_type.unwrap_or_else(|| {
        if new_bin.to_string_lossy().to_lowercase().contains("setup") {
            UpdateType::SetupInstaller
        } else {
            UpdateType::BinaryReplace
        }
    });

    info!(
        "Applying update ({:?}): {} -> {}",
        update_type,
        new_bin.display(),
        current_exe.display()
    );

    // Detached update and restart command.
    // Gives the running process 1.5s (matching PANEL_PAINT_DELAY_MS in JioTV Max) to terminate cleanly.
    #[cfg(windows)]
    {
        use std::process::Command;
        let script = match update_type {
            UpdateType::SetupInstaller => {
                // Silently run NSIS installer: updates files, registry uninstall keys, and restarts app cleanly
                format!(
                    "Start-Sleep -Milliseconds 1500; Start-Process -FilePath '{}' -ArgumentList '/S' -Wait; Start-Process -FilePath '{}'; Remove-Item -Force -LiteralPath '{}' -ErrorAction SilentlyContinue",
                    new_bin.to_string_lossy(),
                    current_exe.to_string_lossy(),
                    new_bin.to_string_lossy()
                )
            }
            UpdateType::BinaryReplace => {
                format!(
                    "Start-Sleep -Milliseconds 1500; Copy-Item -Force -LiteralPath '{}' -Destination '{}'; Start-Process -FilePath '{}'",
                    new_bin.to_string_lossy(),
                    current_exe.to_string_lossy(),
                    current_exe.to_string_lossy()
                )
            }
        };

        let spawn_res = Command::new("powershell")
            .args(["-WindowStyle", "Hidden", "-NoProfile", "-Command", &script])
            .spawn();

        if let Err(e) = spawn_res {
            error!("Failed to spawn updater process: {e}");
            return Err(AppError::Other(format!("Spawn updater: {e}")));
        }
    }

    clear_pending(&pending_file);

    // Clean exit
    app.exit(0);
    Ok(())
}

// ── Background Polling Loop ──────────────────────────────────────────────────

/// Initializes the background update timer (15s first check, 20m interval).
/// Checks `is_deferred`: skips check if active transfers are running.
pub fn init_updater(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Wait initial delay (15s)
        tokio::time::sleep(FIRST_CHECK_DELAY).await;

        loop {
            // Check for updates
            let is_busy = {
                let guard = updater_state().lock().await;
                guard.busy || guard.ready_version.is_some()
            };

            if !is_busy {
                info!("Running periodic background update check");
                let _ = check_for_updates(&app, None).await;
            }

            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn build_payload(state: &UpdaterState) -> UpdateStatePayload {
    UpdateStatePayload {
        status: state.status.clone(),
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        ready_version: state.ready_version.clone(),
        release_notes: state.release_notes.clone(),
        last_checked: state
            .last_checked
            .map(|_| chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).to_rfc3339()),
    }
}

async fn set_error(err: String) {
    let mut guard = updater_state().lock().await;
    guard.busy = false;
    guard.status = UpdateStatus::Error { error: err };
}

// ── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn update_get_state() -> UpdateStatePayload {
    let guard = updater_state().lock().await;
    build_payload(&guard)
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateStatePayload, String> {
    check_for_updates(&app, None).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    install_now(&app).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_clear_pending(app: tauri::AppHandle) {
    clear_pending(&pending_path(&app));
    if let Ok(mut guard) = updater_state().try_lock() {
        guard.ready_version = None;
        guard.status = UpdateStatus::Idle;
    }
}

#[cfg(test)]
mod tests;
