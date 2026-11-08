# Twin v1.1.6

Critical sync resilience and stability release introducing idempotent Google Drive deletions, automatic recovery from 404/410 errors, child cascade pruning for deleted folders, remote trash event processing, and one-click retry actions.

---

### ✨ What's New in v1.1.6

#### 🛡️ Idempotent Google Drive Deletions & 404 Error Recovery
- **No More False "Failed" Deletions**: Deleting or trashing files on Google Drive that were already deleted, moved to trash, or no longer exist (returning HTTP 404 Not Found or 410 Gone) is now recognized as an idempotent success. The local database immediately marks the file as `trashed` or `deleted` without failing.
- **Eliminated Retries on Non-Existent Remote Items**: Avoids useless 5-attempt retry loops and error noise in the Activity log when files or folders are removed from Drive.

#### 🌲 Parent Folder Deletion Cascade & Prune Isolation
- **Cascade Awareness**: When a remote folder is pruned in Mirror mode, Twin marks all tracked children within that directory tree as deleted/trashed in the database directly. It no longer spawns redundant individual deletion jobs for files whose parent folder was already trashed on Drive.
- **Drive Path Cache Invalidation**: Pruned folders and deleted paths are instantly evicted from the internal path cache to prevent subsequent uploads from referencing deleted parent folder IDs.

#### 🔄 Remote Trash Event Processing in Changes Feed
- **Google Drive Trash Handling**: Google Drive v3 sends remote file deletions with `change.file.trashed = true`. Twin now properly processes these events as remote deletions, safely moving local files to `.twin-trash/` or deleting them according to your pair's deletion safety policy.

#### 🚀 Self-Healing Uploads on Stale Drive IDs
- **Automatic Fallback to New Upload**: If a file exists locally and has an old `drive_id` that was purged or deleted from Google Drive, the upload runner detects the 404 response on `PATCH`, purges the stale remote ID, and transparently re-uploads the file via `POST` as a fresh file without failing.

#### 🧹 Automatic Recovery of Stuck Failed Jobs
- **Self-Healing on Startup & Sync**: Application startup and manual **Sync Now** / **Sync All** cycles automatically re-queue previously failed jobs so that the new resilient handlers can process and complete them cleanly.
- **Home Screen "Retry All" Action**: Added a quick **Retry all** button directly inside the transfer errors banner on the Home screen to instantly re-dispatch all failed jobs.
- **Application Error Boundary**: Added a fallback error boundary wrapping view routes to safeguard against unexpected component crashes.
