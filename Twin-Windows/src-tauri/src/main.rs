// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;
use tracing::{info, warn};
use twin_lib::{auth, commands, config, db, drive, github, governor, queue, rules, sync, transfer, updater, watcher, setup_tray};
use twin_lib::drive::revisions::Revision;
use twin_lib::drive::client::DriveFile;
use twin_lib::drive::trash::TrashedFile;

// ── Rotating logger for data/twin.log (Item 11) ─────────────────────────────

struct RotatingLogger {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    max_bytes: u64,
}

impl RotatingLogger {
    fn new(path: PathBuf, max_bytes: u64) -> Self {
        if let Some(p) = path.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Self {
            path,
            file,
            size,
            max_bytes,
        }
    }

    fn rotate_if_needed(&mut self, incoming_len: u64) {
        if self.size + incoming_len > self.max_bytes {
            self.file = None;
            let backup = self.path.with_extension("log.1");
            let _ = std::fs::remove_file(&backup);
            let _ = std::fs::rename(&self.path, &backup);
            self.file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&self.path)
                .ok();
            self.size = 0;
        }
    }
}

impl Write for RotatingLogger {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.rotate_if_needed(buf.len() as u64);
        if let Some(ref mut f) = self.file {
            let written = f.write(buf)?;
            self.size += written as u64;
            Ok(written)
        } else {
            Ok(buf.len())
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(ref mut f) = self.file {
            f.flush()
        } else {
            Ok(())
        }
    }
}

#[derive(Clone)]
struct CombinedWriter {
    file_logger: Arc<Mutex<RotatingLogger>>,
}

impl Write for CombinedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stdout().write_all(buf);
        if let Ok(mut l) = self.file_logger.lock() {
            let _ = l.write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stdout().flush();
        if let Ok(mut l) = self.file_logger.lock() {
            let _ = l.flush();
        }
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CombinedWriter {
    type Writer = CombinedWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[cfg(windows)]
fn set_below_normal_priority() {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS,
    };
    unsafe {
        let handle: HANDLE = GetCurrentProcess();
        SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS);
    }
}

#[cfg(not(windows))]
fn set_below_normal_priority() {
    // No-op on non-Windows platforms.
}

// P08 Commands

/// List files in a Drive folder (non-recursive).
#[tauri::command]
async fn drive_list(folder_id: String) -> Result<Vec<DriveFile>, String> {
    tracing::info!("Listing Drive folder: {folder_id}");
    let drive = drive::DriveClient::new().map_err(|e| {
        tracing::error!("DriveClient::new failed: {e}");
        e.to_string()
    })?;
    drive.list_folder(&folder_id).await.map_err(|e| {
        tracing::error!("drive.list_folder({folder_id}) failed: {e}");
        e.to_string()
    })
}

/// List immediate subfolders of a specific parent folder.
#[tauri::command]
async fn drive_list_subfolders(parent_id: String) -> Result<Vec<DriveFile>, String> {
    tracing::info!("Listing subfolders for parent: {parent_id}");
    let drive = drive::DriveClient::new().map_err(|e| {
        tracing::error!("DriveClient::new failed: {e}");
        e.to_string()
    })?;
    drive.list_subfolders(&parent_id).await.map_err(|e| {
        tracing::error!("drive.list_subfolders('{parent_id}') failed: {e}");
        e.to_string()
    })
}

/// Get folder metadata by ID.
#[tauri::command]
async fn drive_get_folder_meta(folder_id: String) -> Result<DriveFile, String> {
    let drive = drive::DriveClient::new().map_err(|e| e.to_string())?;
    drive.get_folder_meta(&folder_id).await.map_err(|e| e.to_string())
}

/// List all folders across Google Drive (My Drive).
#[tauri::command]
async fn drive_get_folders() -> Result<Vec<DriveFile>, String> {
    tracing::info!("Retrieving all Drive folders");
    let drive = drive::DriveClient::new().map_err(|e| {
        tracing::error!("DriveClient::new failed: {e}");
        e.to_string()
    })?;
    drive.get_all_folders().await.map_err(|e| {
        tracing::error!("drive.get_all_folders() failed: {e}");
        e.to_string()
    })
}

/// List shared folders in Google Drive (sharedWithMe = true).
#[tauri::command]
async fn drive_get_shared_folders() -> Result<Vec<DriveFile>, String> {
    tracing::info!("Retrieving shared Drive folders");
    let drive = drive::DriveClient::new().map_err(|e| {
        tracing::error!("DriveClient::new failed: {e}");
        e.to_string()
    })?;
    drive.get_shared_with_me_folders().await.map_err(|e| {
        tracing::error!("drive.get_shared_with_me_folders() failed: {e}");
        e.to_string()
    })
}

/// Create a new folder in Google Drive.
#[tauri::command]
async fn drive_create_folder(parent_id: String, name: String) -> Result<String, String> {
    tracing::info!("Creating Drive folder '{name}' inside '{parent_id}'");
    let drive = drive::DriveClient::new().map_err(|e| {
        tracing::error!("DriveClient::new failed: {e}");
        e.to_string()
    })?;
    drive.create_folder(&parent_id, &name).await.map_err(|e| {
        tracing::error!("drive.create_folder('{parent_id}', '{name}') failed: {e}");
        e.to_string()
    })
}

/// Open a native folder browser dialog.
#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            let output = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Local Folder to Sync'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
                ])
                .output();
            match output {
                Ok(o) => {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() {
                        Ok(None)
                    } else {
                        Ok(Some(s))
                    }
                }
                Err(e) => Err(e.to_string()),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List revisions for a Drive file.
#[tauri::command]
async fn list_revisions(file_id: String) -> Result<Vec<Revision>, String> {
    let drive = drive::DriveClient::new().map_err(|e| e.to_string())?;
    drive.list_revisions(&file_id).await.map_err(|e| e.to_string())
}

/// Restore a Drive file to local disk (optionally at a specific revision).
#[tauri::command]
async fn restore_file_cmd(
    file_id: String,
    rev_id:  Option<String>,
    dest:    String,
    gov_s:   tauri::State<'_, governor::GovState2>,
) -> Result<(), String> {
    let drive   = drive::DriveClient::new().map_err(|e| e.to_string())?;
    let gov     = gov_s.0.clone();
    let cfg     = config::load().unwrap_or_default();
    let limiter = Arc::new(transfer::Limiter::new(cfg.limits.download_kbps));
    let dest_pb = std::path::PathBuf::from(dest);

    transfer::download::restore_file(
        &drive, &gov, &limiter,
        &file_id, rev_id.as_deref(), dest_pb,
    ).await.map_err(|e| e.to_string())
}

/// Restore all files from a Drive folder (enqueues one download job per file).
#[tauri::command]
async fn restore_folder_cmd(
    folder_id: String,
    dest:      String,
    pair_id:   String,
    gov_s:     tauri::State<'_, governor::GovState2>,
) -> Result<(), String> {
    let drive   = drive::DriveClient::new().map_err(|e| e.to_string())?;
    let cfg     = config::load().unwrap_or_default();
    let dest_pb = std::path::PathBuf::from(&dest);
    let gov     = gov_s.0.clone();
    let limiter = Arc::new(transfer::Limiter::new(cfg.limits.download_kbps));
    let _ = pair_id; // retained in the IPC signature for compatibility

    transfer::download::restore_folder(
        &drive, &gov, &limiter, &folder_id, dest_pb,
    ).await.map_err(|e| e.to_string())
}

/// List trashed files (optionally filtered by parent folder).
#[tauri::command]
async fn list_trash(parent_id: Option<String>) -> Result<Vec<TrashedFile>, String> {
    let drive = drive::DriveClient::new().map_err(|e| e.to_string())?;
    drive.list_trashed(parent_id.as_deref()).await.map_err(|e| e.to_string())
}

/// Untrash (restore from trash) a file by id.
#[tauri::command]
async fn untrash(file_id: String) -> Result<(), String> {
    let drive = drive::DriveClient::new().map_err(|e| e.to_string())?;
    drive.untrash(&file_id).await.map_err(|e| e.to_string())
}

/// Untrash (restore) all files in Google Drive trash.
#[tauri::command]
async fn untrash_all() -> Result<usize, String> {
    let drive = drive::DriveClient::new().map_err(|e| e.to_string())?;
    let trashed = drive.list_trashed(None).await.map_err(|e| e.to_string())?;
    let mut count = 0;
    for file in trashed {
        if drive.untrash(&file.id).await.is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

/// Set keepForever on a revision.
#[tauri::command]
async fn keep_revision(file_id: String, rev_id: String, keep: bool) -> Result<(), String> {
    let drive = drive::DriveClient::new().map_err(|e| e.to_string())?;
    drive.set_keep_forever(&file_id, &rev_id, keep)
        .await
        .map_err(|e| e.to_string())
}

// P09 Commands

/// Manually trigger one sync cycle for a pair.
#[tauri::command]
async fn run_sync_cycle(
    app:      tauri::AppHandle,
    pair_id:  String,
    gov_s:    tauri::State<'_, governor::GovState2>,
    db_s:     tauri::State<'_, db::DbState>,
    q_s:      tauri::State<'_, queue::QueueState>,
) -> Result<sync::CycleReport, String> {
    let cfg = config::load().unwrap_or_default();
    let pair = cfg.pairs.iter()
        .find(|p| p.id == pair_id)
        .ok_or_else(|| format!("pair {pair_id} not found"))?
        .clone();

    let db_path = db_s.db_path();
    let db_arc  = Arc::new(db::Db::open(&db_path).map_err(|e| e.to_string())?);
    let drive   = drive::DriveClient::new().map_err(|e| e.to_string())?;
    let gov     = gov_s.0.clone();
    let echo    = Arc::new(sync::SelfWritten::new());

    // 1. Scan local filesystem for new/modified/deleted files
    let rules = rules::Rules::new(&cfg.rules.include, &cfg.rules.exclude, cfg.rules.max_file_mb);
    let _ = watcher::scan_pair(&pair, Arc::clone(&db_arc), &rules, &gov).await;

    // 2. Scan remote Drive changes and reconcile
    let ctx = sync::Ctx {
        db: db_arc,
        drive,
        gov,
        echo,
        policy: cfg.policy.clone(),
        app: Some(app),
    };
    let report = sync::run_pair_cycle(&pair, &ctx).await.map_err(|e| e.to_string())?;

    // 3. Wake queue worker to execute transfers immediately
    q_s.0.wake();

    Ok(report)
}

/// Resolve a pending conflict.
#[tauri::command]
fn resolve_conflict(
    pair_id:  String,
    rel_path: String,
    choice:   String,
    db_s:     tauri::State<'_, db::DbState>,
) -> Result<(), String> {
    let cfg  = config::load().unwrap_or_default();
    let pair = cfg.pairs.iter()
        .find(|p| p.id == pair_id)
        .ok_or_else(|| format!("pair {pair_id} not found"))?
        .clone();

    sync::reconcile::resolve_conflict(&db_s.0, &pair, &rel_path, &choice)
        .map_err(|e| e.to_string())
}

// P11 Commands

/// Get GitHub push status.
#[tauri::command]
async fn gh_status(_db_s: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let cfg = config::load().unwrap_or_default();
    let has_token = auth::github_token().map(|t| t.is_some()).unwrap_or(false);
    Ok(serde_json::json!({
        "has_token": has_token,
        "repo": cfg.github.repo,
        "branch": cfg.github.branch,
        "last_push": null
    }))
}

/// Manually push state to GitHub.
#[tauri::command]
async fn gh_push_now(db_s: tauri::State<'_, db::DbState>) -> Result<(), String> {
    let cfg = config::load().unwrap_or_default();
    let token = auth::github_token().map_err(|e| e.to_string())?
        .ok_or_else(|| "GitHub token not set".to_string())?;
    let client = github::GitHubClient::new(token, cfg.github.repo.clone(), cfg.github.branch.clone());
    let db_path = db_s.db_path();
    let db_arc = Arc::new(db::Db::open(&db_path).map_err(|e| e.to_string())?);
    let data_dir = db_path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    let repo_root = data_dir.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    let mut cache = github::PushCache::load(&data_dir);
    github::do_push(&client, &db_arc, &cfg, &mut cache, &repo_root)
        .await.map(|_| ()).map_err(|e| e.to_string())
}

/// Manually pull state from GitHub.
#[tauri::command]
async fn gh_pull_now(db_s: tauri::State<'_, db::DbState>) -> Result<(), String> {
    let cfg = config::load().unwrap_or_default();
    let token = auth::github_token().map_err(|e| e.to_string())?
        .ok_or_else(|| "GitHub token not set".to_string())?;
    let client = github::GitHubClient::new(token, cfg.github.repo.clone(), cfg.github.branch.clone());
    let db_path = db_s.db_path();
    let db_arc = db::Db::open(&db_path).map_err(|e| e.to_string())?;
    let data_dir = db_path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    let repo_root = data_dir.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    github::do_pull(&client, &db_arc, &data_dir, &repo_root)
        .await.map_err(|e| e.to_string())
}

/// Manually sync configuration and device state with Google Drive appDataFolder.
#[tauri::command]
async fn appdata_sync_now() -> Result<(), String> {
    let drive = drive::DriveClient::new().map_err(|e| e.to_string())?;
    let cfg = config::load().unwrap_or_default();
    sync::appdata::push_to_appdata(&drive, &cfg).await.map_err(|e| e.to_string())?;
    sync::appdata::pull_from_appdata(&drive).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    // Set process priority first -- before any heavy work starts.
    set_below_normal_priority();

    // Initialise tracing: stdout + data/twin.log with 2 MB rotation, keeping 2 files.
    let log_path = std::path::PathBuf::from(".").join("data").join("twin.log");
    let rotating_logger = Arc::new(Mutex::new(RotatingLogger::new(log_path, 2 * 1024 * 1024)));
    let combined_writer = CombinedWriter { file_logger: rotating_logger };

    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .with_writer(combined_writer)
        .init();

    info!("Twin starting");

    let start_hidden = std::env::args().any(|a| a == "--hidden");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second instance: focus the existing window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::update_config,
            config::add_pair,
            config::remove_pair,
            auth::auth_login,
            auth::auth_logout,
            auth::auth_status,
            auth::auth_get_user,
            auth::auth_set_client_id,
            auth::auth_set_client_secret,
            auth::auth_clear_credentials,
            auth::auth_has_full_scope,
            db::get_activity,
            db::retry_job,
            governor::gov_state,
            governor::gov_pause,
            governor::gov_resume,
            queue::sync_now,
            queue::queue_status,
            drive_list,
            drive_list_subfolders,
            drive_get_folder_meta,
            drive_get_folders,
            drive_get_shared_folders,
            drive_create_folder,
            pick_folder,
            list_revisions,
            restore_file_cmd,
            restore_folder_cmd,
            list_trash,
            untrash,
            untrash_all,
            keep_revision,
            run_sync_cycle,
            resolve_conflict,
            auth::gh_set_token,
            auth::gh_clear_token,
            gh_status,
            gh_push_now,
            gh_pull_now,
            commands::get_autostart,
            commands::set_autostart,
            commands::drive_share_link,
            commands::get_storage_quota,
            commands::list_shared_drives,
            commands::set_description,
            commands::set_starred,
            commands::drive_search,
            appdata_sync_now,
            updater::update_get_state,
            updater::update_check,
            updater::update_install,
            updater::update_clear_pending,
        ])
        .setup(move |app| {
            let handle = app.handle();

            // Open the state DB next to the executable (repo root / data/).
            let db_path = handle
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("data")
                .join("state.db");
            let state_db = db::Db::open(&db_path)
                .map_err(|e| format!("Failed to open state DB: {e}"))?;
            app.manage(db::DbState(state_db, db_path.clone()));

            // Start the resource governor.
            let cfg = config::load().unwrap_or_default();
            let gov_cfg = governor::GovernorCfg {
                cpu_pause_pct: cfg.governor.cpu_pause_pct,
                cpu_resume_pct: cfg.governor.cpu_resume_pct,
                battery_pause_pct: cfg.governor.battery_pause_pct,
                pause_on_metered: cfg.governor.pause_on_metered,
                active_hours: cfg.limits.active_hours.clone(),
            };
            let gov = governor::Governor::new(gov_cfg);
            gov.start(governor::SysinfoCpuSource::new(), Some(handle.clone()));
            app.manage(governor::GovState2(gov.clone()));

            // Start queue dispatcher with UploadRunner (P07).
            let db_arc = Arc::new(
                db::Db::open(&db_path)
                    .map_err(|e| format!("db arc: {e}"))?,
            );
            let up_limiter = Arc::new(
                transfer::Limiter::new(cfg.limits.upload_kbps)
            );
            let upload_runner = Arc::new(transfer::UploadRunner {
                db: Arc::clone(&db_arc),
                cfg: cfg.clone(),
                gov: gov.clone(),
                drive: drive::DriveClient::new()
                    .map_err(|e| format!("drive client: {e}"))?,
                limiter: Arc::clone(&up_limiter),
            });
            let (q, prog_rx) = queue::Queue::new(
                Arc::clone(&db_arc),
                gov.clone(),
                cfg.clone(),
                upload_runner,
            );
            // Spawn progress relay -- emits transfer://progress events.
            let app_handle = handle.clone();
            tauri::async_runtime::spawn(transfer::relay_progress(prog_rx, app_handle));
            app.manage(queue::QueueState(q.clone()));

            // Spawn Google Drive AppData config sync loop (zero-config cloud sync).
            {
                if let Ok(drive_client) = drive::DriveClient::new() {
                    let gov_appdata = gov.clone();
                    tauri::async_runtime::spawn(sync::appdata::appdata_sync_loop(drive_client, gov_appdata, 15));
                }
            }

            // Spawn GitHub push loop (P11).
            {
                let db_arc2 = Arc::clone(&db_arc);
                let gov2 = gov.clone();
                let data_dir = db_path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
                let repo_root = db_path.parent()
                    .and_then(|p| p.parent())
                    .unwrap_or(std::path::Path::new("."))
                    .to_path_buf();
                tauri::async_runtime::spawn(github::push_loop(db_arc2, gov2, data_dir, repo_root));
            }

            // Register tray icon and menu.
            setup_tray(handle)?;

            // Start config file watcher with live limiter/governor/rules reload.
            {
                let gov_live = gov.clone();
                let up_limiter_live = Arc::clone(&up_limiter);
                let db_live = Arc::clone(&db_arc);
                config::watch_config(move |cfg| {
                    info!("Config reloaded live: parallel_transfers={}", cfg.app.parallel_transfers);

                    // 1. Live bandwidth limit update (no restart)
                    let limiter = Arc::clone(&up_limiter_live);
                    let up_kbps = cfg.limits.upload_kbps;
                    tauri::async_runtime::spawn(async move {
                        limiter.set_rate(up_kbps).await;
                    });

                    // 2. Live governor update (no restart)
                    let gov_cfg = governor::GovernorCfg {
                        cpu_pause_pct: cfg.governor.cpu_pause_pct,
                        cpu_resume_pct: cfg.governor.cpu_resume_pct,
                        battery_pause_pct: cfg.governor.battery_pause_pct,
                        pause_on_metered: cfg.governor.pause_on_metered,
                        active_hours: cfg.limits.active_hours.clone(),
                    };
                    gov_live.update_cfg(gov_cfg);

                    // 3. Rebuild rules and enqueue rescan
                    let r = rules::Rules::new(&cfg.rules.include, &cfg.rules.exclude, cfg.rules.max_file_mb);
                    let d = Arc::clone(&db_live);
                    let g = gov_live.clone();
                    let pairs = cfg.pairs.clone();
                    tauri::async_runtime::spawn(async move {
                        for pair in pairs.iter().filter(|p| p.enabled) {
                            let _ = watcher::scan_pair(pair, Arc::clone(&d), &r, &g).await;
                        }
                    });
                });
            }

            // Initial scan on startup: scan all enabled pairs so newly added / unscanned files are enqueued.
            {
                let db_init = Arc::clone(&db_arc);
                let gov_init = gov.clone();
                let q_init = q.clone();
                let pairs_init = cfg.pairs.clone();
                let rules_init = rules::Rules::new(&cfg.rules.include, &cfg.rules.exclude, cfg.rules.max_file_mb);
                tauri::async_runtime::spawn(async move {
                    for pair in pairs_init.iter().filter(|p| p.enabled) {
                        info!("Starting initial scan for pair {} ({})", pair.id, pair.local);
                        if let Err(e) = watcher::scan_pair(pair, Arc::clone(&db_init), &rules_init, &gov_init).await {
                            warn!("Initial scan error for pair {}: {e}", pair.id);
                        }
                    }
                    q_init.wake();
                });
            }

            // Start debounced file system watcher on all local folders.
            {
                let (local_tx, mut local_rx) = tokio::sync::mpsc::unbounded_channel::<watcher::LocalChange>();
                if let Ok(w) = watcher::Watcher::start(&cfg, Arc::clone(&db_arc), local_tx) {
                    std::mem::forget(w);

                    let db_watch = Arc::clone(&db_arc);
                    let gov_watch = gov.clone();
                    let q_watch = q.clone();
                    tauri::async_runtime::spawn(async move {
                        while let Some(change) = local_rx.recv().await {
                            let current_cfg = config::load().unwrap_or_default();
                            let pair = match current_cfg.pairs.iter().find(|p| p.id == change.pair_id && p.enabled) {
                                Some(p) => p.clone(),
                                None => continue,
                            };
                            let rules = rules::Rules::new(&current_cfg.rules.include, &current_cfg.rules.exclude, current_cfg.rules.max_file_mb);
                            let root = std::path::PathBuf::from(&pair.local);
                            let full_path = root.join(&change.rel_path);
                            let rel_str = change.rel_path.to_string_lossy().replace('\\', "/");

                            match change.kind {
                                watcher::ChangeKind::Modified => {
                                    if let Ok(meta) = full_path.metadata() {
                                        if meta.is_file() && rules.allowed_path(Some(&full_path), &change.rel_path, meta.len()) {
                                            let size = meta.len() as i64;
                                            let mtime_ms = meta.modified()
                                                .ok()
                                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                                .map(|d| d.as_millis() as i64)
                                                .unwrap_or(0);
                                            let md5 = watcher::compute_md5(&full_path, &gov_watch).await.ok();
                                            let existing = db_watch.get_file(&pair.id, &rel_str).ok().flatten();
                                            let skip = existing.as_ref().and_then(|r| r.md5.as_deref()) == md5.as_deref();
                                            if !skip {
                                                let row = db::FileRow {
                                                    pair_id: pair.id.clone(),
                                                    rel_path: rel_str.clone(),
                                                    size: Some(size),
                                                    mtime_ms: Some(mtime_ms),
                                                    md5,
                                                    drive_id: existing.as_ref().and_then(|r| r.drive_id.clone()),
                                                    drive_md5: existing.as_ref().and_then(|r| r.drive_md5.clone()),
                                                    drive_mtime_ms: existing.as_ref().and_then(|r| r.drive_mtime_ms),
                                                    drive_rev: existing.as_ref().and_then(|r| r.drive_rev.clone()),
                                                    state: "dirty".into(),
                                                };
                                                let _ = db_watch.upsert_file(row);
                                                let now_ms = std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .unwrap_or_default()
                                                    .as_millis() as i64;
                                                let _ = db_watch.enqueue(db::NewJob {
                                                    pair_id: pair.id.clone(),
                                                    kind: "upload".into(),
                                                    rel_path: rel_str,
                                                    priority: 1,
                                                    created_ms: now_ms,
                                                });
                                                q_watch.wake();
                                            }
                                        }
                                    }
                                }
                                watcher::ChangeKind::Deleted => {
                                    let _ = db_watch.mark_state(&pair.id, &rel_str, "deleted_local");
                                    let now_ms = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis() as i64;
                                    let _ = db_watch.enqueue(db::NewJob {
                                        pair_id: pair.id.clone(),
                                        kind: "delete".into(),
                                        rel_path: rel_str,
                                        priority: 1,
                                        created_ms: now_ms,
                                    });
                                    q_watch.wake();
                                }
                                watcher::ChangeKind::Renamed { from } => {
                                    let from_rel = from.strip_prefix(&root).unwrap_or(&from);
                                    let from_rel_str = from_rel.to_string_lossy().replace('\\', "/");
                                    let now_ms = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis() as i64;
                                    let _ = db_watch.mark_state(&pair.id, &from_rel_str, "deleted_local");
                                    let _ = db_watch.enqueue(db::NewJob {
                                        pair_id: pair.id.clone(),
                                        kind: "delete".into(),
                                        rel_path: from_rel_str,
                                        priority: 1,
                                        created_ms: now_ms,
                                    });
                                    if let Ok(meta) = full_path.metadata() {
                                        if meta.is_file() && rules.allowed_path(Some(&full_path), &change.rel_path, meta.len()) {
                                            let size = meta.len() as i64;
                                            let mtime_ms = meta.modified()
                                                .ok()
                                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                                .map(|d| d.as_millis() as i64)
                                                .unwrap_or(0);
                                            let md5 = watcher::compute_md5(&full_path, &gov_watch).await.ok();
                                            let row = db::FileRow {
                                                pair_id: pair.id.clone(),
                                                rel_path: rel_str.clone(),
                                                size: Some(size),
                                                mtime_ms: Some(mtime_ms),
                                                md5,
                                                drive_id: None,
                                                drive_md5: None,
                                                drive_mtime_ms: None,
                                                drive_rev: None,
                                                state: "dirty".into(),
                                            };
                                            let _ = db_watch.upsert_file(row);
                                            let _ = db_watch.enqueue(db::NewJob {
                                                pair_id: pair.id.clone(),
                                                kind: "upload".into(),
                                                rel_path: rel_str,
                                                priority: 1,
                                                created_ms: now_ms,
                                            });
                                        }
                                    }
                                    q_watch.wake();
                                }
                            }
                        }
                    });
                }
            }

            // Spawn remote changes polling loop for two_way and mirror pairs.
            if let Ok(drive_poll) = drive::DriveClient::new() {
                let db_poll = Arc::clone(&db_arc);
                let gov_poll = gov.clone();
                let echo_poll = Arc::new(sync::SelfWritten::new());
                for pair in cfg.pairs.iter().filter(|p| p.enabled) {
                    let p = pair.clone();
                    let ctx = sync::Ctx {
                        db: Arc::clone(&db_poll),
                        drive: drive_poll.clone(),
                        gov: gov_poll.clone(),
                        echo: Arc::clone(&echo_poll),
                        policy: cfg.policy.clone(),
                        app: Some(handle.clone()),
                    };
                    tauri::async_runtime::spawn(sync::poll_changes_loop(p, ctx));
                }
            }

            // Error toast monitor: max 1 notification per 10 min for persistent failures.
            {
                let handle_toast = handle.clone();
                let db_toast = Arc::clone(&db_arc);
                tauri::async_runtime::spawn(async move {
                    use std::sync::atomic::{AtomicI64, Ordering};
                    static LAST_TOAST_MS: AtomicI64 = AtomicI64::new(0);
                    use tauri_plugin_notification::NotificationExt;

                    loop {
                        tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;
                        if let Ok(failed_count) = db_toast.count_jobs_by_status("failed") {
                            if failed_count > 0 {
                                let now = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as i64;
                                let last = LAST_TOAST_MS.load(Ordering::Relaxed);
                                if now - last >= 600_000 {
                                    LAST_TOAST_MS.store(now, Ordering::Relaxed);
                                    let _ = handle_toast
                                        .notification()
                                        .builder()
                                        .title("Twin Sync Error")
                                        .body(format!("{failed_count} sync job(s) failed after multiple retries."))
                                        .show();
                                }
                            }
                        }
                    }
                });
            }

            // Check pending update on launch (JioTV Max pattern).
            updater::apply_pending_update_on_launch(&handle);

            // Start autonomous background updater (JioTV Max 15s delay, 20m interval).
            updater::init_updater(handle.clone());

            // Hide window on startup if --hidden flag was passed, otherwise ensure shown.
            if let Some(window) = app.get_webview_window("main") {
                if start_hidden {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            info!("Twin setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept close: hide the window instead of quitting.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                info!("Window hidden (kept in tray)");
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Twin");
}
