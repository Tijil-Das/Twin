# P08 Download + Restore
Read MASTER.md COMMON RULES and SPEC.md. Modules `transfer/download.rs`, `drive/revisions.rs`, `drive/trash.rs`, `drive/export.rs`. Implements `JobRunner` kinds `download`, `restore`.
## Download
- `GET https://www.googleapis.com/drive/v3/files/{id}?alt=media` (+`supportsAllDrives=true`). File > 32 MiB: 4 parallel ranged requests (`Range: bytes=a-b`), each written to its own offset of a pre-sized `.tether-part` temp file in the destination folder (use `std::fs::File` + `seek_write` Windows `FileExt`). Smaller: single stream. Never buffer more than 4 MiB per range at once.
- After finish: verify md5 vs Drive `md5Checksum`, set file mtime to Drive `modifiedTime`, atomic rename over target. Keep `.tether-part` + a sidecar JSON of completed ranges to resume after crash.
- Google-native files (mimeType `application/vnd.google-apps.*`): `files.export?mimeType=` docx/xlsx/pptx/pdf per config `export_format` (default docx/xlsx/pptx). Export limit is 10 MB; on error 403 `exportSizeLimitExceeded` log and skip. No md5 for these; track by `modifiedTime`.
- Shortcuts (`application/vnd.google-apps.shortcut`): skip by default, record in activity.
- Checkpoint + limiter (download_kbps) + real progress exactly as in P07.
## Revisions (docs: https://developers.google.com/drive/api/reference/rest/v3/revisions)
`list_revisions(file_id)` fields `revisions(id,modifiedTime,size,keepForever,lastModifyingUser(displayName))`; `download_revision(file_id,rev_id)` via `revisions/{id}?alt=media`; `set_keep_forever(file_id,rev_id,bool)` via PATCH.
## Trash
`list_trashed(parent_id?)` q=`trashed=true`; `untrash(id)` via PATCH `{trashed:false}`.
## Restore API
```rust
pub async fn restore_file(file_id:&str, rev_id:Option<&str>, dest:PathBuf)->Result<(),AppError>;
pub async fn restore_folder(folder_id:&str, dest:PathBuf)->Result<(),AppError>; // lists recursively with pageSize=1000, enqueues one download job per file, dirs created first
pub async fn restore_from_trash(id:&str)->Result<(),AppError>;
```
Restore never overwrites silently: if dest exists, rename existing to `name (local backup yyyy-mm-dd hhmmss).ext` first.
Commands: `drive_list(parent_id)`, `list_revisions`, `restore_file`, `restore_folder`, `list_trash`, `untrash`, `keep_revision`.
## Done-test
Wiremock tests: ranged download reassembly byte-identical, resume after killed mid-download, md5 mismatch retry, export, revision restore, backup-rename. Manual: restore a 1 GB file with progress bar and ETA.
