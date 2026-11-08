# Twin v1.1.5

Major desktop refinement release introducing a dedicated full-page folder inspection dashboard, accurate active file counts eliminating false "Up to date" indicators, native Win32 folder browsing with zero terminal flashes, dynamic status-driven system tray icons, and a spacious pair configuration modal.

---

### ✨ What's New in v1.1.5

#### 🖥️ Dedicated Full-Page Folder Inspection Dashboard
- **Comprehensive Folder View**: Replaced the cramped inline row dropdown with a dedicated, spacious full-page view accessible by clicking any folder pair row or the **Details →** button.
- **Header & Quick Actions**: Aligned page header featuring the folder title, live sync status badge (`✓ Up to date with Drive`, `Sync pending`, or `Syncing`), topology tag, and one-click actions: **Sync Now**, **Open in Explorer**, **View in Drive**, **Sync Toggle**, and **Delete**.
- **Balanced 4-Column Metrics Bar**: High-contrast, clean status strip tracking **Synced Files** (with completion percentage), **Pending Changes**, **Drive Trash** (safely preserved for 30 days), and **Sync Issues**.
- **Unified Configuration Property Sheet**: Clean property sheet detailing the local filesystem path, Google Drive target directory, synchronization topology, and remote deletion safety policy with inline **Explorer**, **Drive**, and **Copy** actions.
- **Live In-Flight Transfers Stream**: Real-time progress bars showing active file transfers, transfer speeds (MB/s), remaining ETA, and direction badges (Uploading to Drive / Downloading from Drive).
- **Per-Folder Activity Ledger**: Dedicated audit table displaying all past file uploads, downloads, and deletions specifically recorded for that folder pair.

#### 🎯 True "Up to Date" Logic & Active File Counting (Fixed 880/1064 Bug)
- **Filtered Soft-Deleted Records**: Updated SQLite database queries to exclude soft-deleted/tombstone records from active file counts (`WHERE state NOT IN ('deleted', 'deleted_local', 'remote_deleted', 'trashed')`). Soft-deleted records are now tracked independently in `deleted`.
- **Strict Sync Status Check**: `is_synced` now strictly requires `synced == total` in addition to zero queued, running, dirty, or failed jobs.
- **Accurate Pending Feedback**: When files remain unsynced (`synced < total`), the interface immediately displays `Sync pending • X/Y synced (Z remaining)` in amber rather than falsely claiming "Up to date with Google Drive" with a green checkmark.
- **Overview Canvas Accuracy**: The top Overview banner now shows **Sync Pending** whenever any active folder pair has un-synced files.

#### 🪟 Silent Native Folder Browser (Zero Terminal Flashing)
- **Direct Win32 COM Integration**: Replaced PowerShell-spawned folder browser dialogs with native Win32 COM folder pickers via `rfd` (Rust File Dialog).
- **No Console Popups**: Browsing for local folders to sync now opens instantly and silently without any command terminal window flashes.

#### 🔔 Dynamic Status-Driven System Tray Icon
- **Live Tray Supervisor**: Real-time background tray monitor dynamically updates the system tray icon to match exact engine states:
  - **Yellow (`syncing.png`)**: Actively uploading, downloading, or processing jobs in the transfer queue.
  - **Green (`idle.png`)**: All files verified and up to date with Google Drive.
  - **Paused (`paused.png`)**: Engine paused by user or governor.
  - **Red (`error.png`)**: Unresolved sync errors requiring attention.

#### 🎨 Add Synced Folder Pair Modal Redesign
- **Spacious Layout**: Expanded modal width (`w-[680px]`) with comfortable typography (`text-xs` / `text-sm`), eliminating cramped microscopic fonts.
- **Removed Duplicate Selection Banner**: Eliminated the redundant "Selected: <name> <id>" banner underneath the Drive folder browser.
- **Polished Controls**: Clean, high-contrast cards for sync topologies (Two-Way Sync, Cloud Backup, Cloud Mirror) and remote deletion safety options.

#### 📐 Fixed Multi-Line Status Text Wrapping
- **Single-Line Formatting**: Applied strict `whitespace-nowrap overflow-hidden` across list rows to prevent status text like `Up to date with Google Drive` and file counts from awkwardly wrapping into multiple jagged vertical lines.
