# Twin v1.2.3

Reliability & edge-case patch release: robust nested folder & cross-directory rename detection, dynamic Google Drive parent resolution, graceful 404 recovery, and deletion race condition prevention.

---

### 🚀 What's New & Fixed in v1.2.3

#### 📂 Nested Folder & Cross-Directory Rename Fixes
- **Dynamic Google Drive Parent Resolution**: Resolved Google Drive API `HTTP 404 Not Found` errors caused by passing relative local paths to parent query parameters (`addParents`/`removeParents`). Parent IDs are now verified and dynamically resolved to real Google Drive folder IDs using `ensure_path` and `find_folder_by_path`.
- **Verified Remote Parent Patching**: The new `move_and_rename_file` engine fetches a file's active parent IDs directly from Google Drive, moving only when parents actually differ and removing only the existing parent IDs without duplicating or leaving orphaned folders.
- **Support for Arbitrarily Nested Folder Moves**: Moving or renaming folders multiple levels deep now properly walks the remote folder hierarchy to find and rename/move the target folder.

#### 🛡️ Graceful 404 Recovery & Self-Healing
- **Automatic Fallback to Clean Upload**: If a file or folder is deleted or missing on Google Drive when a rename or move occurs, the rename job no longer fails or stalls the queue with a 404 error. The engine catches the missing remote resource, resets `drive_id = None`, sets `state = 'dirty'`, and enqueues a fresh upload for the new path so the file is synced seamlessly to Google Drive.

#### ⚡ Deletion Race Condition Prevention
- **Automatic Pending Delete Cancellation**: Renaming a file or directory immediately cancels any pending or queued `delete` jobs for the old path and all nested files (`cancel_jobs_by_path` / `cancel_jobs_by_path_prefix`), preventing delete events from racing ahead and removing files that were just renamed.
- **Pre-Delete State Guard**: The delete worker (`run_delete`) checks whether a file row has transitioned to an active state (`renaming`, `synced`, or `dirty`) before executing cloud deletion, preventing newly moved or renamed files from being accidentally deleted.

#### 🗄️ Database & Watcher Hardening
- **Conflict-Free Folder Path Updates**: `rename_folder_prefix` now utilizes `UPDATE OR REPLACE` in SQLite and updates both `files` and `jobs` tables atomically, eliminating unique constraint failures when moving or copying folders into existing structures.
- **Watcher Rename Detection on File Move/Copy**: File modification events on untracked or deleted-local files now trigger hash and OS identity rename detection, detecting moves and copies instantly without re-uploading unchanged content.

---

# Twin v1.2.2

Feature and reliability release: dynamic pair reconfiguration in the UI with safety confirmations and live reload, active transfer auto-scroll & sorting prioritization, and queue guardrails.

---

### 🚀 What's New & Improved in v1.2.2

#### ⚙️ Dynamic Pair Reconfiguration in Pair Details
- **Sync Topology & Mode Switching**: Easily reconfigure an active pair between **Two-Way Sync** (`two_way`), **Cloud Backup** (`upload`), and **Cloud Mirror** (`mirror`) directly from the pair details screen.
- **Safety Confirmation for Cloud Mirror**: Switching to Mirror mode presents a clear confirmation modal detailing that the local PC folder is the strict source of truth and extraneous remote files on Drive will be removed.
- **Remote Deletion Safety Controls**: Switch anytime between **Drive Trash** (safe 30-day recovery), **Ignore Remote** (never delete from Drive on local removal), and **Permanent Deletion** (with confirmation dialog).
- **Locked Identity Indicators**: Local directory and Google Drive target folders display clear lock badges with explanatory tooltips indicating they are anchored to the local SQLite database and cloud metadata.

#### 🛡️ Advanced Queue & Engine Guardrails
- **Automated Queue Cancellation (`cancel_pair_jobs`)**:
  - Switching a pair to **Cloud Backup (Upload-only)** immediately cancels pending download jobs so remote modifications never overwrite local files.
  - Switching to **Ignore Deletions** immediately cancels pending remote delete jobs.
  - Excluding subfolders cancels pending jobs for those directories.
- **Dynamic Live-Reload for Changes Poller**: The background Google Drive Changes polling loop (`poll_changes_loop`) now dynamically reloads pair configuration on each cycle, instantly respecting mode and deletion changes without requiring an app restart.
- **Worker Execution Guardrails**: Transfer workers in `download.rs` and `upload.rs` verify pair topology and exclusion rules before processing files, skipping any jobs that became obsolete while queued.

#### 📊 Active Transfers Breakdown Auto-Scroll & Priority
- **Active Transfer Prioritization**: In the overview screen's active pair transfer breakdown, actively streaming files with non-zero transfer rates and live byte streams are sorted to the very top (`index 0`).
- **Auto-Scroll to In-Flight Transfer**: The scroll container automatically maintains `scrollTop = 0` whenever active transfers change or complete, keeping the currently transferring file in continuous view.

---

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
