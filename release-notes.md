# Twin v1.1.1

Critical stability release hardening the in-app updater engine to prevent binary corruption, introducing silent NSIS background updates, concise notification alerts, responsive update-checking feedback, and refined GitHub-style directory presentation.

---

### 🛡️ Critical Fixes & Enhancements in v1.1.1

#### 🔒 In-App Updater Hardening & Corruption Prevention
- **Safe Asset Selection**: Resolved a critical issue where the updater could select a `.zip` archive or mismatched binary. Installed setups now strictly download the official NSIS installer (`Twin_{ver}_x64-setup.exe`), while portable builds strictly target `Twin.exe`.
- **Silent NSIS Execution**: For installed applications, updates now execute the NSIS installer silently (`/S`). This safely updates binaries, refreshes Windows Registry uninstaller entries (`DisplayVersion`), and maintains full integration in Windows Installed Apps.
- **PE Magic Header Verification**: All downloaded update payloads are validated against the standard Windows PE executable signature (`0x4D, 0x5A` / `b"MZ"`) before staging. Corrupted or invalid files are rejected and purged immediately.
- **GitHub API Cache Prevention**: Requests to GitHub Releases now enforce `Cache-Control: no-cache` and strict `Accept` headers to guarantee instant discovery of new releases.

#### 💬 Concise Update Notifications & Feedback
- **JioTV Max-Style Alerts**: Streamlined update notification toasts and banners to a clean, actionable prompt: **`Update vX.Y.Z Ready`** with a 1-click **`Restart`** button.
- **Immediate "Check for Updates" Feedback**: Fixed unhandled downloading states in Settings so clicking "Check for Updates" always provides real-time feedback (`downloading`, `ready`, `up to date`, or `error`).

#### 🐙 UI Polish & GitHub Repository Presentation
- **Zero-Overlap Synced Folders**: Resolved layout overlapping in folder pair rows on the Overview dashboard.
- **Clean Metadata**: Removed raw alphanumeric Google Drive IDs and internal links from list views for a distraction-free, professional interface.
- **Pixel-Perfect Brand Integrity**: Enforced strict pixel bounding on Google Drive icons across navigation and explorer views.
