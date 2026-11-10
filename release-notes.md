# Twin v1.2.1

Patch release: UI stability fix, settings header cleanup, and version source-of-truth alignment across all build manifests.

---

### 🔧 What's Fixed in v1.2.1

#### 🐛 UI Build Stability
- **Fixed QueueStatus type conflict blocking build**: Resolved a TypeScript type mismatch in the queue status consumer that prevented the production build from completing. The app now compiles cleanly and ships reliably.

#### 🧹 Settings & Header Cleanup
- **Removed unused Sliders icon from Sync Speed & Performance header**: The settings section header now displays only the title text without a redundant icon, and the unused `Sliders` import was removed from `lucide-react`.

#### 🏷️ Version Source-of-Truth Alignment
- **Fixed tauri.conf.json version mismatch**: `tauri.conf.json` was stuck at `1.1.7` while `package.json` and `Cargo.toml` were already at `1.2.0`. This caused the sidebar to display the wrong version (`1.1.7`) even on `1.2.0` builds. All three manifests now agree, and the sidebar fetches the live version from Tauri's `getVersion()` automatically — no manual edits needed per release.
- **Synced all version references**: `package.json`, `Cargo.toml`, `tauri.conf.json`, `Website/main.js`, and `Website/index.html` all report `1.2.1`.

---

### 🚀 What's New in v1.2.0

#### 📁 Windows Shell Folder Overlays
- **Explorer overlay badges**: Folder sync status (Idle/Syncing/Paused/Error) displays directly in Windows File Explorer via `IShellIconOverlayIdentifier`. No more opening the app to check sync state — see it on your folders.
- **Placement-specific ICOs**: Custom icon pack for tray and overlay states in all required Windows resolutions.
- **Auto DLL registration**: One-command registration/unregistration of the overlay handler DLL with automatic Explorer restart.

#### 📊 Upload Activity — Full Start-to-End Lifecycle
- **Real-time progress in activity section**: Uploads now show "Uploading" with live progress bar during transfer (like delete-from-cloud), then "100% / Success" on completion, before numbers update to synced count.
- **No more phantom instant-complete**: Fixed the bug where files showed "done in milliseconds" then inexplicably re-uploaded. Uploads now display their full lifecycle transparently.
- **300ms completion dismiss**: Finished transfers clear from the activity panel immediately (was 1200ms), keeping the UI responsive.

#### 🔧 Sync Engine Hardening
- **Fixed NULL metadata re-upload loop**: Files synced via Drive remote-dedup now correctly store `size`/`mtime_ms`/`md5`/`state` in SQLite. The 60-second heartbeat rescan and reconcile no longer falsely flag synced files as "changed," eliminating the post-complete re-upload storm.
- **Windows Path Normalization**: Case-insensitive NTFS path matching, verbatim UNC path support, and mixed separator handling eliminate silent event drops.
- **Recursive Directory Discovery**: Bulk folder operations (paste/drag/create) now discover and queue all nested child files immediately.
- **Background Heartbeat Rescan**: Autonomous 60-second local scan guarantees changes missed by OS watcher (sleep/wake, buffer overflow) are detected and uploaded.
- **File Lock Retry**: Graceful handling of transient Windows file locks during atomic saves by external apps.
- **Drive Changes Feed Fix**: Remote trash events and changes to already-tracked files are retained and propagated immediately.

---

### ✨ What's New in v1.1.7

#### 🔍 Windows-Aware Path Normalization (`strip_root_prefix`)
- **Fixes Silent Local Sync Failure**: On Windows, OS filesystem notifications often deliver paths with uppercase/lowercase drive letter variance (e.g. `d:\documents` vs `D:\DOCUMENTS`) or verbatim extended-length UNC prefixes (`\\?\D:\DOCUMENTS`). Standard byte-sensitive prefix comparisons silently rejected these events with `Err`, leaving local edits completely undetected.
- **Robust Multi-Format Stripping**: Implemented a comprehensive Windows path stripper that unifies separators, strips `\\?\` and `\??\` prefixes, and applies case-insensitive NTFS matching. Local additions, modifications, renames, and deletions are now detected instantly and dispatched to Google Drive within 3 seconds.

#### 📁 Recursive Directory Discovery on Creation & Drag-and-Drop
- **Folder Expansion (`expand_dir_files`)**: When whole folders are pasted, dragged, or created inside a synced directory, Twin now recursively discovers and queues all nested child files immediately, ensuring bulk directory moves or copies never drop files.

#### ⏱️ Continuous 60-Second Background Heartbeat Rescan
- **Autonomous Rescan Guarantee**: The Dynamic Pair Supervisor now runs an autonomous local scan every 60 seconds across all active pairs. Even if an OS filesystem watcher notification is dropped during heavy disk I/O, sleep/wake cycles, or buffer overflow, local modifications are guaranteed to be detected and queued for upload without requiring any manual clicks.

#### 🔄 Transient Windows File Lock Retry
- **Graceful Sharing Violation Handling**: When external applications (Notepad, VS Code, Word, or Web Browsers) atomic-save or hold temporary file locks, Twin retries file metadata checks before failing, preventing momentary file locks from dropping sync tasks.

#### ☁️ Remote Changes Feed & Trash Processing
- **Retain Trashed & Tracked Items**: Google Drive v3 omits parent folder metadata on trashed objects. The Changes feed processor now explicitly retains remote trash events and verifies existing SQLite file records directly, guaranteeing remote deletions and modifications propagate immediately into local state.

#### 🎯 Dynamic Supervisor Lifecycle Management
- **Instant Pair Onboarding**: Newly enabled pairs immediately trigger an initial reconciliation cycle upon being enabled.
- **Clean Watcher Teardown**: Disabled pairs cleanly drop their active file watchers, eliminating stale resource consumption.
