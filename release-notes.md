# Twin v1.1.7

Critical reliability release fixing automatic local change detection, Windows path prefix normalization, directory tree expansion, file lock handling, background heartbeat rescan, and two-way Google Drive changes polling.

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
