# Twin v1.1.0

Major feature release introducing the **Google Drive Folder Colorizer**, a comprehensive **GitHub-Style Repository Item Viewer** for both Drive Explorer and Synced Folders, automated continuous startup delta synchronization, multi-layer deduplication, and hardened transfer resilience.

---

### ✨ What's New in v1.1.0

#### 🎨 Google Drive Folder Colorizer
- **Interactive 24-Color Palette**: Customize Google Drive folder colors using Google's official color palette directly within Twin.
- **Single & Multi-Folder Selection**: Colorize individual folders or select multiple directories to apply uniform color theming in a single click.
- **Drive Color Swatches**: Folder colors are rendered natively across the Drive Explorer tree and directory browser.

#### 🐙 GitHub-Style Repository Presentation
- **Drive Explorer Overhaul**: Redesigned remote file viewer matching GitHub's repository tree interface (`#0d1117` canvas, `#161b22` header bar, `#30363d` subtle borders, breadcrumb navigation, and `..` parent directory traversal).
- **Synced Folders Table**: Modern single-row presentation for active folder pairs on the Overview dashboard with Octicon folder icons, mode badges (`Mirror`, `Two-Way`, `Backup`), and inline controls.
- **Clean Layout**: Completely eliminated raw alphanumeric Drive IDs and metadata clutter from list items.

#### 🔄 Autonomous Delta Loop & Startup Gap Sync
- **Continuous Gap Reconciliation**: Automatically scans and detects unsynced or modified files on startup and runs in an automated background loop.
- **Live Sync Tick Badge**: Real-time indicator displaying synchronized health status without requiring manual "Sync All" triggers.

#### 🛡️ Multi-Layer Deduplication & Mirror Pruning
- **Zero-Duplicate Upload Engine**: MD5 checksum, filename, and parent folder deduplication ensures cloud folders are never duplicated during uploads or network interruptions.
- **Rogue Folder Pruning**: Mirror mode automatically detects and prunes extra or orphaned remote directories to maintain 1:1 local parity.

#### ⚡ Transfer Resilience & Drive Rate Limiting
- **Exponential Jittered Backoff**: Native parsing of Google Drive `Retry-After` response headers to gracefully back off and recover during transient 503 Service Unavailable and 429 Rate Limit conditions.
- **Job Auto-Recovery**: Interrupted or in-flight transfer sessions automatically resume from where they left off without re-uploading completed chunks.

#### 📐 Strict Branding & Sizing Integrity
- Embedded official Google Drive branding across navigation, Drive selector dialogs, explorer bars, and account settings with strict pixel-bounding.
