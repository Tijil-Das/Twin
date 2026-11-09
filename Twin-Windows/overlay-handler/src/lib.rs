//! Twin Windows Explorer Shell Icon Overlay Extension
//! Implements IShellIconOverlayIdentifier for "synced" (green checkmark) and "syncing" (yellow badge).
//! Zero disk/network I/O in IsMemberOf via shared memory cache.

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};

use windows_sys::Win32::Foundation::{
    BOOL, FALSE, HANDLE, HMODULE, INVALID_HANDLE_VALUE, S_FALSE, S_OK, TRUE, CloseHandle,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};

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

pub type HRESULT = i32;

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct GUID {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

pub const E_NOINTERFACE: HRESULT = 0x80004002_u32 as i32;
pub const E_POINTER: HRESULT = 0x80004003_u32 as i32;
pub const E_FAIL: HRESULT = 0x80004005_u32 as i32;
pub const CLASS_E_NOAGGREGATION: HRESULT = 0x80040110_u32 as i32;

// ISIOI flags
pub const ISIOI_ICONFILE: u32 = 0x00000001;
pub const ISIOI_ICONINDEX: u32 = 0x00000002;

// GUIDs
// {9B46E711-2051-417A-8D52-19253DE6C7D1}
pub const CLSID_TWIN_SYNCED: GUID = GUID {
    data1: 0x9B46E711,
    data2: 0x2051,
    data3: 0x417A,
    data4: [0x8D, 0x52, 0x19, 0x25, 0x3D, 0xE6, 0xC7, 0xD1],
};

// {9B46E712-2051-417A-8D52-19253DE6C7D2}
pub const CLSID_TWIN_SYNCING: GUID = GUID {
    data1: 0x9B46E712,
    data2: 0x2051,
    data3: 0x417A,
    data4: [0x8D, 0x52, 0x19, 0x25, 0x3D, 0xE6, 0xC7, 0xD2],
};

pub const IID_IUNKNOWN: GUID = GUID {
    data1: 0x00000000,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

pub const IID_ICLASSFACTORY: GUID = GUID {
    data1: 0x00000001,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

// {0C6C4200-C589-11D0-999A-00C04FD655E1}
pub const IID_ISHELLICONOVERLAYIDENTIFIER: GUID = GUID {
    data1: 0x0C6C4200,
    data2: 0xC589,
    data3: 0x11D0,
    data4: [0x99, 0x9A, 0x00, 0xC0, 0x4F, 0xD6, 0x55, 0xE1],
};

#[derive(Copy, Clone, PartialEq, Eq)]
pub enum OverlayKind {
    Synced,
    Syncing,
}

// ── Shared Memory Protocol ────────────────────────────────────────────────────

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

static SHMEM_VIEW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static MODULE_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static OBJECT_COUNT: AtomicUsize = AtomicUsize::new(0);
static SERVER_LOCKS: AtomicUsize = AtomicUsize::new(0);

// Wide null-terminated string for "Local\Twin_Overlay_SharedMemory_v1"
const SHMEM_NAME_W: &[u16] = &[
    b'L' as u16, b'o' as u16, b'c' as u16, b'a' as u16, b'l' as u16, b'\\' as u16,
    b'T' as u16, b'w' as u16, b'i' as u16, b'n' as u16, b'_' as u16, b'O' as u16,
    b'v' as u16, b'e' as u16, b'r' as u16, b'l' as u16, b'a' as u16, b'y' as u16,
    b'_' as u16, b'S' as u16, b'h' as u16, b'a' as u16, b'r' as u16, b'e' as u16,
    b'd' as u16, b'M' as u16, b'e' as u16, b'm' as u16, b'o' as u16, b'r' as u16,
    b'y' as u16, b'_' as u16, b'v' as u16, b'1' as u16, 0,
];

unsafe fn get_or_open_shmem() -> *mut c_void {
    let mut ptr = SHMEM_VIEW.load(Ordering::Acquire);
    if !ptr.is_null() {
        return ptr;
    }

    let h_map: HANDLE = OpenFileMappingW(FILE_MAP_READ, FALSE, SHMEM_NAME_W.as_ptr());
    if h_map == std::ptr::null_mut() || h_map == INVALID_HANDLE_VALUE {
        return std::ptr::null_mut();
    }

    let mapped = MapViewOfFile(h_map, FILE_MAP_READ, 0, 0, 0);
    ptr = mapped.Value as *mut c_void;
    let _ = CloseHandle(h_map);

    if !ptr.is_null() {
        SHMEM_VIEW.store(ptr, Ordering::Release);
    }
    ptr
}

// ── IShellIconOverlayIdentifier COM Vtbl ──────────────────────────────────────

#[repr(C)]
pub struct IShellIconOverlayIdentifierVtbl {
    pub QueryInterface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> HRESULT,
    pub AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub Release: unsafe extern "system" fn(this: *mut c_void) -> u32,

    pub IsMemberOf: unsafe extern "system" fn(
        this: *mut c_void,
        pwszPath: *const u16,
        dwAttrib: u32,
    ) -> HRESULT,
    pub GetOverlayInfo: unsafe extern "system" fn(
        this: *mut c_void,
        pwszIconFile: *mut u16,
        cchMax: i32,
        pIndex: *mut i32,
        pdwFlags: *mut u32,
    ) -> HRESULT,
    pub GetPriority: unsafe extern "system" fn(this: *mut c_void, pPriority: *mut i32) -> HRESULT,
}

#[repr(C)]
pub struct ShellIconOverlayIdentifier {
    pub vtbl: *const IShellIconOverlayIdentifierVtbl,
    pub ref_count: AtomicUsize,
    pub kind: OverlayKind,
}

// ── IClassFactory COM Vtbl ────────────────────────────────────────────────────

#[repr(C)]
pub struct IClassFactoryVtbl {
    pub QueryInterface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> HRESULT,
    pub AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub Release: unsafe extern "system" fn(this: *mut c_void) -> u32,

    pub CreateInstance: unsafe extern "system" fn(
        this: *mut c_void,
        _pUnkOuter: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> HRESULT,
    pub LockServer: unsafe extern "system" fn(this: *mut c_void, fLock: BOOL) -> HRESULT,
}

#[repr(C)]
pub struct ClassFactory {
    pub vtbl: *const IClassFactoryVtbl,
    pub ref_count: AtomicUsize,
    pub kind: OverlayKind,
}

// ── Overlay Identifier Implementation ─────────────────────────────────────────

static OVERLAY_VTBL: IShellIconOverlayIdentifierVtbl = IShellIconOverlayIdentifierVtbl {
    QueryInterface: overlay_query_interface,
    AddRef: overlay_add_ref,
    Release: overlay_release,
    IsMemberOf: overlay_is_member_of,
    GetOverlayInfo: overlay_get_overlay_info,
    GetPriority: overlay_get_priority,
};

fn format_guid(g: &GUID) -> String {
    format!(
        "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        g.data1, g.data2, g.data3, g.data4[0], g.data4[1], g.data4[2], g.data4[3], g.data4[4], g.data4[5], g.data4[6], g.data4[7]
    )
}

unsafe extern "system" fn overlay_query_interface(
    this: *mut c_void,
    riid: *const GUID,
    ppvObject: *mut *mut c_void,
) -> HRESULT {
    if ppvObject.is_null() || riid.is_null() {
        return E_POINTER;
    }
    let guid = *riid;
    let guid_str = format_guid(&guid);
    if guid == IID_IUNKNOWN || guid == IID_ISHELLICONOVERLAYIDENTIFIER {
        log_debug(&format!("overlay_query_interface matched: {}", guid_str));
        *ppvObject = this;
        overlay_add_ref(this);
        S_OK
    } else {
        log_debug(&format!("overlay_query_interface UNMATCHED: {}", guid_str));
        *ppvObject = std::ptr::null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn overlay_add_ref(this: *mut c_void) -> u32 {
    let obj = &*(this as *const ShellIconOverlayIdentifier);
    obj.ref_count.fetch_add(1, Ordering::Relaxed) as u32 + 1
}

unsafe extern "system" fn overlay_release(this: *mut c_void) -> u32 {
    let obj = &*(this as *const ShellIconOverlayIdentifier);
    let prev = obj.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        OBJECT_COUNT.fetch_sub(1, Ordering::Relaxed);
        let _ = Box::from_raw(this as *mut ShellIconOverlayIdentifier);
        0
    } else {
        (prev - 1) as u32
    }
}

unsafe extern "system" fn overlay_is_member_of(
    this: *mut c_void,
    pwszPath: *const u16,
    dwAttrib: u32,
) -> HRESULT {
    if pwszPath.is_null() {
        return S_FALSE;
    }

    // Overlay is intended for folders: if attributes are known and object is explicitly a file, skip
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x00000010;
    if dwAttrib != 0 && (dwAttrib & FILE_ATTRIBUTE_DIRECTORY) == 0 {
        return S_FALSE;
    }

    let ptr = get_or_open_shmem();
    if ptr.is_null() {
        return S_FALSE;
    }

    let header = &*(ptr as *const ShmemHeader);
    if header.magic != SHMEM_MAGIC {
        SHMEM_VIEW.store(std::ptr::null_mut(), Ordering::Release);
        return S_FALSE;
    }
    if header.enabled == 0 {
        return S_FALSE;
    }

    let count = (header.count as usize).min(256);
    if count == 0 {
        return S_FALSE;
    }

    // Measure length of incoming path & normalize to uppercase with backslashes
    let mut norm: [u16; 260] = [0; 260];
    let mut len = 0;
    while len < 259 {
        let ch = *pwszPath.add(len);
        if ch == 0 {
            break;
        }
        let ch = if ch == b'/' as u16 { b'\\' as u16 } else { ch };
        // ASCII uppercase
        let upper_ch = if (b'a' as u16..=b'z' as u16).contains(&ch) {
            ch - 32
        } else {
            ch
        };
        norm[len] = upper_ch;
        len += 1;
    }

    // Strip trailing backslash unless it's drive root e.g. "C:\"
    if len > 3 && norm[len - 1] == b'\\' as u16 {
        norm[len - 1] = 0;
        len -= 1;
    } else {
        norm[len] = 0;
    }

    let entries_ptr = (ptr as *const u8).add(std::mem::size_of::<ShmemHeader>()) as *const ShmemEntry;
    let obj = &*(this as *const ShellIconOverlayIdentifier);

    // Only mark the pair parent folder: require exact path match
    for i in 0..count {
        let entry = &*entries_ptr.add(i);
        let entry_len = entry.path_len as usize;

        if entry_len == len {
            let mut matches = true;
            for j in 0..len {
                if norm[j] != entry.path[j] {
                    matches = false;
                    break;
                }
            }
            if matches {
                let path_s = String::from_utf16_lossy(&norm[..len]);
                log_debug(&format!("IsMemberOf MATCH: path='{}' entry.status={}", path_s, entry.status));
                return match obj.kind {
                    OverlayKind::Syncing => {
                        if (entry.status & STATUS_SYNCING) != 0 {
                            S_OK
                        } else {
                            S_FALSE
                        }
                    }
                    OverlayKind::Synced => {
                        if (entry.status & STATUS_SYNCING) == 0 && (entry.status & STATUS_SYNCED) != 0 {
                            S_OK
                        } else {
                            S_FALSE
                        }
                    }
                };
            }
        }
    }

    S_FALSE
}

unsafe extern "system" fn overlay_get_overlay_info(
    this: *mut c_void,
    pwszIconFile: *mut u16,
    cchMax: i32,
    pIndex: *mut i32,
    pdwFlags: *mut u32,
) -> HRESULT {
    if pwszIconFile.is_null() || pIndex.is_null() || pdwFlags.is_null() || cchMax <= 0 {
        return E_POINTER;
    }

    *pIndex = 0;
    *pdwFlags = ISIOI_ICONFILE | ISIOI_ICONINDEX;

    let obj = &*(this as *const ShellIconOverlayIdentifier);

    // Read placement and icon directory from registry, or fallback to DLL folder
    let (placement, icon_dir) = read_overlay_config();

    let prefix = match obj.kind {
        OverlayKind::Synced => "synced",
        OverlayKind::Syncing => "syncing",
    };

    let filename = format!("folder_{}_{}.ico", prefix, placement);

let ends_with_bs = icon_dir.as_bytes().ends_with(&[0x5C]);
let ends_with_sl = icon_dir.as_bytes().ends_with(&[0x2F]);
let sep = if ends_with_bs || ends_with_sl { "" } else { "\\" };
    let candidate = format!("{}{}{}", icon_dir, sep, filename);
    let full_path = if std::path::Path::new(&candidate).exists() {
        candidate
    } else {
        format!("{}{}{}.ico", icon_dir, sep, prefix)
    };
    log_debug(&format!("GetOverlayInfo for kind={:?}: full_path='{}'", prefix, full_path));

    let mut out_len = 0;
    for ch in full_path.encode_utf16() {
        if out_len >= (cchMax - 1) as usize {
            break;
        }
        *pwszIconFile.add(out_len) = ch;
        out_len += 1;
    }
    *pwszIconFile.add(out_len) = 0;

    S_OK
}

unsafe extern "system" fn overlay_get_priority(
    _this: *mut c_void,
    pPriority: *mut i32,
) -> HRESULT {
    if pPriority.is_null() {
        return E_POINTER;
    }
    // Highest priority for shell overlay slots
    *pPriority = 0;
    S_OK
}

// ── Registry / Config Helper ──────────────────────────────────────────────────

fn read_overlay_config() -> (String, String) {
    let mut placement = "top_right".to_string();
    let mut icon_dir = String::new();

    unsafe {
        let subkey: Vec<u16> = "Software\\Twin\\Overlay\0".encode_utf16().collect();
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) == 0 {
            // Read Placement
            let name_placement: Vec<u16> = "Placement\0".encode_utf16().collect();
            let mut buf = [0u16; 64];
            let mut buf_bytes = (buf.len() * 2) as u32;
            let mut reg_type = 0;
            if RegQueryValueExW(
                hkey,
                name_placement.as_ptr(),
                std::ptr::null_mut(),
                &mut reg_type,
                buf.as_mut_ptr() as _,
                &mut buf_bytes,
            ) == 0 && reg_type == REG_SZ {
                let s = String::from_utf16_lossy(&buf);
                let trimmed = s.trim_matches(char::from(0)).trim();
                if !trimmed.is_empty() {
                    placement = trimmed.to_string();
                }
            }

            // Read IconDir
            let name_icondir: Vec<u16> = "IconDir\0".encode_utf16().collect();
            let mut dir_buf = [0u16; 512];
            let mut dir_bytes = (dir_buf.len() * 2) as u32;
            if RegQueryValueExW(
                hkey,
                name_icondir.as_ptr(),
                std::ptr::null_mut(),
                &mut reg_type,
                dir_buf.as_mut_ptr() as _,
                &mut dir_bytes,
            ) == 0 && reg_type == REG_SZ {
                let s = String::from_utf16_lossy(&dir_buf);
                let trimmed = s.trim_matches(char::from(0)).trim();
                if !trimmed.is_empty() {
                    icon_dir = trimmed.to_string();
                }
            }

            let _ = RegCloseKey(hkey);
        }

        // If icon_dir not in registry, look in directory of the DLL
        if icon_dir.is_empty() {
            let hmod = MODULE_HANDLE.load(Ordering::Relaxed) as HMODULE;
            let mut mod_path = [0u16; 512];
            let len = GetModuleFileNameW(hmod, mod_path.as_mut_ptr(), 512) as usize;
            if len > 0 {
                let full = String::from_utf16_lossy(&mod_path[..len]);
                if let Some(parent) = std::path::Path::new(&full).parent() {
                    let overlay_subdir = parent.join("icons").join("overlay");
                    if overlay_subdir.exists() {
                        icon_dir = overlay_subdir.to_string_lossy().to_string();
                    } else {
                        icon_dir = parent.to_string_lossy().to_string();
                    }
                }
            }
        }
    }

    (placement, icon_dir)
}

// ── Class Factory Implementation ──────────────────────────────────────────────

static CLASS_FACTORY_VTBL: IClassFactoryVtbl = IClassFactoryVtbl {
    QueryInterface: factory_query_interface,
    AddRef: factory_add_ref,
    Release: factory_release,
    CreateInstance: factory_create_instance,
    LockServer: factory_lock_server,
};

unsafe extern "system" fn factory_query_interface(
    this: *mut c_void,
    riid: *const GUID,
    ppvObject: *mut *mut c_void,
) -> HRESULT {
    if ppvObject.is_null() || riid.is_null() {
        return E_POINTER;
    }
    let guid = *riid;
    if guid == IID_IUNKNOWN || guid == IID_ICLASSFACTORY {
        *ppvObject = this;
        factory_add_ref(this);
        S_OK
    } else {
        *ppvObject = std::ptr::null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn factory_add_ref(this: *mut c_void) -> u32 {
    let obj = &*(this as *const ClassFactory);
    obj.ref_count.fetch_add(1, Ordering::Relaxed) as u32 + 1
}

unsafe extern "system" fn factory_release(this: *mut c_void) -> u32 {
    let obj = &*(this as *const ClassFactory);
    let prev = obj.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        OBJECT_COUNT.fetch_sub(1, Ordering::Relaxed);
        let _ = Box::from_raw(this as *mut ClassFactory);
        0
    } else {
        (prev - 1) as u32
    }
}

unsafe extern "system" fn factory_create_instance(
    this: *mut c_void,
    _pUnkOuter: *mut c_void,
    riid: *const GUID,
    ppvObject: *mut *mut c_void,
) -> HRESULT {
    if ppvObject.is_null() || riid.is_null() {
        return E_POINTER;
    }
    *ppvObject = std::ptr::null_mut();

    let riid_str = format_guid(&*riid);
    log_debug(&format!("factory_create_instance called with riid={}", riid_str));

    let factory = &*(this as *const ClassFactory);
    let instance = Box::new(ShellIconOverlayIdentifier {
        vtbl: &OVERLAY_VTBL,
        ref_count: AtomicUsize::new(1),
        kind: factory.kind,
    });
    OBJECT_COUNT.fetch_add(1, Ordering::Relaxed);

    let raw = Box::into_raw(instance) as *mut c_void;
    let hr = overlay_query_interface(raw, riid, ppvObject);
    overlay_release(raw);
    hr
}

unsafe extern "system" fn factory_lock_server(_this: *mut c_void, fLock: BOOL) -> HRESULT {
    if fLock == TRUE {
        SERVER_LOCKS.fetch_add(1, Ordering::Relaxed);
    } else {
        SERVER_LOCKS.fetch_sub(1, Ordering::Relaxed);
    }
    S_OK
}

#[inline]
fn log_debug(_msg: &str) {
    // Debug logging disabled for production performance
}

// ── Exported DLL Functions ────────────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "system" fn DllMain(
    hinstDLL: HMODULE,
    fdwReason: u32,
    _lpReserved: *mut c_void,
) -> BOOL {
    const DLL_PROCESS_ATTACH: u32 = 1;
    const DLL_PROCESS_DETACH: u32 = 0;

    if fdwReason == DLL_PROCESS_ATTACH {
        MODULE_HANDLE.store(hinstDLL as _, Ordering::Relaxed);
        log_debug("DllMain DLL_PROCESS_ATTACH");
    } else if fdwReason == DLL_PROCESS_DETACH {
        log_debug("DllMain DLL_PROCESS_DETACH");
        let ptr = SHMEM_VIEW.swap(std::ptr::null_mut(), Ordering::AcqRel);
        if !ptr.is_null() {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: ptr });
        }
    }
    TRUE
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    let clsid_str = if !rclsid.is_null() { format_guid(&*rclsid) } else { "null".into() };
    let riid_str = if !riid.is_null() { format_guid(&*riid) } else { "null".into() };
    log_debug(&format!("DllGetClassObject clsid={} riid={}", clsid_str, riid_str));
    if rclsid.is_null() || riid.is_null() || ppv.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();

    let clsid = *rclsid;
    let kind = if clsid == CLSID_TWIN_SYNCED {
        OverlayKind::Synced
    } else if clsid == CLSID_TWIN_SYNCING {
        OverlayKind::Syncing
    } else {
        return E_FAIL;
    };

    let factory = Box::new(ClassFactory {
        vtbl: &CLASS_FACTORY_VTBL,
        ref_count: AtomicUsize::new(1),
        kind,
    });
    OBJECT_COUNT.fetch_add(1, Ordering::Relaxed);

    let raw = Box::into_raw(factory) as *mut c_void;
    let hr = factory_query_interface(raw, riid, ppv);
    factory_release(raw);
    hr
}

#[no_mangle]
pub unsafe extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECT_COUNT.load(Ordering::Relaxed) == 0 && SERVER_LOCKS.load(Ordering::Relaxed) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

// Helper to set a registry string value
unsafe fn set_reg_str(root: HKEY, subkey: &str, value_name: Option<&str>, data: &str) -> bool {
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

unsafe fn del_reg_key(root: HKEY, subkey: &str) -> bool {
    let subkey_w: Vec<u16> = format!("{subkey}\0").encode_utf16().collect();
    RegDeleteKeyW(root, subkey_w.as_ptr()) == 0
}

#[no_mangle]
pub unsafe extern "system" fn DllRegisterServer() -> HRESULT {
    let hmod = MODULE_HANDLE.load(Ordering::Relaxed) as HMODULE;
    let mut mod_path = [0u16; 512];
    let len = GetModuleFileNameW(hmod, mod_path.as_mut_ptr(), 512) as usize;
    if len == 0 {
        return E_FAIL;
    }
    let dll_path = String::from_utf16_lossy(&mod_path[..len]);

    let synced_clsid_str = "{9B46E711-2051-417A-8D52-19253DE6C7D1}";
    let syncing_clsid_str = "{9B46E712-2051-417A-8D52-19253DE6C7D2}";

    // Register CLSIDs in HKLM and HKCU
    for &root in &[HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        // 1. Synced CLSID
        let clsid_key = format!("SOFTWARE\\Classes\\CLSID\\{synced_clsid_str}");
        set_reg_str(root, &clsid_key, None, "Twin Synced Icon Overlay");
        set_reg_str(root, &format!("{clsid_key}\\InprocServer32"), None, &dll_path);
        set_reg_str(root, &format!("{clsid_key}\\InprocServer32"), Some("ThreadingModel"), "Apartment");

        // 2. Syncing CLSID
        let syncing_key = format!("SOFTWARE\\Classes\\CLSID\\{syncing_clsid_str}");
        set_reg_str(root, &syncing_key, None, "Twin Syncing Icon Overlay");
        set_reg_str(root, &format!("{syncing_key}\\InprocServer32"), None, &dll_path);
        set_reg_str(root, &format!("{syncing_key}\\InprocServer32"), Some("ThreadingModel"), "Apartment");

        // 3. ShellIconOverlayIdentifiers with 3 leading spaces for sorting priority in Windows 15-overlay limit
        let shell_overlays = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";
        set_reg_str(root, &format!("{shell_overlays}\\   TwinSynced"), None, synced_clsid_str);
        set_reg_str(root, &format!("{shell_overlays}\\   TwinSyncing"), None, syncing_clsid_str);
    }

    S_OK
}

#[no_mangle]
pub unsafe extern "system" fn DllUnregisterServer() -> HRESULT {
    let synced_clsid_str = "{9B46E711-2051-417A-8D52-19253DE6C7D1}";
    let syncing_clsid_str = "{9B46E712-2051-417A-8D52-19253DE6C7D2}";

    for &root in &[HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let shell_overlays = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";
        del_reg_key(root, &format!("{shell_overlays}\\   TwinSynced"));
        del_reg_key(root, &format!("{shell_overlays}\\   TwinSyncing"));

        del_reg_key(root, &format!("SOFTWARE\\Classes\\CLSID\\{synced_clsid_str}\\InprocServer32"));
        del_reg_key(root, &format!("SOFTWARE\\Classes\\CLSID\\{synced_clsid_str}"));

        del_reg_key(root, &format!("SOFTWARE\\Classes\\CLSID\\{syncing_clsid_str}\\InprocServer32"));
        del_reg_key(root, &format!("SOFTWARE\\Classes\\CLSID\\{syncing_clsid_str}"));
    }

    S_OK
}
