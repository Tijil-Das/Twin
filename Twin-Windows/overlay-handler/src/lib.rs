//! Twin Windows Explorer Folder Icon Handler
//! Implements IExtractIcon + IPersistFile as a Directory shellex/IconHandler.
//! This allows compositing a sync status badge at ANY position (top-right, bottom-right, center)
//! on the native Windows 11 folder icon — bypassing IShellIconOverlayIdentifier's forced lower-left.
//!
//! Architecture:
//!   - Registered under HKCR\Directory\shellex\IconHandler → {CLSID_TWIN_ICON_HANDLER}
//!   - GetIconLocation returns GIL_NOTFILENAME | GIL_PERINSTANCE so the shell calls Extract()
//!   - Extract() calls SHGetStockIconInfo(SIID_FOLDER) for the native W11 folder icon,
//!     composites the badge onto a DIB at the user-configured corner, returns HICON
//!   - Folders not in shared memory get S_FALSE so shell uses default icon unchanged
//!   - Shared memory layout (read-only): ShmemHeader + ShmemEntry[count]

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};

use windows_sys::Win32::Foundation::{
    BOOL, FALSE, HANDLE, HMODULE, INVALID_HANDLE_VALUE, S_FALSE, S_OK, TRUE,
    CloseHandle,
};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    CreateBitmap, GetDC, ReleaseDC,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ,
    MEMORY_MAPPED_VIEW_ADDRESS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_CLASSES_ROOT,
    KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::UI::Shell::{
    SHGetStockIconInfo, SHGSI_ICON, SHGSI_LARGEICON, SHGSI_SMALLICON,
    SHSTOCKICONINFO, SIID_FOLDER,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateIconIndirect, DestroyIcon, DrawIconEx, DI_NORMAL, HICON, ICONINFO,
    GetSystemMetrics, SM_CXICON, SM_CXSMICON,
    LoadImageW, LR_LOADFROMFILE, IMAGE_ICON,
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

// GIL flags for GetIconLocation
pub const GIL_NOTFILENAME: u32 = 0x0008;  // We supply HICON directly via Extract()
pub const GIL_PERINSTANCE: u32 = 0x0004;  // Icon can differ per folder instance
pub const GIL_DONTCACHE: u32 = 0x0010;   // Don't cache — force re-extract on SHChangeNotify

// {9B46E713-2051-417A-8D52-19253DE6C7D3} — IExtractIcon IconHandler
pub const CLSID_TWIN_ICON_HANDLER: GUID = GUID {
    data1: 0x9B46E713,
    data2: 0x2051,
    data3: 0x417A,
    data4: [0x8D, 0x52, 0x19, 0x25, 0x3D, 0xE6, 0xC7, 0xD3],
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

// {000214FA-0000-0000-C000-000000000046} IExtractIconW
pub const IID_IEXTRACTICONW: GUID = GUID {
    data1: 0x000214FA,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

// {0000010B-0000-0000-C000-000000000046} IPersistFile
pub const IID_IPERSISTFILE: GUID = GUID {
    data1: 0x0000010B,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

// {0000010C-0000-0000-C000-000000000046} IPersist (parent of IPersistFile)
pub const IID_IPERSIST: GUID = GUID {
    data1: 0x0000010C,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

// ── Shared Memory Protocol (same as before) ───────────────────────────────────

pub const SHMEM_MAGIC: u32 = 0x5457494E; // 'TWIN'
pub const STATUS_NONE: u32 = 0;
pub const STATUS_SYNCED: u32 = 1;
pub const STATUS_SYNCING: u32 = 2;

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

/// Look up folder path in shared memory. Returns (enabled, placement, status).
/// placement: 0=top_right, 1=bottom_right, 2=centered
/// status: STATUS_NONE, STATUS_SYNCED, STATUS_SYNCING
unsafe fn lookup_folder_status(norm_path: &[u16], norm_len: usize) -> (bool, u32, u32) {
    let ptr = get_or_open_shmem();
    if ptr.is_null() {
        return (false, 0, STATUS_NONE);
    }

    let header = &*(ptr as *const ShmemHeader);
    if header.magic != SHMEM_MAGIC {
        SHMEM_VIEW.store(std::ptr::null_mut(), Ordering::Release);
        return (false, 0, STATUS_NONE);
    }
    if header.enabled == 0 {
        return (false, header.placement, STATUS_NONE);
    }

    let count = (header.count as usize).min(256);
    let placement = header.placement;

    if count == 0 {
        return (true, placement, STATUS_NONE);
    }

    let entries_ptr =
        (ptr as *const u8).add(std::mem::size_of::<ShmemHeader>()) as *const ShmemEntry;

    for i in 0..count {
        let entry = &*entries_ptr.add(i);
        let entry_len = entry.path_len as usize;
        if entry_len == norm_len {
            let mut matches = true;
            for j in 0..norm_len {
                if norm_path[j] != entry.path[j] {
                    matches = false;
                    break;
                }
            }
            if matches {
                return (true, placement, entry.status);
            }
        }
    }

    (true, placement, STATUS_NONE)
}

/// Normalize a wide path to uppercase with backslashes, stripped of trailing backslash (unless drive root).
unsafe fn normalize_path_w(raw: *const u16) -> ([u16; 260], usize) {
    let mut norm = [0u16; 260];
    let mut len = 0usize;
    while len < 259 {
        let ch = *raw.add(len);
        if ch == 0 {
            break;
        }
        let ch = if ch == b'/' as u16 { b'\\' as u16 } else { ch };
        let upper = if (b'a' as u16..=b'z' as u16).contains(&ch) {
            ch - 32
        } else {
            ch
        };
        norm[len] = upper;
        len += 1;
    }
    // Strip trailing backslash unless drive root (e.g. "C:\")
    if len > 3 && norm[len - 1] == b'\\' as u16 {
        norm[len - 1] = 0;
        len -= 1;
    } else {
        norm[len] = 0;
    }
    (norm, len)
}

// ── Badge icon compositing ────────────────────────────────────────────────────

/// Get the native Windows folder HICON at the given size using SHGetStockIconInfo.
unsafe fn get_stock_folder_icon(size: i32) -> HICON {
    let mut sii: SHSTOCKICONINFO = std::mem::zeroed();
    sii.cbSize = std::mem::size_of::<SHSTOCKICONINFO>() as u32;

    let flags = SHGSI_ICON | if size <= 20 { SHGSI_SMALLICON } else { SHGSI_LARGEICON };
    let hr = SHGetStockIconInfo(SIID_FOLDER, flags, &mut sii);
    if hr == S_OK && !sii.hIcon.is_null() {
        sii.hIcon
    } else {
        std::ptr::null_mut()
    }
}

/// Get the overlay icons directory.
unsafe fn get_icon_dir() -> String {
    // First check registry HKCU\Software\Twin\Overlay\IconDir
    let subkey: Vec<u16> = "Software\\Twin\\Overlay\0".encode_utf16().collect();
    let mut hkey: HKEY = std::ptr::null_mut();
    if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) == 0 {
        let name: Vec<u16> = "IconDir\0".encode_utf16().collect();
        let mut buf = [0u16; 512];
        let mut buf_bytes = (buf.len() * 2) as u32;
        let mut reg_type = 0u32;
        if RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut reg_type,
            buf.as_mut_ptr() as _,
            &mut buf_bytes,
        ) == 0 && reg_type == REG_SZ {
            let s = String::from_utf16_lossy(&buf);
            let trimmed = s.trim_matches('\0').trim().to_string();
            let _ = RegCloseKey(hkey);
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
        let _ = RegCloseKey(hkey);
    }

    // Fall back to DLL directory / icons / overlay
    let hmod = MODULE_HANDLE.load(Ordering::Relaxed) as HMODULE;
    let mut mod_path = [0u16; 512];
    let len = GetModuleFileNameW(hmod, mod_path.as_mut_ptr(), 512) as usize;
    if len > 0 {
        let full = String::from_utf16_lossy(&mod_path[..len]);
        if let Some(parent) = std::path::Path::new(&full).parent() {
            let overlay_dir = parent.join("icons").join("overlay");
            if overlay_dir.exists() {
                return overlay_dir.to_string_lossy().into_owned();
            }
            return parent.to_string_lossy().into_owned();
        }
    }

    String::new()
}

/// Load badge HICON from the overlay icons directory.
unsafe fn load_badge_icon(badge_name: &str, size: i32) -> HICON {
    let icon_dir = get_icon_dir();
    if icon_dir.is_empty() {
        return std::ptr::null_mut();
    }

    let sep = if icon_dir.ends_with('\\') || icon_dir.ends_with('/') { "" } else { "\\" };
    let ico_path = format!("{}{}{}.ico\0", icon_dir, sep, badge_name);
    let wide: Vec<u16> = ico_path.encode_utf16().collect();

    LoadImageW(
        std::ptr::null_mut(),
        wide.as_ptr(),
        IMAGE_ICON,
        size,
        size,
        LR_LOADFROMFILE,
    ) as HICON
}

/// Composite base folder icon + badge at the requested placement, return new HICON.
/// placement: 0=top_right, 1=bottom_right, 2=centered
/// status: STATUS_SYNCED or STATUS_SYNCING
unsafe fn composite_icon(size: i32, placement: u32, status: u32) -> HICON {
    let badge_name = match status {
        STATUS_SYNCED => "synced",
        STATUS_SYNCING => "syncing",
        _ => return std::ptr::null_mut(),
    };

    // 1. Get the base Windows 11 folder icon
    let h_base = get_stock_folder_icon(size);
    if h_base.is_null() {
        return std::ptr::null_mut();
    }

    // Badge is 42% of icon size, minimum 8px
    let badge_size = ((size as f32) * 0.42).round() as i32;
    let badge_size = badge_size.max(8).min(size);

    // 2. Load badge icon
    let h_badge = load_badge_icon(badge_name, badge_size);

    // 3. Create 32-bit ARGB top-down DIB section
    let hdc_screen = GetDC(std::ptr::null_mut());
    let hdc_mem = CreateCompatibleDC(hdc_screen);

    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = size;
    bmi.bmiHeader.biHeight = -size; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB as u32;

    let mut pv_bits: *mut c_void = std::ptr::null_mut();
    let h_bmp: HBITMAP = CreateDIBSection(
        hdc_screen,
        &bmi,
        DIB_RGB_COLORS,
        &mut pv_bits,
        std::ptr::null_mut(),
        0,
    );

    if h_bmp.is_null() {
        if !h_base.is_null() { DestroyIcon(h_base); }
        if !h_badge.is_null() { DestroyIcon(h_badge); }
        DeleteDC(hdc_mem);
        ReleaseDC(std::ptr::null_mut(), hdc_screen);
        return std::ptr::null_mut();
    }

    let h_old = SelectObject(hdc_mem, h_bmp as _);

    // 4. Clear to fully transparent
    if !pv_bits.is_null() {
        std::ptr::write_bytes(pv_bits as *mut u8, 0, (size * size * 4) as usize);
    }

    // 5. Draw base folder icon
    DrawIconEx(hdc_mem, 0, 0, h_base, size, size, 0, std::ptr::null_mut(), DI_NORMAL);

    // 6. Compute badge position: 3% margin from edges
    let margin = ((size as f32) * 0.03).round() as i32;
    let (bx, by) = match placement {
        1 => (size - badge_size - margin, size - badge_size - margin),  // bottom_right
        2 => ((size - badge_size) / 2, (size - badge_size) / 2),        // centered
        _ => (size - badge_size - margin, margin),                       // top_right (default)
    };

    // 7. Draw badge on top of folder
    if !h_badge.is_null() {
        DrawIconEx(hdc_mem, bx, by, h_badge, badge_size, badge_size, 0, std::ptr::null_mut(), DI_NORMAL);
    }

    // 8. Build HICON from composited bitmap
    let h_mask = CreateBitmap(size, size, 1, 1, std::ptr::null());
    let ii = ICONINFO {
        fIcon: TRUE,
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: h_mask,
        hbmColor: h_bmp,
    };
    let h_icon = CreateIconIndirect(&ii);

    // Cleanup GDI resources
    SelectObject(hdc_mem, h_old);
    DeleteObject(h_bmp as _);
    if !h_mask.is_null() { DeleteObject(h_mask as _); }
    DeleteDC(hdc_mem);
    ReleaseDC(std::ptr::null_mut(), hdc_screen);
    if !h_base.is_null() { DestroyIcon(h_base); }
    if !h_badge.is_null() { DestroyIcon(h_badge); }

    h_icon
}

// ── IExtractIconW COM VTable ──────────────────────────────────────────────────

#[repr(C)]
pub struct IExtractIconWVtbl {
    pub QueryInterface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> HRESULT,
    pub AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub Release: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub GetIconLocation: unsafe extern "system" fn(
        this: *mut c_void,
        uFlags: u32,
        szIconFile: *mut u16,
        cchMax: u32,
        piIndex: *mut i32,
        pwFlags: *mut u32,
    ) -> HRESULT,
    pub Extract: unsafe extern "system" fn(
        this: *mut c_void,
        pszFile: *const u16,
        nIconIndex: u32,
        phiconLarge: *mut HICON,
        phiconSmall: *mut HICON,
        nIconSize: u32,
    ) -> HRESULT,
}

// ── IPersistFile COM VTable ───────────────────────────────────────────────────

#[repr(C)]
pub struct IPersistFileVtbl {
    pub QueryInterface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> HRESULT,
    pub AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub Release: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub GetClassID: unsafe extern "system" fn(
        this: *mut c_void,
        pClassID: *mut GUID,
    ) -> HRESULT,
    pub IsDirty: unsafe extern "system" fn(this: *mut c_void) -> HRESULT,
    pub Load: unsafe extern "system" fn(
        this: *mut c_void,
        pszFileName: *const u16,
        dwMode: u32,
    ) -> HRESULT,
    pub Save: unsafe extern "system" fn(
        this: *mut c_void,
        pszFileName: *const u16,
        fRemember: BOOL,
    ) -> HRESULT,
    pub SaveCompleted: unsafe extern "system" fn(
        this: *mut c_void,
        pszFileName: *const u16,
    ) -> HRESULT,
    pub GetCurFile: unsafe extern "system" fn(
        this: *mut c_void,
        ppszFileName: *mut *mut u16,
    ) -> HRESULT,
}

// ── IClassFactory COM VTable ──────────────────────────────────────────────────

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
        pUnkOuter: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> HRESULT,
    pub LockServer: unsafe extern "system" fn(this: *mut c_void, fLock: BOOL) -> HRESULT,
}

// ── FolderIconHandler object ──────────────────────────────────────────────────
// Memory layout:
//   +0:  *const IExtractIconWVtbl   (IExtractIconW vtbl — pointer at byte 0)
//   +8:  *const IPersistFileVtbl    (IPersistFile vtbl — pointer at byte 8)
//   +16: ref_count (AtomicUsize)
//   ...  dir_path, dir_path_len

#[repr(C)]
pub struct FolderIconHandler {
    pub extract_vtbl: *const IExtractIconWVtbl,
    pub persist_vtbl: *const IPersistFileVtbl,
    pub ref_count: AtomicUsize,
    pub dir_path: [u16; 260],
    pub dir_path_len: usize,
}

#[repr(C)]
pub struct ClassFactory {
    pub vtbl: *const IClassFactoryVtbl,
    pub ref_count: AtomicUsize,
}

// ── Static VTables ────────────────────────────────────────────────────────────

static EXTRACT_VTBL: IExtractIconWVtbl = IExtractIconWVtbl {
    QueryInterface: handler_query_interface_extract,
    AddRef: handler_add_ref,
    Release: handler_release,
    GetIconLocation: handler_get_icon_location,
    Extract: handler_extract,
};

static PERSIST_VTBL: IPersistFileVtbl = IPersistFileVtbl {
    QueryInterface: handler_query_interface_persist,
    AddRef: handler_add_ref_persist,
    Release: handler_release_persist,
    GetClassID: handler_get_class_id,
    IsDirty: handler_is_dirty,
    Load: handler_load,
    Save: handler_save,
    SaveCompleted: handler_save_completed,
    GetCurFile: handler_get_cur_file,
};

static CLASS_FACTORY_VTBL: IClassFactoryVtbl = IClassFactoryVtbl {
    QueryInterface: factory_query_interface,
    AddRef: factory_add_ref,
    Release: factory_release,
    CreateInstance: factory_create_instance,
    LockServer: factory_lock_server,
};

// ── Helper: get FolderIconHandler from each vtbl pointer ──────────────────────

#[inline]
unsafe fn handler_from_extract(this: *mut c_void) -> *mut FolderIconHandler {
    this as *mut FolderIconHandler
}

/// IPersistFile vtbl is at offset +8 from start of FolderIconHandler.
#[inline]
unsafe fn handler_from_persist(this: *mut c_void) -> *mut FolderIconHandler {
    (this as *mut u8).sub(8) as *mut FolderIconHandler
}

// ── IExtractIconW Implementation ──────────────────────────────────────────────

unsafe extern "system" fn handler_query_interface_extract(
    this: *mut c_void,
    riid: *const GUID,
    ppvObject: *mut *mut c_void,
) -> HRESULT {
    if ppvObject.is_null() || riid.is_null() {
        return E_POINTER;
    }
    let guid = *riid;
    if guid == IID_IUNKNOWN || guid == IID_IEXTRACTICONW {
        *ppvObject = this;
        handler_add_ref(this);
        S_OK
    } else if guid == IID_IPERSISTFILE || guid == IID_IPERSIST {
        // IPersistFile vtbl is at &handler.persist_vtbl
        let handler = handler_from_extract(this);
        let persist_ptr = &mut (*handler).persist_vtbl as *mut _ as *mut c_void;
        *ppvObject = persist_ptr;
        handler_add_ref(this);
        S_OK
    } else {
        *ppvObject = std::ptr::null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn handler_add_ref(this: *mut c_void) -> u32 {
    let obj = &*(this as *const FolderIconHandler);
    obj.ref_count.fetch_add(1, Ordering::Relaxed) as u32 + 1
}

unsafe extern "system" fn handler_release(this: *mut c_void) -> u32 {
    let obj = &*(this as *const FolderIconHandler);
    let prev = obj.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        OBJECT_COUNT.fetch_sub(1, Ordering::Relaxed);
        let _ = Box::from_raw(this as *mut FolderIconHandler);
        0
    } else {
        (prev - 1) as u32
    }
}

/// GetIconLocation: tell shell we provide HICON directly in Extract(), per-instance.
unsafe extern "system" fn handler_get_icon_location(
    _this: *mut c_void,
    _uFlags: u32,
    szIconFile: *mut u16,
    cchMax: u32,
    piIndex: *mut i32,
    pwFlags: *mut u32,
) -> HRESULT {
    if !szIconFile.is_null() && cchMax > 0 {
        *szIconFile = 0;
    }
    if !piIndex.is_null() {
        *piIndex = 0;
    }
    if !pwFlags.is_null() {
        *pwFlags = GIL_NOTFILENAME | GIL_PERINSTANCE | GIL_DONTCACHE;
    }
    S_OK
}

/// Extract: compose and return HICON with badge at user-configured position.
unsafe extern "system" fn handler_extract(
    this: *mut c_void,
    _pszFile: *const u16,
    _nIconIndex: u32,
    phiconLarge: *mut HICON,
    phiconSmall: *mut HICON,
    nIconSize: u32,
) -> HRESULT {
    let handler = &*(this as *const FolderIconHandler);

    if handler.dir_path_len == 0 {
        return S_FALSE; // No path set, shell uses default
    }

    // Look up folder status in shared memory
    let (enabled, placement, status) =
        lookup_folder_status(&handler.dir_path, handler.dir_path_len);

    if !enabled || status == STATUS_NONE {
        // Not a Twin folder or overlay disabled; shell uses default icon
        return S_FALSE;
    }

    // Extract icon sizes from nIconSize (LOWORD = large, HIWORD = small)
    let cx_large = (nIconSize & 0xFFFF) as i32;
    let cx_small = ((nIconSize >> 16) & 0xFFFF) as i32;

    let large_size = if cx_large > 0 { cx_large } else { GetSystemMetrics(SM_CXICON) };
    let small_size = if cx_small > 0 { cx_small } else { GetSystemMetrics(SM_CXSMICON) };

    if !phiconLarge.is_null() {
        *phiconLarge = composite_icon(large_size, placement, status);
    }
    if !phiconSmall.is_null() {
        *phiconSmall = composite_icon(small_size, placement, status);
    }

    S_OK
}

// ── IPersistFile Implementation ───────────────────────────────────────────────

unsafe extern "system" fn handler_query_interface_persist(
    this: *mut c_void,
    riid: *const GUID,
    ppvObject: *mut *mut c_void,
) -> HRESULT {
    if ppvObject.is_null() || riid.is_null() {
        return E_POINTER;
    }
    let guid = *riid;
    let handler = handler_from_persist(this);
    let extract_ptr = handler as *mut c_void;

    if guid == IID_IPERSISTFILE || guid == IID_IPERSIST || guid == IID_IUNKNOWN {
        *ppvObject = this;
        handler_add_ref(extract_ptr);
        S_OK
    } else if guid == IID_IEXTRACTICONW {
        *ppvObject = extract_ptr;
        handler_add_ref(extract_ptr);
        S_OK
    } else {
        *ppvObject = std::ptr::null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn handler_add_ref_persist(this: *mut c_void) -> u32 {
    handler_add_ref(handler_from_persist(this) as *mut c_void)
}

unsafe extern "system" fn handler_release_persist(this: *mut c_void) -> u32 {
    handler_release(handler_from_persist(this) as *mut c_void)
}

unsafe extern "system" fn handler_get_class_id(
    _this: *mut c_void,
    pClassID: *mut GUID,
) -> HRESULT {
    if pClassID.is_null() {
        return E_POINTER;
    }
    *pClassID = CLSID_TWIN_ICON_HANDLER;
    S_OK
}

unsafe extern "system" fn handler_is_dirty(_this: *mut c_void) -> HRESULT {
    S_FALSE
}

/// Load is called by the shell with the folder path before GetIconLocation/Extract.
unsafe extern "system" fn handler_load(
    this: *mut c_void,
    pszFileName: *const u16,
    _dwMode: u32,
) -> HRESULT {
    if pszFileName.is_null() {
        return E_FAIL;
    }
    let handler = &mut *handler_from_persist(this);
    let (norm, norm_len) = normalize_path_w(pszFileName);
    handler.dir_path[..norm_len].copy_from_slice(&norm[..norm_len]);
    handler.dir_path[norm_len] = 0;
    handler.dir_path_len = norm_len;
    S_OK
}

unsafe extern "system" fn handler_save(
    _this: *mut c_void,
    _pszFileName: *const u16,
    _fRemember: BOOL,
) -> HRESULT {
    E_FAIL
}

unsafe extern "system" fn handler_save_completed(
    _this: *mut c_void,
    _pszFileName: *const u16,
) -> HRESULT {
    S_OK
}

unsafe extern "system" fn handler_get_cur_file(
    _this: *mut c_void,
    _ppszFileName: *mut *mut u16,
) -> HRESULT {
    E_FAIL
}

// ── Class Factory ─────────────────────────────────────────────────────────────

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
    _this: *mut c_void,
    pUnkOuter: *mut c_void,
    riid: *const GUID,
    ppvObject: *mut *mut c_void,
) -> HRESULT {
    if ppvObject.is_null() || riid.is_null() {
        return E_POINTER;
    }
    *ppvObject = std::ptr::null_mut();

    if !pUnkOuter.is_null() {
        return CLASS_E_NOAGGREGATION;
    }

    let handler = Box::new(FolderIconHandler {
        extract_vtbl: &EXTRACT_VTBL,
        persist_vtbl: &PERSIST_VTBL,
        ref_count: AtomicUsize::new(1),
        dir_path: [0u16; 260],
        dir_path_len: 0,
    });
    OBJECT_COUNT.fetch_add(1, Ordering::Relaxed);

    let raw = Box::into_raw(handler) as *mut c_void;
    let hr = handler_query_interface_extract(raw, riid, ppvObject);
    handler_release(raw);
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

// ── DLL Exports ───────────────────────────────────────────────────────────────

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
    } else if fdwReason == DLL_PROCESS_DETACH {
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
    if rclsid.is_null() || riid.is_null() || ppv.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();

    if *rclsid != CLSID_TWIN_ICON_HANDLER {
        return E_FAIL;
    }

    let factory = Box::new(ClassFactory {
        vtbl: &CLASS_FACTORY_VTBL,
        ref_count: AtomicUsize::new(1),
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

// ── Registry Helpers ──────────────────────────────────────────────────────────

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

// ── DllRegisterServer / DllUnregisterServer ───────────────────────────────────

#[no_mangle]
pub unsafe extern "system" fn DllRegisterServer() -> HRESULT {
    let hmod = MODULE_HANDLE.load(Ordering::Relaxed) as HMODULE;
    let mut mod_path = [0u16; 512];
    let len = GetModuleFileNameW(hmod, mod_path.as_mut_ptr(), 512) as usize;
    if len == 0 {
        return E_FAIL;
    }
    let dll_path = String::from_utf16_lossy(&mod_path[..len]);

    let clsid_str = "{9B46E713-2051-417A-8D52-19253DE6C7D3}";

    // Register CLSID in HKLM and HKCU
    for &root in &[HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let clsid_key = format!("SOFTWARE\\Classes\\CLSID\\{clsid_str}");
        set_reg_str(root, &clsid_key, None, "Twin Folder Icon Handler");
        set_reg_str(root, &format!("{clsid_key}\\InprocServer32"), None, &dll_path);
        set_reg_str(
            root,
            &format!("{clsid_key}\\InprocServer32"),
            Some("ThreadingModel"),
            "Apartment",
        );
    }

    // Register as IconHandler for all NTFS directories/folders in Explorer.
    // Both "Directory" (physical folders) and "Folder" (all folder items) must be registered.
    for subkey in &[
        "Directory\\shellex\\IconHandler",
        "Folder\\shellex\\IconHandler",
    ] {
        set_reg_str(HKEY_CLASSES_ROOT, subkey, None, clsid_str);
        set_reg_str(
            HKEY_LOCAL_MACHINE,
            &format!("SOFTWARE\\Classes\\{subkey}"),
            None,
            clsid_str,
        );
    }

    S_OK
}

#[no_mangle]
pub unsafe extern "system" fn DllUnregisterServer() -> HRESULT {
    let clsid_str = "{9B46E713-2051-417A-8D52-19253DE6C7D3}";

    for &root in &[HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        del_reg_key(
            root,
            &format!("SOFTWARE\\Classes\\CLSID\\{clsid_str}\\InprocServer32"),
        );
        del_reg_key(root, &format!("SOFTWARE\\Classes\\CLSID\\{clsid_str}"));
    }

    for subkey in &[
        "Directory\\shellex\\IconHandler",
        "Folder\\shellex\\IconHandler",
    ] {
        del_reg_key(HKEY_CLASSES_ROOT, subkey);
        del_reg_key(
            HKEY_LOCAL_MACHINE,
            &format!("SOFTWARE\\Classes\\{subkey}"),
        );
    }

    S_OK
}
