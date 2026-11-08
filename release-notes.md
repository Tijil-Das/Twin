# Twin v1.1.3

Maintenance and auto-restart release ensuring Twin automatically relaunches after silent in-app NSIS updates, resolving Google Drive AppData 403 permission errors, and streamlining the overview interface.

---

### ✨ What's New in v1.1.3

#### 🔄 Automatic App Relaunch After Silent In-App Update
- **Instant Relaunch**: Resolved an issue where clicking `<Restart>` on the update notification silently installed the update but did not reopen the application.
- **Synchronous NSIS Completion**: The background update executor now waits for the silent NSIS installer to finish (`-Wait`) and immediately relaunches `Twin.exe`.
- **Seamless Transition**: Installed setups now update completely silently in the background and relaunch seamlessly without requiring manual desktop shortcut clicks.

#### 🛡️ Google Drive Scope & Permissions Resolution
- **Eliminated 403 Forbidden**: Removed the legacy `spaces=appDataFolder` query that produced `HTTP 403 Forbidden (insufficientScopes)` errors.
- **Streamlined Settings**: Removed the experimental "Sync AppData" control; standard folder synchronization operates cleanly within user-granted Google Drive scopes.

#### 🎨 De-Cluttered Overview Controls
- **Drive Explorer Removed**: Cleaned up the sidebar to keep focus strictly on active sync operations.
- **Deduplicated Action Controls**: Removed redundant `Sync All` and `Add Folder` buttons from the top status card, keeping them exclusively in the **Synced Folders** table header.
