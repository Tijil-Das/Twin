# Twin v1.1.2

Refinement and stability release eliminating Drive permission errors, streamlining the desktop overview interface, and validating the silent in-app update pipeline.

---

### ✨ What's New in v1.1.2

#### 🛡️ Google Drive Scope Resolution
- **Removed Hidden AppData Query**: Eliminated the `spaces=appDataFolder` API call that caused `HTTP 403 Forbidden (insufficientScopes)`.
- **Clean Settings Card**: Removed the experimental "Sync AppData" button from Settings; standard folder synchronization now operates cleanly within the granted Google Drive permissions.
- **Resource Optimization**: Stopped background polling against the restricted application data space.

#### 🎨 Interface Streamlining & De-Cluttering
- **Drive Explorer Navigation Removed**: Removed the Drive Explorer navigation item and screen for a focused, streamlined sync-centric experience.
- **Deduplicated Action Controls**: Removed redundant `Sync All` and `Add Folder` buttons from the top Overview card, consolidating them into the **Synced Folders** table header.
- **Cleaner Engine Control**: The top Overview card now focuses strictly on engine telemetry with a single **Pause Engine** / **Resume Engine** action.

#### 🔄 Verified Auto-Update Pipeline
- Users on **v1.1.1** will receive this update automatically and silently via the background NSIS updater with the concise `"Update v1.1.2 Ready"` restart prompt.
