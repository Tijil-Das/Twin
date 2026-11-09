pub mod auth;
pub mod commands;
pub mod config;
pub mod db;
pub mod drive;
pub mod error;
pub mod github;
pub mod governor;
pub mod queue;
pub mod rules;
pub mod sync;
pub mod transfer;
pub mod updater;
pub mod watcher;
pub mod overlay;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};
use tracing::info;

pub use error::AppError;

const ICON_IDLE: &[u8] = include_bytes!("../icons/tray/idle.png");
const ICON_SYNCING: &[u8] = include_bytes!("../icons/tray/syncing.png");
const ICON_PAUSED: &[u8] = include_bytes!("../icons/tray/paused.png");
const ICON_ERROR: &[u8] = include_bytes!("../icons/tray/error.png");

/// The four visual states the tray icon can represent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Idle,
    Syncing,
    Paused,
    Error,
}

impl TrayState {
    fn icon_bytes(self) -> &'static [u8] {
        match self {
            TrayState::Idle => ICON_IDLE,
            TrayState::Syncing => ICON_SYNCING,
            TrayState::Paused => ICON_PAUSED,
            TrayState::Error => ICON_ERROR,
        }
    }

    fn tooltip(self) -> &'static str {
        match self {
            TrayState::Idle => "Twin \u{2013} Idle",
            TrayState::Syncing => "Twin \u{2013} Syncing",
            TrayState::Paused => "Twin \u{2013} Paused",
            TrayState::Error => "Twin \u{2013} Error",
        }
    }
}

/// Update the tray icon to reflect the current application state.
pub fn set_tray_state<R: Runtime>(app: &AppHandle<R>, state: TrayState, custom_tooltip: Option<&str>) {
    match Image::from_bytes(state.icon_bytes()) {
        Ok(icon) => {
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_icon(Some(icon));
                let tip = custom_tooltip.unwrap_or_else(|| state.tooltip());
                let _ = tray.set_tooltip(Some(tip));
            }
        }
        Err(e) => {
            tracing::warn!("Could not load tray icon for {state:?}: {e}");
        }
    }
}

/// Build the system-tray menu and return it.
fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "Open Twin", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause / Resume", true, None::<&str>)?;
    let sync_now = MenuItem::with_id(app, "sync_now", "Sync now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &pause, &sync_now, &quit])
}

/// Register the tray icon. Called once from `setup`.
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let icon = match Image::from_bytes(ICON_IDLE) {
        Ok(img) => img,
        Err(e) => {
            tracing::error!("Failed to parse idle tray icon bytes: {e}");
            return Err(e);
        }
    };

    let menu = build_tray_menu(app)?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Twin \u{2013} Idle")
        .menu(&menu)
        .on_menu_event({
            let app_handle = app.clone();
            move |_tray, event| match event.id().as_ref() {
                "open" => show_window(&app_handle),
                "quit" => {
                    info!("Quit requested from tray");
                    app_handle.exit(0);
                }
                "pause" => {
                    info!("Pause/Resume toggled from tray");
                }
                "sync_now" => {
                    info!("Sync now requested from tray");
                }
                _ => {}
            }
        })
        .on_tray_icon_event({
            let app_handle = app.clone();
            move |_tray, event| if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event {
                show_window(&app_handle);
            }
        })
        .build(app)?;

    Ok(())
}

fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
