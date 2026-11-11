# Changelog

All notable changes to **Twin** are documented in this file.
The project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.2] - 2026-11-11

### 🚀 Feature Release — Dynamic Pair Reconfiguration, Live Poller Reload & Transfer Viewport Prioritization

#### ⚙️ Dynamic Pair Configuration
- **Interactive Sync Mode Selector**: Switch between Two-Way Sync, Cloud Backup (Upload only), and Cloud Mirror directly in Pair Details.
- **Mirror Mode Confirmation Modal**: Protective warning detailing that local PC state is the strict master in Mirror mode and remote-only items will be deleted or trashed.
- **Remote Deletion Policy Controls**: Reconfigure between Drive Trash, Ignore Remote, and Permanent Deletion with safety modal.
- **Locked Identity Indicators**: Local folder and Drive target paths marked locked to SQLite state to prevent desynchronization.

#### 🛡️ Backend Engine Hardening
- **Queue Job Cancellation (`cancel_pair_jobs`)**: Automatically cancel obsolete download/delete jobs when mode or deletion policies change.
- **Live-Reload in Changes Poller**: `poll_changes_loop` reloads fresh pair configuration on every iteration; ignores remote changes in upload-only mode without network waste.
- **Transfer Worker Guardrails**: Download and upload runners check current topology and exclusion rules prior to execution.

#### 📊 Active Transfers Viewport
- **Priority Sorting**: Actively streaming files are sorted to the top of the folder breakdown list.
- **Pinned Top Viewport**: Container scroll stays at the top as transfers cycle so the active file is never hidden.

---

## [1.2.1] - 2026-11-11

### 🔧 Patch Release — UI Stability Fix, Settings Cleanup & Version Alignment

#### ⚠️ Build Stability
- **Fixed QueueStatus type conflict**: Resolved a TypeScript type mismatch in the queue status consumer that blocked the production build. The app now compiles and ships cleanly.

#### 🧹 UI Cleanup
- **Removed unused Sliders icon from Sync Speed & Performance settings header**: Header now shows only the section title; unused `lucide-react` import removed.

#### 🏷️ Version Alignment
- **Fixed tauri.conf.json version mismatch**: Was stuck at `1.1.7` while `package.json`/`Cargo.toml` were at `1.2.0`, causing the sidebar to display a stale version. All three manifests now agree and the sidebar reads the live version via Tauri `getVersion()`.

---

## [1.2.0] - 2026-11-10

### 🚀 Major Release — Full Upload Activity Lifecycle, Windows Shell Overlays & Production Hardening

#### ⚡ Upload Progress & Activity Fixes
- **Full upload activity lifecycle restored**: Uploads now show start-to-end progress in the activity section — from "Uploading" with real-time progress bar through "100% / Success" — before numbers update to synced count (99/99). No more phantom "done in milliseconds" followed by unexplained re-uploads.
- **Fixed NULL metadata re-upload loop**: Files synced via Drive remote-dedup path now correctly store `size`, `mtime_ms`, `md5`, and `state` in SQLite instead of hardcoded NULLs. Heartbeat rescan and reconcile no longer falsely flag synced files as "locally changed," eliminating the 46-file re-upload storm after completion.
- **Completion timer reduced**: Completed transfers clear from the activity panel after 300ms (was 1200ms), so the UI immediately reflects "done" state.
- **Real-time transfer merge in activity ledger**: In-flight progress events are merged into the activity section during transfer, showing upload percentage and progress bar alongside historical records.

#### 🪟 Windows Shell Folder Overlays
- **Explorer overlay badges**: Folder sync status (Idle/Syncing/Paused/Error) now displays directly in Windows File Explorer via `IShellIconOverlayIdentifier` with placement-specific ICOs.
- **Tray icon state transitions**: Instant yellow↔green badge toggling with 500ms poll interval and 1.5s-2.0s linger cooldown for smooth state changes.
- **Overlay registration**: Auto register/unregister DLL, restart Explorer, and apply overlay badges without manual steps.

#### 🔄 Sync Engine Reliability
- **Windows Path Prefix Normalization**: Eliminated silent dropping of local filesystem events caused by NTFS case variance (`D:\DOCUMENTS` vs `d:\documents`), verbatim UNC paths (`\\?\D:\...`), and mixed slash separators.
- **Recursive Directory Discovery**: Bulk folder paste/drag/create now traverses and registers all child files immediately — no more dropped files on directory copy/move.
- **Continuous 60-Second Background Heartbeat Rescan**: Autonomous local scan every 60 seconds across all active pairs guarantees changes missed by OS watcher are detected and uploaded automatically.
- **Transient Windows File Lock Retries**: Retry backoff for files temporarily locked by external editors during atomic save operations.
- **Remote Changes API Feed Fix**: Remote trash events and changes to already-tracked SQLite files are retained and dispatched immediately.

#### 🔧 Infrastructure & Tooling
- **Overlay handler build**: Separate `overlay-handler/` crate for the Explorer shell extension DLL.
- **Icon-Pack**: Complete tray and overlay icon set in all required resolutions (Tray: error/idle/paused/syncing; Overlay: synced/syncing).
- **Icon generation scripts**: Python scripts for automated tray and overlay icon generation.
- **NSIS installer**: Verified `nsis_tauri_utils.dll` plugin for Windows installer bundling.
- **Test suite**: Added overlay toggle tests, benchmarks, and expanded DB/drive/sync torture tests.

---

## [1.1.7] - 2026-11-08

### ⚡ Critical Fixes — Continuous Auto-Detection, Windows Path Normalization & Background Heartbeat Rescan

#### 🔒 Fixed & Hardened
- **Windows Path Prefix Normalization (`strip_root_prefix`)**: Eliminated silent dropping of local filesystem events caused by NTFS case variance (`D:\DOCUMENTS` vs `d:\documents`), extended verbatim UNC paths (`\\?\D:\...`), and mixed slash separators (`/` vs `\`). Local file modifications, creations, renames, and deletions are now recognized and synced within seconds.
- **Recursive Directory Discovery (`expand_dir_files`)**: When whole folders are pasted, dragged, or created inside a synced folder, Twin now traverses and registers all child files immediately, preventing dropped files on bulk directory copy/move operations.
- **Continuous 60-Second Background Heartbeat Rescan**: Added an autonomous local scan every 60 seconds across all active pairs in the Dynamic Pair Supervisor. Guarantees any local changes missed by the OS watcher (due to buffer overflows, sleep/wake cycles, or rapid edits) are detected and uploaded automatically without requiring manual "Sync Now" clicks.
- **Transient Windows File Lock Retries**: Added retry backoff for files temporarily locked by external text editors, browsers, or office apps during atomic save operations.
- **Remote Changes API Feed Fix**: Fixed Google Drive Changes feed filtering so remote trash events (which omit `parents` metadata) and changes to files already tracked in SQLite are retained and dispatched immediately rather than being discarded as outside the tree.
- **Dynamic Supervisor Lifecycle Management**: Disabled pairs cleanly drop their active filesystem watchers, and newly enabled pairs immediately trigger an initial reconciliation cycle upon being enabled.

---

## [1.1.6] - 2026-11-08

### 🛡️ Critical Fixes & Hardening — Idempotent Deletions, Drive 404 Recovery & Cascade Pruning

#### 🔒 Fixed & Hardened
- **Idempotent Deletions & Trashing**: Deleting or trashing files on Google Drive that were already removed, trashed, or returned 404/410/notFound is now treated as an idempotent success rather than a fatal error. Prevents deletion jobs from retrying 5 times and permanently failing in the activity ledger.
- **Parent Folder Deletion Cascade (Fixed Redundant Failures)**: In Mirror mode, when a rogue remote folder is pruned from Drive, all child files beneath that folder are now automatically recognized as trashed in SQLite rather than dispatching redundant individual file deletion jobs that error against non-existent parents.
- **Recognize Remote Trash Events in Changes Feed**: Expanded Google Drive Changes API processor to treat `change.file.trashed = true` as an active remote removal event instead of skipping it, properly propagating remote deletions to local storage.
- **Stale Drive ID Upload Recovery**: When uploading files whose previously recorded `drive_id` was deleted or purged on Google Drive (404 on `PATCH`), Twin now automatically clears the stale ID and seamlessly re-uploads the file as a clean new object (`POST`) without failing.
- **Missing Local Files Without Remote ID**: Missing local files that were never uploaded to Drive (empty `drive_id`) are now marked `deleted` directly in SQLite without queueing useless network delete jobs.
- **Automatic Recovery of Stuck Jobs**: Added automatic re-queuing of failed jobs upon application startup and during `Sync Now` / `Sync All` cycles, allowing any previously stuck failed delete jobs to execute cleanly through the resilient handlers and resolve automatically.
- **UI Error Boundary & Retry-All Action**: Added a React `ErrorBoundary` protecting the main viewport, an inline **Retry all** action on the Home screen to retry all failed transfers in one click, and push-based `queue://updated` listener for instant UI updates.

---

## [1.1.5] - 2026-11-08

### 🚀 Enhancements — Dedicated Folder Inspection Dashboard, True Up-To-Date Verification & Native Dialogs

#### ✨ Features & Improvements
- **Dedicated Folder Inspection Dashboard**: Replaced cramped inline row dropdowns with a dedicated full-page screen (`PairDetailScreen`) accessible by clicking any folder pair row or the `Details →` button.
- **Aligned Folder Header**: Clean, unboxed header with folder title, live sync status badge (`✓ Up to date with Drive`, `Sync pending`, or `Syncing`), topology tag, and one-click actions: **Sync Now**, **Open in Explorer**, **View in Drive**, **Sync Toggle**, and **Delete**.
- **Balanced Metrics Bar**: 4-column status strip tracking **Synced Files** (with percentage), **Pending Changes**, **Drive Trash** (30-day recovery), and **Sync Issues**.
- **Unified Configuration Property Sheet**: Clean property sheet detailing local filesystem directory, Google Drive target directory, replication topology, and remote deletion safety policy.
- **Live In-Flight Transfers Stream**: Real-time progress bars showing active file transfers, transfer speeds (MB/s), remaining ETA, and direction badges (Uploading to Drive / Downloading from Drive).
- **Per-Folder Activity Ledger**: Dedicated audit table displaying all past file uploads, downloads, and deletions specifically for that folder pair.
- **Silent Native Folder Browser**: Replaced PowerShell folder picker with direct Win32 COM dialog via `rfd` (Rust File Dialog), completely eliminating terminal window popups.
- **Dynamic System Tray Status Supervisor**: Live background supervisor dynamically switches the tray icon between Yellow (uploading/downloading/queued), Green (all files up to date), Paused, and Red (errors).
- **Add Synced Folder Pair Modal Redesign**: Expanded modal width (`w-[680px]`) with comfortable typography (`text-xs` / `text-sm`), removed duplicate selection cards, and modernized topology cards.

#### 🔒 Fixed & Hardened
- **Accurate Active File Counts (Fixed 880/1064 Bug)**: Excluded soft-deleted/tombstone records from active file counts in SQLite queries (`WHERE state NOT IN ('deleted', 'deleted_local', 'remote_deleted', 'trashed')`).
- **Strict Sync Status Check**: `is_synced` strictly requires `synced == total` and zero dirty/queued jobs before showing green checkmarks.
- **Accurate Pending Status**: Folders with unsynced files now accurately display `Sync pending • X/Y synced (Z remaining)` in amber instead of falsely declaring "Up to date with Google Drive".
- **Single-Line Status Formatting**: Applied `whitespace-nowrap overflow-hidden` across list rows to prevent status text and file counts from awkwardly breaking across lines.

---

## [1.1.4] - 2026-11-08

### 🎨 Refinements — Eliminate Duplicate Update Notification Cards

#### 🔒 Fixed & Polished
- **Deduplicated Update Toasts**: Removed the redundant Sonner toast on `update://ready` in `App.tsx` that stacked directly over the dedicated `UpdateBanner` floating card.
- **Single Source of Truth**: The bottom-right floating banner is now the sole interactive card for background update readiness, complete with the `Restart` action and `X` dismiss button.
- **Clean Manual Check Feedback**: Manual update checks in Settings provide clean status toasts without overlapping secondary restart buttons.

---

## [1.1.3] - 2026-11-08

### 🛡️ Maintenance — Automatic App Relaunch After In-App Update

#### 🔒 Fixed & Hardened
- **Auto-Relaunch After Silent NSIS Update**: Configured the background update executor to await silent installer completion (`-Wait`) and immediately invoke `Twin.exe`, ensuring the application reopens cleanly without requiring manual relaunch.
- **Drive Scope Resolution**: Eliminated `spaces=appDataFolder` API calls that caused `HTTP 403 Forbidden (insufficientScopes)`.
- **Deduplicated Action Controls**: Removed redundant `Sync All` and `Add Folder` buttons from the top Overview card.
- **Drive Explorer Navigation Removed**: Removed the Drive Explorer navigation item and screen for a streamlined experience.

---

## [1.1.2] - 2026-11-08

### 🛡️ Refinements — Drive Scope Resolution, UI Streamlining & De-Cluttering

#### 🔒 Fixed & Enhanced
- **Drive Scope Resolution**: Eliminated `spaces=appDataFolder` API calls that caused `HTTP 403 Forbidden (insufficientScopes)`.
- **Clean Settings Card**: Removed experimental "Sync AppData" button from Settings; stopped background AppData loop.
- **Drive Explorer Navigation Removed**: Removed the Drive Explorer navigation item and screen for a streamlined experience.
- **Deduplicated Action Controls**: Removed redundant `Sync All` and `Add Folder` buttons from the top Overview card.
- **Auto-Update Delivery**: Delivers seamless background update to users on v1.1.1.

---

## [1.1.1] - 2026-11-07

### 🛡️ Critical Fixes — In-App Updater Hardening, Silent NSIS Updates & UI Refinements

#### 🔒 Fixed & Hardened
- **Safe Asset Selection**: Installed setups strictly download NSIS `Twin_{ver}_x64-setup.exe`; portable builds strictly download `Twin.exe`. Disallowed `.zip` and `.msi` to prevent binary corruption.
- **Silent NSIS Execution**: Installed applications execute setup installer silently with `/S`, preserving Windows Installed Apps registration, Registry uninstaller entries, and desktop shortcuts.
- **PE Magic Header Verification**: Added pre-installation byte verification (`0x4D, 0x5A` / `MZ`). Corrupted or invalid downloads are safely rejected and erased before application.
- **GitHub API Cache Prevention**: Added `Cache-Control: no-cache` and strict `Accept` headers to guarantee instant discovery of new releases.
- **Concise Notifications**: Shortened update notification toast and banner to `"Update vX.Y.Z Ready"` with direct `Restart` button.
- **Check for Updates Feedback**: Resolved unhandled downloading states in Settings so manual update checks always provide immediate feedback.
- **Synced Folders Presentation**: Eliminated layout overlapping and removed raw alphanumeric Drive IDs from folder pair rows.

---

## [1.1.0] - 2026-11-07

### 🚀 Feature Release — Google Drive Colorizer & GitHub Repository Presentation

#### ✨ Added & Enhanced
- **Google Drive Folder Colorizer**:
  - Interactive 24-color Google Drive official palette picker.
  - Supports colorizing individual folders as well as batch multi-selection.
  - Folder colors dynamically rendered in the tree view and Drive Explorer.
- **GitHub-Style Repository Item Viewer**:
  - Complete overhaul of remote Drive Explorer (`RestoreScreen`) with GitHub repo table layout (`#0d1117`, `#161b22`, `#30363d`), breadcrumbs, and `..` parent navigation.
  - Synced Folders table (`HomeScreen`) rebuilt as single-row GitHub file tree items with Octicon icons, mode badges, and attached sync progress strips.
  - Cleaned up raw alphanumeric Drive IDs and metadata from list items.
- **Continuous Startup & Delta Loop**:
  - Automatically reconciles folder differences on startup and background periodic loops.
  - Live synchronized tick badge indicating real-time parity.
- **Multi-Layer Deduplication Engine**:
  - MD5 hash, filename, and parent folder deduplication before upload to prevent remote file duplication.
- **Dynamic Mirror Pruning**:
  - Automatically detects and removes rogue remote directories in Mirror mode to ensure true 1:1 mirroring.
- **Hardened Error Recovery & Rate Limiting**:
  - Exponential jittered backoff with native `Retry-After` header parsing for Drive 503 and 429 responses.
  - Auto-discard of orphaned jobs when pairs are removed.
- **Strict Brand Sizing**:
  - Official Google Drive logo asset integration with strict inline pixel bounds across all views.

---

## [1.0.0] - 2026-11-03

### 🚀 Major Release — Official Launch of Twin Desktop

Twin is an ultra-lightweight, high-performance Google Drive synchronization engine for Windows 10 & 11, engineered in Rust and Tauri v2.

#### ✨ Core Capabilities
- **Continuous Bidirectional Sync**: High-speed delta synchronization between local folder paths and remote Google Drive folders with instant file system watcher notifications (`notify-debouncer-full`).
- **Flexible Synchronization Modes**:
  - `Two-Way`: Bidirectional live synchronization for code, notes, and active workspaces.
  - `Backup (Upload)`: One-way continuous cloud archive; local edits upload, remote modifications do not overwrite local files.
  - `Mirror (Download)`: Exact cloud mirror replication.
- **System Resource Governor**:
  - Automatically suspends transfers when system CPU utilization exceeds threshold (configurable).
  - Resumes transfers automatically once system load normalizes.
  - Pauses transfers on metered Wi-Fi/cellular networks to protect data caps.
  - Automatic battery saver pause when unplugged.
- **Drive Explorer & File Revisions**:
  - Full Google Drive hierarchy navigation with breadcrumbs and shared drive support.
  - Revision history inspector: browse previous file snapshots, lock revisions with "Keep Forever", and restore historical versions in one click.
  - Trash recovery sub-tab to restore deleted Drive assets.
- **Conflict Management**:
  - Configurable resolution policies: `newer_wins`, `keep_both` (timestamp suffix), or interactive prompt (`ask`).
- **Autonomous In-Place Background Updater**:
  - JioTV Max pattern: autonomous 20-minute periodic update check against GitHub releases.
  - Silent background download with zero interruption.
  - Instant in-place application on app restart.
- **Privacy & Security**:
  - OAuth 2.0 with restricted `drive.file` and `drive.appdata` scopes.
  - Local credentials stored securely in Windows Credential Manager via OS keyring.
  - Optional Google Drive AppData sync for cross-device preference synchronization.

#### 🎨 Design & Experience
- **Brand Identity**:
  - Custom Master Icon Pack with 13 standard resolutions in both `Square` and `Rounded` squircle formats.
  - 4-State Circular System Tray Indicator:
    - 🟢 **Idle**: Emerald Green ("All Good / Healthy")
    - 🔵 **Syncing**: Electric Cyan/Green rotational sync arrows ("Active Transfer")
    - 🟡 **Paused**: Amber Yellow with pause bars ("Governor / User Paused")
    - 🔴 **Error**: Crimson Red with alert exclamation ("Danger / Attention Required")
- **Refined Desktop UI**:
  - High-contrast cosmic neutral dark mode (`#090a0d` base with `#111319` elevated layers).
  - Interactive mode cards for folder pair creation.
  - Tabular Activity ledger with directional operation pills and one-click retry.
  - Live batch progress bar with throughput (MB/s) and ETA countdown.

