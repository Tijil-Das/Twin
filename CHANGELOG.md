# Changelog

All notable changes to **Twin** are documented in this file.
The project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

