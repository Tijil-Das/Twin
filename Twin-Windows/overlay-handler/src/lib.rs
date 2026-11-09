//! Twin Windows Explorer Shell Icon Overlay — IShellIconOverlayIdentifier
//!
//! Implements TWO COM objects:
//!   TwinSyncedOverlay  — shows green checkmark badge on synced folders
//!   TwinSyncingOverlay — shows yellow circle badge on actively syncing folders
//!
//! Both read the shared memory map written by the Twin app process to decide
//! whether a given folder should receive an overlay.
//!
//! Badge POSITION (top_right / bottom_right / centered) is encoded in the ICO
//! file name itself — the DLL picks synced_{placement}.ico / syncing_{placement}.ico.
//! The shell draws the full-size overlay ICO composited over the folder icon, so
//! wherever the badge sits in the ICO canvas is exactly where it appears on the folder.
//!
//! Registration:
//!   HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers
//!     "   TwinSynced"  = {CLSID_TWIN_SYNCED}
//!     "   TwinSyncing" = {CLSID_TWIN_SYNCING}
//!   HKLM\SOFTWARE\Classes\CLSID\{...}\InprocServer32 = twin_overlay.dll

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};

use windows_sys::Win32::Foundation::{
    BOOL, FALSE, HANDLE, HMODULE, INVALID_HANDLE_VALUE, S_FALSE, S_OK,
    CloseHandle,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, FILE_MAP_READ,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};

#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        hKey: HKEY, lpSubKey: *const u16, Reserved: u32, lpClass: *mut u16,
        dwOptions: u32, samDesired: u32, lpSecurityAttributes: *mut c_void,
        phkResult: *mut HKEY, lpdwDisposition: *mut u32,
    ) -> i32;
}

pub type HRESULT = i32;

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct GUID {
    pub data1: u32, pub data2: u16, pub data3: u16, pub data4: [u8; 8],
}

pub const E_NOINTERFACE:      HRESULT = 0x80004002_u32 as i32;
pub const E_POINTER:          HRESULT = 0x80004003_u32 as i32;
pub const CLASS_E_NOAGGREGATION: HRESULT = 0x80040110_u32 as i32;

// {9B46E711-2051-417A-8D52-19253DE6C7D1} — TwinSynced overlay
pub const CLSID_TWIN_SYNCED: GUID = GUID {
    data1: 0x9B46E711, data2: 0x2051, data3: 0x417A,
    data4: [0x8D, 0x52, 0x19, 0x25, 0x3D, 0xE6, 0xC7, 0xD1],
};
// {9B46E712-2051-417A-8D52-19253DE6C7D2} — TwinSyncing overlay
pub const CLSID_TWIN_SYNCING: GUID = GUID {
    data1: 0x9B46E712, data2: 0x2051, data3: 0x417A,
    data4: [0x8D, 0x52, 0x19, 0x25, 0x3D, 0xE6, 0xC7, 0xD2],
};

pub const IID_IUNKNOWN: GUID = GUID {
    data1: 0x00000000, data2: 0x0000, data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};
pub const IID_ICLASSFACTORY: GUID = GUID {
    data1: 0x00000001, data2: 0x0000, data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};
// {0C6C4200-C589-11D0-999A-00C04FD655E1}
pub const IID_ISHELL_ICON_OVERLAY_IDENTIFIER: GUID = GUID {
    data1: 0x0C6C4200, data2: 0xC589, data3: 0x11D0,
    data4: [0x99, 0x9A, 0x00, 0xC0, 0x4F, 0xD6, 0x55, 0xE1],
};

// ── Shared Memory ─────────────────────────────────────────────────────────────

pub const SHMEM_MAGIC: u32 = 0x5457494E; // 'TWIN'
pub const STATUS_NONE:    u32 = 0;
pub const STATUS_SYNCED:  u32 = 1;
pub const STATUS_SYNCING: u32 = 2;

#[repr(C)]
pub struct ShmemHeader {
    pub magic: u32, pub version: u32, pub enabled: u32,
    pub placement: u32, // 0=top_right 1=bottom_right 2=centered
    pub count: u32, pub sequence: u32,
}
#[repr(C)]
pub struct ShmemEntry {
    pub status: u32, pub path_len: u32, pub path: [u16; 260],
}

static SHMEM_VIEW:  AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static MODULE_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static OBJECT_COUNT:  AtomicUsize = AtomicUsize::new(0);
static SERVER_LOCKS:  AtomicUsize = AtomicUsize::new(0);

const SHMEM_NAME_W: &[u16] = &[
    b'L' as u16, b'o' as u16, b'c' as u16, b'a' as u16, b'l' as u16, b'\\' as u16,
    b'T' as u16, b'w' as u16, b'i' as u16, b'n' as u16, b'_' as u16, b'O' as u16,
    b'v' as u16, b'e' as u16, b'r' as u16, b'l' as u16, b'a' as u16, b'y' as u16,
    b'_' as u16, b'S' as u16, b'h' as u16, b'a' as u16, b'r' as u16, b'e' as u16,
    b'd' as u16, b'M' as u16, b'e' as u16, b'm' as u16, b'o' as u16, b'r' as u16,
    b'y' as u16, b'_' as u16, b'v' as u16, b'1' as u16, 0,
];

unsafe fn get_or_open_shmem() -> *mut c_void {
    let ptr = SHMEM_VIEW.load(Ordering::Acquire);
    if !ptr.is_null() { return ptr; }
    let h: HANDLE = OpenFileMappingW(FILE_MAP_READ, FALSE, SHMEM_NAME_W.as_ptr());
    if h == std::ptr::null_mut() || h == INVALID_HANDLE_VALUE { return std::ptr::null_mut(); }
    let mapped = MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0);
    let view = mapped.Value as *mut c_void;
    let _ = CloseHandle(h);
    if !view.is_null() { SHMEM_VIEW.store(view, Ordering::Release); }
    view
}

/// Returns (enabled, placement, status) for the given normalised folder path.
unsafe fn lookup_folder(norm: &[u16], norm_len: usize) -> (bool, u32, u32) {
    let ptr = get_or_open_shmem();
    if ptr.is_null() { return (false, 0, STATUS_NONE); }
    let hdr = &*(ptr as *const ShmemHeader);
    if hdr.magic != SHMEM_MAGIC {
        SHMEM_VIEW.store(std::ptr::null_mut(), Ordering::Release);
        return (false, 0, STATUS_NONE);
    }
    if hdr.enabled == 0 { return (false, hdr.placement, STATUS_NONE); }
    let count = (hdr.count as usize).min(256);
    let placement = hdr.placement;
    if count == 0 { return (true, placement, STATUS_NONE); }
    let entries = (ptr as *const u8).add(std::mem::size_of::<ShmemHeader>()) as *const ShmemEntry;
    for i in 0..count {
        let e = &*entries.add(i);
        if e.path_len as usize == norm_len {
            if norm[..norm_len] == e.path[..norm_len] {
                return (true, placement, e.status);
            }
        }
    }
    (true, placement, STATUS_NONE)
}

unsafe fn normalise(raw: *const u16) -> ([u16; 260], usize) {
    let mut out = [0u16; 260];
    let mut len = 0usize;
    while len < 259 {
        let c = *raw.add(len);
        if c == 0 { break; }
        let c = if c == b'/' as u16 { b'\\' as u16 } else { c };
        out[len] = if (b'a' as u16..=b'z' as u16).contains(&c) { c - 32 } else { c };
        len += 1;
    }
    if len > 3 && out[len - 1] == b'\\' as u16 { out[len - 1] = 0; len -= 1; }
    (out, len)
}

// ── Icon directory resolution ─────────────────────────────────────────────────

unsafe fn get_icon_dir() -> String {
    // 1. Check HKCU\Software\Twin\Overlay\IconDir
    let subkey: Vec<u16> = "Software\\Twin\\Overlay\0".encode_utf16().collect();
    let mut hkey: HKEY = std::ptr::null_mut();
    if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) == 0 {
        let name: Vec<u16> = "IconDir\0".encode_utf16().collect();
        let mut buf = [0u16; 512];
        let mut sz = (buf.len() * 2) as u32;
        let mut rtype = 0u32;
        if RegQueryValueExW(hkey, name.as_ptr(), std::ptr::null_mut(), &mut rtype,
                            buf.as_mut_ptr() as _, &mut sz) == 0 && rtype == REG_SZ {
            let s = String::from_utf16_lossy(&buf).trim_matches('\0').trim().to_string();
            let _ = RegCloseKey(hkey);
            if !s.is_empty() { return s; }
        }
        let _ = RegCloseKey(hkey);
    }
    // 2. Relative to DLL
    let hmod = MODULE_HANDLE.load(Ordering::Relaxed) as HMODULE;
    let mut path = [0u16; 512];
    let len = GetModuleFileNameW(hmod, path.as_mut_ptr(), 512) as usize;
    if len > 0 {
        let full = String::from_utf16_lossy(&path[..len]);
        if let Some(parent) = std::path::Path::new(&full).parent() {
            for subdir in &["icons\\overlay", "overlay", ""] {
                let dir = if subdir.is_empty() { parent.to_path_buf() } else { parent.join(subdir) };
                if dir.join("synced_centered.ico").exists() {
                    return dir.to_string_lossy().into_owned();
                }
            }
        }
    }
    String::new()
}

/// Build the full path to the ICO file for the given status and placement.
unsafe fn ico_path(status: u32, placement: u32) -> Vec<u16> {
    let badge = match status {
        STATUS_SYNCED  => "synced",
        STATUS_SYNCING => "syncing",
        _              => return vec![0],
    };
    let place = match placement {
        1 => "bottom_right",
        2 => "centered",
        _ => "top_right",
    };
    let dir = get_icon_dir();
    let sep = if dir.ends_with('\\') || dir.ends_with('/') { "" } else { "\\" };
    let path = format!("{}{}{}_{}.ico\0", dir, sep, badge, place);
    path.encode_utf16().collect()
}

// ── IShellIconOverlayIdentifier VTable ───────────────────────────────────────

#[repr(C)]
pub struct IShellIconOverlayIdentifierVtbl {
    pub QueryInterface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    pub AddRef:         unsafe extern "system" fn(*mut c_void) -> u32,
    pub Release:        unsafe extern "system" fn(*mut c_void) -> u32,
    pub IsMemberOf:     unsafe extern "system" fn(*mut c_void, *const u16, u32) -> HRESULT,
    pub GetOverlayInfo: unsafe extern "system" fn(*mut c_void, *mut u16, i32, *mut i32, *mut u32) -> HRESULT,
    pub GetPriority:    unsafe extern "system" fn(*mut c_void, *mut i32) -> HRESULT,
}

#[repr(C)]
pub struct IClassFactoryVtbl {
    pub QueryInterface:  unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    pub AddRef:          unsafe extern "system" fn(*mut c_void) -> u32,
    pub Release:         unsafe extern "system" fn(*mut c_void) -> u32,
    pub CreateInstance:  unsafe extern "system" fn(*mut c_void, *mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    pub LockServer:      unsafe extern "system" fn(*mut c_void, BOOL) -> HRESULT,
}

// ── OverlayHandler object ─────────────────────────────────────────────────────

#[repr(C)]
pub struct OverlayHandler {
    pub vtbl:      *const IShellIconOverlayIdentifierVtbl,
    pub ref_count: AtomicUsize,
    pub is_synced: bool, // true = TwinSynced, false = TwinSyncing
}

#[repr(C)]
pub struct ClassFactory {
    pub vtbl:      *const IClassFactoryVtbl,
    pub ref_count: AtomicUsize,
    pub is_synced: bool,
}

// ── Static VTables ────────────────────────────────────────────────────────────

static OVERLAY_VTBL: IShellIconOverlayIdentifierVtbl = IShellIconOverlayIdentifierVtbl {
    QueryInterface: overlay_qi,
    AddRef:         overlay_addref,
    Release:        overlay_release,
    IsMemberOf:     overlay_is_member_of,
    GetOverlayInfo: overlay_get_overlay_info,
    GetPriority:    overlay_get_priority,
};

static CLASS_FACTORY_VTBL: IClassFactoryVtbl = IClassFactoryVtbl {
    QueryInterface: factory_qi,
    AddRef:         factory_addref,
    Release:        factory_release,
    CreateInstance: factory_create_instance,
    LockServer:     factory_lock_server,
};

// ── IShellIconOverlayIdentifier implementation ────────────────────────────────

unsafe extern "system" fn overlay_qi(
    this: *mut c_void, riid: *const GUID, ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() || riid.is_null() { return E_POINTER; }
    let g = *riid;
    if g == IID_IUNKNOWN || g == IID_ISHELL_ICON_OVERLAY_IDENTIFIER {
        *ppv = this;
        overlay_addref(this);
        S_OK
    } else {
        *ppv = std::ptr::null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn overlay_addref(this: *mut c_void) -> u32 {
    let obj = &*(this as *const OverlayHandler);
    obj.ref_count.fetch_add(1, Ordering::Relaxed) as u32 + 1
}

unsafe extern "system" fn overlay_release(this: *mut c_void) -> u32 {
    let obj = &*(this as *const OverlayHandler);
    let prev = obj.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        OBJECT_COUNT.fetch_sub(1, Ordering::Relaxed);
        let _ = Box::from_raw(this as *mut OverlayHandler);
        0
    } else { (prev - 1) as u32 }
}

/// IsMemberOf — called by the shell for every folder it renders.
/// Return S_OK if this folder should have OUR overlay, S_FALSE otherwise.
unsafe extern "system" fn overlay_is_member_of(
    this: *mut c_void, pwszPath: *const u16, _dwAttrib: u32,
) -> HRESULT {
    if pwszPath.is_null() { return S_FALSE; }
    let obj = &*(this as *const OverlayHandler);
    let (norm, norm_len) = normalise(pwszPath);
    if norm_len == 0 { return S_FALSE; }
    let (enabled, _placement, status) = lookup_folder(&norm, norm_len);
    if !enabled { return S_FALSE; }
    let matches = if obj.is_synced  { status == STATUS_SYNCED  }
                  else              { status == STATUS_SYNCING };
    if matches { S_OK } else { S_FALSE }
}

/// GetOverlayInfo — shell calls this once to get the ICO path for this overlay slot.
/// We return the placement-specific ICO file from the Icon-Pack directory.
unsafe extern "system" fn overlay_get_overlay_info(
    _this: *mut c_void,
    pwszIconFile: *mut u16, cchMax: i32,
    pIndex: *mut i32, pdwFlags: *mut u32,
) -> HRESULT {
    // Flags: ISIOI_ICONFILE=1 (we return a file path), ISIOI_ICONINDEX=2
    if !pdwFlags.is_null() { *pdwFlags = 1; }
    if !pIndex.is_null()   { *pIndex = 0; }

    // Read placement from shared memory (use current placement for this process)
    let placement = {
        let ptr = get_or_open_shmem();
        if ptr.is_null() { 0 }
        else {
            let hdr = &*(ptr as *const ShmemHeader);
            if hdr.magic == SHMEM_MAGIC { hdr.placement } else { 0 }
        }
    };

    // Pick icon file: synced vs syncing based on which handler this is
    // Because GetOverlayInfo is called once per slot, we look at the obj but _this is the
    // object — however for placement-specific ICO we don't yet know if synced or syncing.
    // The obj pointer gives us is_synced.
    let obj = &*(_this as *const OverlayHandler);
    let status = if obj.is_synced { STATUS_SYNCED } else { STATUS_SYNCING };

    let ico = ico_path(status, placement);

    if pwszIconFile.is_null() || cchMax <= 0 { return S_OK; }
    let copy_len = ico.len().min((cchMax as usize).saturating_sub(1));
    std::ptr::copy_nonoverlapping(ico.as_ptr(), pwszIconFile, copy_len);
    *pwszIconFile.add(copy_len) = 0;
    S_OK
}

unsafe extern "system" fn overlay_get_priority(
    _this: *mut c_void, pPriority: *mut i32,
) -> HRESULT {
    if !pPriority.is_null() { *pPriority = 0; } // 0 = highest priority
    S_OK
}

// ── IClassFactory implementation ──────────────────────────────────────────────

unsafe extern "system" fn factory_qi(
    this: *mut c_void, riid: *const GUID, ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() || riid.is_null() { return E_POINTER; }
    let g = *riid;
    if g == IID_IUNKNOWN || g == IID_ICLASSFACTORY {
        *ppv = this; factory_addref(this); S_OK
    } else { *ppv = std::ptr::null_mut(); E_NOINTERFACE }
}

unsafe extern "system" fn factory_addref(this: *mut c_void) -> u32 {
    let obj = &*(this as *const ClassFactory);
    obj.ref_count.fetch_add(1, Ordering::Relaxed) as u32 + 1
}

unsafe extern "system" fn factory_release(this: *mut c_void) -> u32 {
    let obj = &*(this as *const ClassFactory);
    let prev = obj.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        let _ = Box::from_raw(this as *mut ClassFactory);
        0
    } else { (prev - 1) as u32 }
}

unsafe extern "system" fn factory_create_instance(
    this: *mut c_void, pUnkOuter: *mut c_void,
    riid: *const GUID, ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() || riid.is_null() { return E_POINTER; }
    *ppv = std::ptr::null_mut();
    if !pUnkOuter.is_null() { return CLASS_E_NOAGGREGATION; }
    let factory = &*(this as *const ClassFactory);
    let obj = Box::new(OverlayHandler {
        vtbl:      &OVERLAY_VTBL,
        ref_count: AtomicUsize::new(1),
        is_synced: factory.is_synced,
    });
    OBJECT_COUNT.fetch_add(1, Ordering::Relaxed);
    let raw = Box::into_raw(obj) as *mut c_void;
    let hr = overlay_qi(raw, riid, ppv);
    overlay_release(raw);
    hr
}

unsafe extern "system" fn factory_lock_server(
    _this: *mut c_void, fLock: BOOL,
) -> HRESULT {
    if fLock != 0 { SERVER_LOCKS.fetch_add(1, Ordering::Relaxed); }
    else          { SERVER_LOCKS.fetch_sub(1, Ordering::Relaxed); }
    S_OK
}

// ── DLL exports ───────────────────────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "system" fn DllMain(
    hinstDLL: HMODULE, fdwReason: u32, _: *mut c_void,
) -> BOOL {
    if fdwReason == 1 /*DLL_PROCESS_ATTACH*/ {
        MODULE_HANDLE.store(hinstDLL as *mut c_void, Ordering::Relaxed);
    }
    1
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID, riid: *const GUID, ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() { return E_POINTER; }
    *ppv = std::ptr::null_mut();
    let clsid = *rclsid;
    let is_synced = if clsid == CLSID_TWIN_SYNCED       { true  }
                    else if clsid == CLSID_TWIN_SYNCING  { false }
                    else                                 { return 0x80040111_u32 as i32 /*CLASS_E_CLASSNOTAVAILABLE*/; };
    let factory = Box::new(ClassFactory {
        vtbl:      &CLASS_FACTORY_VTBL,
        ref_count: AtomicUsize::new(1),
        is_synced,
    });
    let raw = Box::into_raw(factory) as *mut c_void;
    let hr = factory_qi(raw, riid, ppv);
    factory_release(raw);
    hr
}

#[no_mangle]
pub unsafe extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECT_COUNT.load(Ordering::Relaxed) == 0
        && SERVER_LOCKS.load(Ordering::Relaxed) == 0 { S_OK } else { S_FALSE }
}

// ── Registry helpers ──────────────────────────────────────────────────────────

unsafe fn set_reg(root: HKEY, subkey: &str, name: Option<&str>, val: &str) -> bool {
    let sk: Vec<u16> = format!("{subkey}\0").encode_utf16().collect();
    let mut hk: HKEY = std::ptr::null_mut();
    if RegCreateKeyExW(root, sk.as_ptr(), 0, std::ptr::null_mut(),
                       REG_OPTION_NON_VOLATILE, KEY_WRITE, std::ptr::null_mut(),
                       &mut hk, std::ptr::null_mut()) != 0 { return false; }
    let data: Vec<u16> = format!("{val}\0").encode_utf16().collect();
    let nw: Option<Vec<u16>> = name.map(|n| format!("{n}\0").encode_utf16().collect());
    let np = nw.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null());
    let ok = RegSetValueExW(hk, np, 0, REG_SZ, data.as_ptr() as _, (data.len()*2) as u32) == 0;
    let _ = RegCloseKey(hk);
    ok
}

unsafe fn del_reg(root: HKEY, subkey: &str) {
    let sk: Vec<u16> = format!("{subkey}\0").encode_utf16().collect();
    let _ = RegDeleteKeyW(root, sk.as_ptr());
}

unsafe fn dll_path() -> String {
    let hmod = MODULE_HANDLE.load(Ordering::Relaxed) as HMODULE;
    let mut buf = [0u16; 512];
    let len = GetModuleFileNameW(hmod, buf.as_mut_ptr(), 512) as usize;
    if len > 0 { String::from_utf16_lossy(&buf[..len]) } else { String::new() }
}

#[no_mangle]
pub unsafe extern "system" fn DllRegisterServer() -> HRESULT {
    let dll = dll_path();
    let overlay_path = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";
    let approved    = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Approved";

    for (name_suffix, clsid_str, is_synced_str) in &[
        ("   TwinSynced",  "{9B46E711-2051-417A-8D52-19253DE6C7D1}", "Twin Synced Folder Overlay"),
        ("   TwinSyncing", "{9B46E712-2051-417A-8D52-19253DE6C7D2}", "Twin Syncing Folder Overlay"),
    ] {
        // ShellIconOverlayIdentifiers entry
        let ol_key = format!("{overlay_path}\\{name_suffix}");
        set_reg(HKEY_LOCAL_MACHINE, &ol_key, None, clsid_str);

        // CLSID InprocServer32
        let clsid_key = format!("SOFTWARE\\Classes\\CLSID\\{clsid_str}");
        set_reg(HKEY_LOCAL_MACHINE, &clsid_key, None, is_synced_str);
        set_reg(HKEY_LOCAL_MACHINE, &format!("{clsid_key}\\InprocServer32"), None, &dll);
        set_reg(HKEY_LOCAL_MACHINE, &format!("{clsid_key}\\InprocServer32"), Some("ThreadingModel"), "Apartment");

        // Approved shell extension whitelist
        let sk: Vec<u16> = format!("{approved}\0").encode_utf16().collect();
        let mut hk: HKEY = std::ptr::null_mut();
        if RegCreateKeyExW(HKEY_LOCAL_MACHINE, sk.as_ptr(), 0, std::ptr::null_mut(),
                           REG_OPTION_NON_VOLATILE, KEY_WRITE, std::ptr::null_mut(),
                           &mut hk, std::ptr::null_mut()) == 0 {
            let name: Vec<u16> = format!("{clsid_str}\0").encode_utf16().collect();
            let val: Vec<u16> = format!("{is_synced_str}\0").encode_utf16().collect();
            let _ = RegSetValueExW(hk, name.as_ptr(), 0, REG_SZ,
                                   val.as_ptr() as _, (val.len()*2) as u32);
            let _ = RegCloseKey(hk);
        }
    }

    // Also clean up old IExtractIcon IconHandler keys if present
    del_reg(HKEY_LOCAL_MACHINE, "SOFTWARE\\Classes\\Directory\\shellex\\IconHandler");
    del_reg(HKEY_LOCAL_MACHINE, "SOFTWARE\\Classes\\Folder\\shellex\\IconHandler");
    del_reg(HKEY_LOCAL_MACHINE, "SOFTWARE\\Classes\\CLSID\\{9B46E713-2051-417A-8D52-19253DE6C7D3}\\InprocServer32");
    del_reg(HKEY_LOCAL_MACHINE, "SOFTWARE\\Classes\\CLSID\\{9B46E713-2051-417A-8D52-19253DE6C7D3}");

    S_OK
}

#[no_mangle]
pub unsafe extern "system" fn DllUnregisterServer() -> HRESULT {
    let overlay_path = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";
    let approved    = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Approved";

    for (name_suffix, clsid_str) in &[
        ("   TwinSynced",  "{9B46E711-2051-417A-8D52-19253DE6C7D1}"),
        ("   TwinSyncing", "{9B46E712-2051-417A-8D52-19253DE6C7D2}"),
    ] {
        del_reg(HKEY_LOCAL_MACHINE, &format!("{overlay_path}\\{name_suffix}"));
        del_reg(HKEY_LOCAL_MACHINE, &format!("SOFTWARE\\Classes\\CLSID\\{clsid_str}\\InprocServer32"));
        del_reg(HKEY_LOCAL_MACHINE, &format!("SOFTWARE\\Classes\\CLSID\\{clsid_str}"));
    }
    S_OK
}
