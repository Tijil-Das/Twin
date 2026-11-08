# Changelog

All notable changes to **Twin** are documented in this file.
The project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

