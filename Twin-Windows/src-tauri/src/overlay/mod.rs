//! Windows File Explorer Icon Overlay Integration
//! Manages the shared memory IPC status cache between Twin and `twin_overlay.dll`.
//! Dispatches SHChangeNotify to redraw folder badges in Explorer upon status changes.

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tracing::{info, warn};

use crate::config::{OverlaySection, PairEntry};
use crate::db::PairSyncStatus;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, BOOL};
#[cfg(windows)]
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, FILE_MAP_ALL_ACCESS, PAGE_READWRITE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ATTRIBUTES, SHCNE_UPDATEITEM, SHCNF_PATHW};

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct SHELLEXECUTEINFOW {
    cbSize: u32,
    fMask: u32,
    hwnd: isize,
    lpVerb: *const u16,
    lpFile: *const u16,
    lpParameters: *const u16,
    lpDirectory: *const u16,
    nShow: i32,
    hInstApp: isize,
    lpIDList: *mut c_void,
    lpClass: *const u16,
    hkeyClass: HKEY,
    dwHotKey: u32,
    hIconOrMonitor: HANDLE,
    hProcess: HANDLE,
}

#[cfg(windows)]
const SEE_MASK_NOCLOSEPROCESS: u32 = 0x00000040;
#[cfg(windows)]
const SW_HIDE: i32 = 0;

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(pExecInfo: *mut SHELLEXECUTEINFOW) -> BOOL;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: u32) -> u32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileMappingW(
        hFile: HANDLE,
        lpFileMappingAttributes: *mut c_void,
        flProtect: u32,
        dwMaximumSizeHigh: u32,
        dwMaximumSizeLow: u32,
        lpName: *const u16,
    ) -> HANDLE;
}

#[cfg(windows)]
#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        hKey: HKEY,
        lpSubKey: *const u16,
        Reserved: u32,
        lpClass: *mut u16,
        dwOptions: u32,
        samDesired: u32,
        lpSecurityAttributes: *mut c_void,
        phkResult: *mut HKEY,
        lpdwDisposition: *mut u32,
    ) -> i32;
}

pub const SHMEM_MAGIC: u32 = 0x5457494E; // 'TWIN'
pub const STATUS_NONE: u32 = 0;
pub const STATUS_SYNCED: u32 = 1;
pub const STATUS_SYNCING: u32 = 2;
pub const STATUS_IS_ROOT: u32 = 4;

#[repr(C)]
pub struct ShmemHeader {
    pub magic: u32,
    pub version: u32,
    pub enabled: u32,
    pub placement: u32, // 0 = top_right, 1 = bottom_right, 2 = centered
    pub count: u32,
    pub sequence: u32,
}

#[repr(C)]
pub struct ShmemEntry {
    pub status: u32,
    pub path_len: u32,
    pub path: [u16; 260],
}

static SEQUENCE: AtomicUsize = AtomicUsize::new(1);
static LAST_FOLDER_STATUSES: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

#[cfg(windows)]
struct ShmemHolder {
    #[allow(dead_code)]
    handle: HANDLE,
    view: *mut c_void,
}

#[cfg(windows)]
unsafe impl Send for ShmemHolder {}
#[cfg(windows)]
unsafe impl Sync for ShmemHolder {}

#[cfg(windows)]
static SHMEM_HANDLE: Mutex<Option<ShmemHolder>> = Mutex::new(None);

const SHMEM_NAME_W: &[u16] = &[
    b'L' as u16, b'o' as u16, b'c' as u16, b'a' as u16, b'l' as u16, b'\\' as u16,
    b'T' as u16, b'w' as u16, b'i' as u16, b'n' as u16, b'_' as u16, b'O' as u16,
    b'v' as u16, b'e' as u16, b'r' as u16, b'l' as u16, b'a' as u16, b'y' as u16,
    b'_' as u16, b'S' as u16, b'h' as u16, b'a' as u16, b'r' as u16, b'e' as u16,
    b'd' as u16, b'M' as u16, b'e' as u16, b'm' as u16, b'o' as u16, b'r' as u16,
    b'y' as u16, b'_' as u16, b'v' as u16, b'1' as u16, 0,
];

/// Normalize a local folder path for case-insensitive Windows Explorer comparison
pub fn normalize_folder_path(path: &str) -> String {
    let p = path.trim().replace('/', "\\");
    let trimmed = p.trim_end_matches('\\');
    if trimmed.len() <= 2 && trimmed.ends_with(':') {
        format!("{trimmed}\\").to_uppercase()
    } else {
        trimmed.to_uppercase()
    }
}

/// Calculate current folder status across pairs according to user rules:
/// - "If a folder belongs to multiple sync pairs, AND the statuses: if even one pair is active, show yellow. Show green only when all are done."
/// - "Show no overlay for folders that aren’t synced."
pub fn calculate_folder_statuses(
    pairs: &[PairEntry],
    pair_statuses: &HashMap<String, PairSyncStatus>,
    _active_paths: &[(String, String)],
) -> HashMap<String, u32> {
    let mut folder_pairs_map: HashMap<String, Vec<&PairEntry>> = HashMap::new();

    for pair in pairs {
        if !pair.enabled {
            continue;
        }
        let norm = normalize_folder_path(&pair.local);
        if !norm.is_empty() {
            folder_pairs_map.entry(norm).or_default().push(pair);
        }
    }

    let mut result = HashMap::new();

    // Evaluate pair parent folders only (children do not receive overlays)
    for (norm_path, pair_list) in folder_pairs_map {
        if pair_list.is_empty() {
            continue;
        }

        let mut has_syncing = false;
        let mut all_done = true;

        for pair in pair_list {
            if let Some(status) = pair_statuses.get(&pair.id) {
                // If any transfers queued, running, or pending dirty files -> syncing (active)
                if status.running > 0 || status.queued > 0 || status.dirty > 0 {
                    has_syncing = true;
                    all_done = false;
                    break;
                }
            }
        }

        let status = if has_syncing {
            STATUS_SYNCING
        } else if all_done {
            STATUS_SYNCED
        } else {
            STATUS_NONE
        };

        result.insert(norm_path, status);
    }

    result
}

/// Update shared memory buffer and trigger SHChangeNotify for folders whose status changed
#[cfg(windows)]
pub fn update_folder_overlays(
    pairs: &[PairEntry],
    pair_statuses: &HashMap<String, PairSyncStatus>,
    active_paths: &[(String, String)],
    overlay_cfg: &OverlaySection,
) {
    let statuses = calculate_folder_statuses(pairs, pair_statuses, active_paths);

    // Write to shared memory
    unsafe {
        let mut holder_guard = match SHMEM_HANDLE.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        if holder_guard.is_none() {
            let size = 65536; // 64 KB
            let h_map = CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                std::ptr::null_mut(),
                PAGE_READWRITE,
                0,
                size,
                SHMEM_NAME_W.as_ptr(),
            );
            if h_map != std::ptr::null_mut() && h_map != INVALID_HANDLE_VALUE {
                let mapped = MapViewOfFile(h_map, FILE_MAP_ALL_ACCESS, 0, 0, size as usize);
                let view = mapped.Value as *mut c_void;
                if !view.is_null() {
                    *holder_guard = Some(ShmemHolder {
                        handle: h_map,
                        view,
                    });
                } else {
                    let _ = CloseHandle(h_map);
                }
            }
        }

        if let Some(ref holder) = *holder_guard {
            let view = holder.view;
            let header = &mut *(view as *mut ShmemHeader);
            header.magic = SHMEM_MAGIC;
            header.version = 1;
            header.enabled = if overlay_cfg.enabled { 1 } else { 0 };
            header.placement = match overlay_cfg.placement.as_str() {
                "bottom_right" => 1,
                "centered" => 2,
                _ => 0, // top_right
            };
            if !overlay_cfg.enabled {
                header.count = 0;
                return;
            }
            header.count = statuses.len().min(256) as u32;
            header.sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed) as u32;

            let entries_ptr = (view as *mut u8).add(std::mem::size_of::<ShmemHeader>()) as *mut ShmemEntry;

            let mut idx = 0;
            for (norm_path, &status) in &statuses {
                if idx >= 256 {
                    break;
                }
                let entry = &mut *entries_ptr.add(idx);
                entry.status = status;

                let wide: Vec<u16> = norm_path.encode_utf16().collect();
                let len = wide.len().min(259);
                entry.path_len = len as u32;
                entry.path[..len].copy_from_slice(&wide[..len]);
                entry.path[len] = 0;

                idx += 1;
            }
        }
    }

    // Compare with last status and notify Explorer
    let mut last_guard = match LAST_FOLDER_STATUSES.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    let prev = last_guard.take().unwrap_or_default();
    let mut changed_paths = Vec::new();

    for (norm_path, &status) in &statuses {
        if let Some(&old_status) = prev.get(norm_path) {
            if old_status != status {
                changed_paths.push(norm_path.clone());
            }
        } else {
            // New folder
            changed_paths.push(norm_path.clone());
        }
    }

    for (old_path, _) in &prev {
        if !statuses.contains_key(old_path) {
            changed_paths.push(old_path.clone());
        }
    }

    *last_guard = Some(statuses);

    for path in changed_paths {
        notify_explorer_folder_changed(&path);
    }
}

#[cfg(not(windows))]
pub fn update_folder_overlays(
    _pairs: &[PairEntry],
    _pair_statuses: &HashMap<String, PairSyncStatus>,
    _active_paths: &[(String, String)],
    _overlay_cfg: &OverlaySection,
) {}

/// Tell Windows Explorer to refresh icon overlays for a path immediately
#[cfg(windows)]
pub fn notify_explorer_folder_changed(path: &str) {
    const SHCNF_FLUSHNOWAIT: u32 = 0x00002000;
    const SHCNE_UPDATEDIR: i32 = 0x00001000;

    unsafe {
        let mut wide: Vec<u16> = path.encode_utf16().collect();
        wide.push(0);

        let flags = SHCNF_PATHW | SHCNF_FLUSHNOWAIT;
        SHChangeNotify(
            SHCNE_UPDATEITEM as i32,
            flags,
            wide.as_ptr() as _,
            std::ptr::null(),
        );
        SHChangeNotify(
            SHCNE_UPDATEDIR,
            flags,
            wide.as_ptr() as _,
            std::ptr::null(),
        );
        SHChangeNotify(
            SHCNE_ATTRIBUTES as i32,
            flags,
            wide.as_ptr() as _,
            std::ptr::null(),
        );
    }
}

#[cfg(not(windows))]
pub fn notify_explorer_folder_changed(_path: &str) {}

/// Force notify all current pairs to refresh their Explorer overlays
pub fn refresh_all_folder_overlays(pairs: &[PairEntry]) {
    for pair in pairs {
        let norm = normalize_folder_path(&pair.local);
        if !norm.is_empty() {
            notify_explorer_folder_changed(&norm);
        }
    }
}

/// Write placement and icon directory settings to HKCU\Software\Twin\Overlay
#[cfg(windows)]
pub fn sync_registry_settings(cfg: &OverlaySection) -> Result<(), String> {
    unsafe {
        let subkey_w: Vec<u16> = "Software\\Twin\\Overlay\0".encode_utf16().collect();
        let mut hkey: HKEY = std::ptr::null_mut();
        let res = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey_w.as_ptr(),
            0,
            std::ptr::null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            std::ptr::null_mut(),
            &mut hkey,
            std::ptr::null_mut(),
        );
        if res != 0 {
            return Err(format!("RegCreateKeyExW failed with code {res}"));
        }

        // Placement
        let name_p: Vec<u16> = "Placement\0".encode_utf16().collect();
        let val_p: Vec<u16> = format!("{}\0", cfg.placement).encode_utf16().collect();
        RegSetValueExW(
            hkey,
            name_p.as_ptr(),
            0,
            REG_SZ,
            val_p.as_ptr() as _,
            (val_p.len() * 2) as u32,
        );

        // Icon directory: point to Twin icons/overlay
        if let Some(icon_dir) = find_overlay_icons_dir() {
            let name_i: Vec<u16> = "IconDir\0".encode_utf16().collect();
            let val_i: Vec<u16> = format!("{}\0", icon_dir.display()).encode_utf16().collect();
            RegSetValueExW(
                hkey,
                name_i.as_ptr(),
                0,
                REG_SZ,
                val_i.as_ptr() as _,
                (val_i.len() * 2) as u32,
            );
        }

        let _ = RegCloseKey(hkey);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn sync_registry_settings(_cfg: &OverlaySection) -> Result<(), String> {
    Ok(())
}

/// Locate the overlay icons directory
pub fn find_overlay_icons_dir() -> Option<PathBuf> {
    // 1. Check relative to current exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let cand1 = parent.join("icons").join("overlay");
            if cand1.exists() {
                return Some(cand1);
            }
            let cand2 = parent.join("overlay");
            if cand2.exists() {
                return Some(cand2);
            }
        }
    }

    // 2. Check development workspace paths
    let icon_pack = PathBuf::from(r"T:\Coding\Twin\Icon-Pack");
    if icon_pack.exists() && icon_pack.join("synced.ico").exists() {
        return Some(icon_pack);
    }

    let dev_path = PathBuf::from(r"T:\Coding\Twin\Twin-Windows\src-tauri\icons\overlay");
    if dev_path.exists() {
        return Some(dev_path);
    }

    None
}

/// Find `twin_overlay.dll` binary
pub fn find_overlay_dll_path() -> Option<PathBuf> {
    if let Some(dir) = find_overlay_icons_dir() {
        let dll = dir.join("twin_overlay.dll");
        if dll.exists() {
            return Some(dll);
        }
    }

    let rel_dll = PathBuf::from(r"T:\Coding\Twin\Twin-Windows\overlay-handler\target\release\twin_overlay.dll");
    if rel_dll.exists() {
        return Some(rel_dll);
    }

    None
}

/// Locate the helper administrative registration batch script
pub fn find_admin_script(script_name: &str) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.join(script_name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    let ws = PathBuf::from(r"T:\Coding\Twin").join(script_name);
    if ws.exists() {
        return Some(ws);
    }
    None
}

/// Check if the shell overlay identifiers are registered in HKEY_LOCAL_MACHINE
/// Note: Windows Explorer strictly reads overlay extensions from HKLM only.
#[cfg(windows)]
pub fn is_overlay_registered() -> bool {
    let synced_clsid_str = "{9B46E711-2051-417A-8D52-19253DE6C7D1}";

    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers\\   TwinSynced\0"
        .encode_utf16()
        .collect();
    let mut hkey: HKEY = std::ptr::null_mut();
    unsafe {
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, subkey.as_ptr(), 0, KEY_READ, &mut hkey) == 0 {
            let mut buf = [0u16; 64];
            let mut buf_bytes = (buf.len() * 2) as u32;
            let mut reg_type = 0;
            let q_res = RegQueryValueExW(
                hkey,
                std::ptr::null(),
                std::ptr::null_mut(),
                &mut reg_type,
                buf.as_mut_ptr() as _,
                &mut buf_bytes,
            );
            let _ = RegCloseKey(hkey);
            if q_res == 0 {
                let val = String::from_utf16_lossy(&buf);
                if val.contains(synced_clsid_str) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(not(windows))]
pub fn is_overlay_registered() -> bool {
    false
}

/// Register `twin_overlay.dll` into Windows Registry (HKLM + HKCU)
#[cfg(windows)]
pub fn register_overlay_handler() -> Result<(), String> {
    if is_overlay_registered() {
        info!("Twin Explorer Overlay is already registered in HKLM.");
        return Ok(());
    }

    let dll_path = find_overlay_dll_path().ok_or_else(|| {
        "twin_overlay.dll not found. Please compile the overlay handler first.".to_string()
    })?;

    let dll_str = dll_path.to_string_lossy().to_string();
    let synced_clsid_str = "{9B46E711-2051-417A-8D52-19253DE6C7D1}";
    let syncing_clsid_str = "{9B46E712-2051-417A-8D52-19253DE6C7D2}";

    // Always register in HKCU so COM can find InprocServer32 in the interactive session
    unsafe {
        let clsid_key = format!("SOFTWARE\\Classes\\CLSID\\{synced_clsid_str}");
        set_reg_val(HKEY_CURRENT_USER, &clsid_key, None, "Twin Synced Icon Overlay");
        set_reg_val(HKEY_CURRENT_USER, &format!("{clsid_key}\\InprocServer32"), None, &dll_str);
        set_reg_val(HKEY_CURRENT_USER, &format!("{clsid_key}\\InprocServer32"), Some("ThreadingModel"), "Apartment");

        let syncing_key = format!("SOFTWARE\\Classes\\CLSID\\{syncing_clsid_str}");
        set_reg_val(HKEY_CURRENT_USER, &syncing_key, None, "Twin Syncing Icon Overlay");
        set_reg_val(HKEY_CURRENT_USER, &format!("{syncing_key}\\InprocServer32"), None, &dll_str);
        set_reg_val(HKEY_CURRENT_USER, &format!("{syncing_key}\\InprocServer32"), Some("ThreadingModel"), "Apartment");
    }

    // Attempt direct write to HKLM (succeeds if running as Administrator)
    let hklm_success = unsafe {
        let shell_overlays = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";
        let r1 = set_reg_val(HKEY_LOCAL_MACHINE, &format!("{shell_overlays}\\   TwinSynced"), None, synced_clsid_str);
        let r2 = set_reg_val(HKEY_LOCAL_MACHINE, &format!("{shell_overlays}\\   TwinSyncing"), None, syncing_clsid_str);

        let clsid_key = format!("SOFTWARE\\Classes\\CLSID\\{synced_clsid_str}");
        let _ = set_reg_val(HKEY_LOCAL_MACHINE, &clsid_key, None, "Twin Synced Icon Overlay");
        let _ = set_reg_val(HKEY_LOCAL_MACHINE, &format!("{clsid_key}\\InprocServer32"), None, &dll_str);
        let _ = set_reg_val(HKEY_LOCAL_MACHINE, &format!("{clsid_key}\\InprocServer32"), Some("ThreadingModel"), "Apartment");

        let syncing_key = format!("SOFTWARE\\Classes\\CLSID\\{syncing_clsid_str}");
        let _ = set_reg_val(HKEY_LOCAL_MACHINE, &syncing_key, None, "Twin Syncing Icon Overlay");
        let _ = set_reg_val(HKEY_LOCAL_MACHINE, &format!("{syncing_key}\\InprocServer32"), None, &dll_str);
        let _ = set_reg_val(HKEY_LOCAL_MACHINE, &format!("{syncing_key}\\InprocServer32"), Some("ThreadingModel"), "Apartment");

        r1 && r2
    };

    if hklm_success {
        info!("Registered Twin Explorer Overlay Shell Extension directly into HKLM with path {}", dll_str);
        let _ = restart_explorer();
        return Ok(());
    }

    // Direct write to HKLM was denied (standard user). Elevate with Windows UAC runas dialog.
    elevate_and_register_overlay()
}

#[cfg(windows)]
fn elevate_and_register_overlay() -> Result<(), String> {
    let cmd_script = find_admin_script("register_overlay_admin.cmd").ok_or_else(|| {
        "register_overlay_admin.cmd not found. Please ensure it exists in the Twin folder.".to_string()
    })?;

    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = "cmd.exe\0".encode_utf16().collect();
    let param_str = format!("/c \"{}\"\0", cmd_script.display());
    let params: Vec<u16> = param_str.encode_utf16().collect();

    let mut exec_info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: 0,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: params.as_ptr(),
        lpDirectory: std::ptr::null(),
        nShow: SW_HIDE,
        hInstApp: 0,
        lpIDList: std::ptr::null_mut(),
        lpClass: std::ptr::null(),
        hkeyClass: std::ptr::null_mut(),
        dwHotKey: 0,
        hIconOrMonitor: std::ptr::null_mut(),
        hProcess: std::ptr::null_mut(),
    };

    let ok = unsafe { ShellExecuteExW(&mut exec_info) };
    if ok == 0 {
        let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        if err == 1223 {
            return Err("Administrator elevation was cancelled by user.".to_string());
        }
        return Err(format!("Failed to prompt for Administrator elevation (error code {err}). Please right-click register_overlay_admin.cmd and choose 'Run as administrator'."));
    }

    if exec_info.hProcess != std::ptr::null_mut() && exec_info.hProcess != INVALID_HANDLE_VALUE {
        unsafe {
            WaitForSingleObject(exec_info.hProcess, 15000);
            CloseHandle(exec_info.hProcess);
        }
    }

    if is_overlay_registered() {
        info!("Shell overlays successfully registered in HKLM via elevated script");
        Ok(())
    } else {
        Err("Registration script executed, but HKLM keys were not found. Please right-click register_overlay_admin.cmd and choose 'Run as administrator'.".to_string())
    }
}

#[cfg(not(windows))]
pub fn register_overlay_handler() -> Result<(), String> {
    Ok(())
}

/// Unregister `twin_overlay.dll` from Windows Registry
#[cfg(windows)]
pub fn unregister_overlay_handler() -> Result<(), String> {
    let synced_clsid_str = "{9B46E711-2051-417A-8D52-19253DE6C7D1}";
    let syncing_clsid_str = "{9B46E712-2051-417A-8D52-19253DE6C7D2}";

    unsafe {
        let shell_overlays = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";
        del_reg_val(HKEY_CURRENT_USER, &format!("{shell_overlays}\\   TwinSynced"));
        del_reg_val(HKEY_CURRENT_USER, &format!("{shell_overlays}\\   TwinSyncing"));

        del_reg_val(HKEY_CURRENT_USER, &format!("SOFTWARE\\Classes\\CLSID\\{synced_clsid_str}\\InprocServer32"));
        del_reg_val(HKEY_CURRENT_USER, &format!("SOFTWARE\\Classes\\CLSID\\{synced_clsid_str}"));

        del_reg_val(HKEY_CURRENT_USER, &format!("SOFTWARE\\Classes\\CLSID\\{syncing_clsid_str}\\InprocServer32"));
        del_reg_val(HKEY_CURRENT_USER, &format!("SOFTWARE\\Classes\\CLSID\\{syncing_clsid_str}"));
    }

    // Try deleting HKLM directly
    let hklm_del = unsafe {
        let shell_overlays = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";
        let r1 = del_reg_val(HKEY_LOCAL_MACHINE, &format!("{shell_overlays}\\   TwinSynced"));
        let r2 = del_reg_val(HKEY_LOCAL_MACHINE, &format!("{shell_overlays}\\   TwinSyncing"));
        r1 || r2
    };

    if !hklm_del && is_overlay_registered() {
        elevate_and_unregister_overlay()?;
    }

    let _ = restart_explorer();
    info!("Unregistered Twin Explorer Overlay Shell Extension");
    Ok(())
}

#[cfg(windows)]
fn elevate_and_unregister_overlay() -> Result<(), String> {
    let cmd_script = find_admin_script("unregister_overlay_admin.cmd").ok_or_else(|| {
        "unregister_overlay_admin.cmd not found.".to_string()
    })?;

    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = "cmd.exe\0".encode_utf16().collect();
    let param_str = format!("/c \"{}\"\0", cmd_script.display());
    let params: Vec<u16> = param_str.encode_utf16().collect();

    let mut exec_info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: 0,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: params.as_ptr(),
        lpDirectory: std::ptr::null(),
        nShow: SW_HIDE,
        hInstApp: 0,
        lpIDList: std::ptr::null_mut(),
        lpClass: std::ptr::null(),
        hkeyClass: std::ptr::null_mut(),
        dwHotKey: 0,
        hIconOrMonitor: std::ptr::null_mut(),
        hProcess: std::ptr::null_mut(),
    };

    let ok = unsafe { ShellExecuteExW(&mut exec_info) };
    if ok == 0 {
        let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        if err == 1223 {
            return Err("Administrator elevation was cancelled by user.".to_string());
        }
        return Err(format!("Failed to prompt for Administrator elevation (error code {err})."));
    }

    if exec_info.hProcess != std::ptr::null_mut() && exec_info.hProcess != INVALID_HANDLE_VALUE {
        unsafe {
            WaitForSingleObject(exec_info.hProcess, 15000);
            CloseHandle(exec_info.hProcess);
        }
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn unregister_overlay_handler() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
unsafe fn set_reg_val(root: HKEY, subkey: &str, value_name: Option<&str>, data: &str) -> bool {
    let subkey_w: Vec<u16> = format!("{subkey}\0").encode_utf16().collect();
    let mut hkey: HKEY = std::ptr::null_mut();
    let res = RegCreateKeyExW(
        root,
        subkey_w.as_ptr(),
        0,
        std::ptr::null_mut(),
        REG_OPTION_NON_VOLATILE,
        KEY_WRITE,
        std::ptr::null_mut(),
        &mut hkey,
        std::ptr::null_mut(),
    );
    if res != 0 {
        return false;
    }

    let data_w: Vec<u16> = format!("{data}\0").encode_utf16().collect();
    let name_w: Option<Vec<u16>> = value_name.map(|n| format!("{n}\0").encode_utf16().collect());
    let name_ptr = name_w.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null());

    let set_res = RegSetValueExW(
        hkey,
        name_ptr,
        0,
        REG_SZ,
        data_w.as_ptr() as _,
        (data_w.len() * 2) as u32,
    );
    let _ = RegCloseKey(hkey);
    set_res == 0
}

#[cfg(windows)]
unsafe fn del_reg_val(root: HKEY, subkey: &str) -> bool {
    let subkey_w: Vec<u16> = format!("{subkey}\0").encode_utf16().collect();
    RegDeleteKeyW(root, subkey_w.as_ptr()) == 0
}

/// Restart Windows Explorer (taskkill + start explorer.exe)
pub fn restart_explorer() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::process::Command;
        info!("Restarting Windows Explorer process to reload shell icon overlays");
        let output = Command::new("cmd")
            .args(["/C", "taskkill /f /im explorer.exe & del /f /q \"%LocalAppData%\\Microsoft\\Windows\\Explorer\\iconcache_*.db\" 2>nul & del /f /q \"%LocalAppData%\\Microsoft\\Windows\\Explorer\\thumbcache_*.db\" 2>nul & ie4uinit.exe -show & start explorer.exe"])
            .output()
            .map_err(|e| format!("Failed to spawn restart command: {e}"))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            warn!("Explorer restart command stderr: {err}");
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
