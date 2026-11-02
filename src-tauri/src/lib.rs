pub mod error;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};
use tracing::info;

pub use error::AppError;

/// The four visual states the tray icon can represent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Idle,
    Syncing,
    Paused,
    Error,
}

impl TrayState {
    fn icon_path(self) -> &'static str {
        match self {
            TrayState::Idle => "icons/tray/idle.png",
            TrayState::Syncing => "icons/tray/syncing.png",
            TrayState::Paused => "icons/tray/paused.png",
            TrayState::Error => "icons/tray/error.png",
        }
    }

    fn tooltip(self) -> &'static str {
        match self {
            TrayState::Idle => "Tether \u{2013} Idle",
            TrayState::Syncing => "Tether \u{2013} Syncing",
            TrayState::Paused => "Tether \u{2013} Paused",
            TrayState::Error => "Tether \u{2013} Error",
        }
    }
}

/// Update the tray icon to reflect the current application state.
pub fn set_tray_state<R: Runtime>(app: &AppHandle<R>, state: TrayState) {
    let resource_path = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join(state.icon_path());

    match Image::from_path(&resource_path) {
        Ok(icon) => {
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_tooltip(Some(state.tooltip()));
            }
        }
        Err(e) => {
            tracing::warn!("Could not load tray icon {:?}: {e}", state.icon_path());
        }
    }
}

/// Build the system-tray menu and return it.
fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "Open Tether", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause / Resume", true, None::<&str>)?;
    let sync_now = MenuItem::with_id(app, "sync_now", "Sync now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &pause, &sync_now, &quit])
}

/// Register the tray icon. Called once from `setup`.
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let resource_path = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("icons/tray/idle.png");

    let icon = Image::from_path(&resource_path).map_err(|e| {
        tracing::error!("Failed to load idle tray icon: {e}");
        e
    })?;

    let menu = build_tray_menu(app)?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Tether \u{2013} Idle")
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
