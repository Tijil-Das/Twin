// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tracing::info;
use tether_lib::{auth, config, db, governor, setup_tray};

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

fn main() {
    // Set process priority first — before any heavy work starts.
    set_below_normal_priority();

    // Initialise tracing: stdout only, INFO level.
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .init();

    info!("Tether starting");

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
            auth::auth_set_client_id,
            auth::auth_set_client_secret,
            auth::auth_clear_credentials,
            db::get_activity,
            db::retry_job,
            governor::gov_state,
            governor::gov_pause,
            governor::gov_resume,
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
            app.manage(db::DbState(state_db));

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
            app.manage(governor::GovState2(gov));

            // Register tray icon and menu.
            setup_tray(handle)?;

            // Start config file watcher.
            config::watch_config(|cfg| {
                info!("Config reloaded: parallel_transfers={}", cfg.app.parallel_transfers);
            });

            // Hide window on startup if --hidden flag was passed.
            if start_hidden {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            info!("Tether setup complete");
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
        .expect("error while running Tether");
}

