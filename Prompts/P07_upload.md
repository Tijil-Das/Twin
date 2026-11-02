# P07 Upload Engine
Read MASTER.md COMMON RULES and SPEC.md. Modules `src-tauri/src/drive/client.rs`, `src-tauri/src/transfer/upload.rs`, `transfer/progress.rs`, `transfer/limiter.rs`. Implements `JobRunner` for kinds `upload`, `delete`, `mkdir`.
## Drive client
One shared `reqwest::Client` (rustls, http2, pool_max_idle_per_host 8, tcp_keepalive 30s, timeout none for bodies/connect 15 s). Every request: Bearer from `auth::access_token()`. Retry on 429/5xx/network with exponential backoff + jitter (max 5), honor `Retry-After`. Docs: https://developers.google.com/drive/api/guides/manage-uploads
Functions: `find_child(parent_id,name)` (files.list q=`'ID' in parents and name='NAME' and trashed=false`, fields `files(id,md5Checksum,modifiedTime,size,mimeType)`), `create_folder`, `ensure_path(pair, rel_dir)` (cache path->id in a HashMap, create missing in order), `trash(id)`, `delete(id)`.
## Upload rules
- Skip if local md5 == Db.drive_md5 and size equal.
- File < 5 MiB: `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart` (create) or `PATCH .../files/{id}?uploadType=multipart` (update, so no duplicates). Fields `id,md5Checksum,modifiedTime,headRevisionId`.
- File >= 5 MiB: resumable. Init `POST ...?uploadType=resumable` (or PATCH for update) with JSON metadata `{name,parents,modifiedTime}` header `X-Upload-Content-Length`. Store `Location` in `upload_sessions`. Send chunks of `chunk_mib` MiB (multiple of 256 KiB) with `Content-Range: bytes a-b/total`; 308 = continue; 200/201 = done. On network error or restart: query `Content-Range: bytes */total`, read `Range` response header, resume from there. Session older than 6 days or 404 -> discard and restart.
- Stream chunks from disk with 1 MiB reads; `gov.checkpoint().await` before each chunk; limiter before each chunk.
- Set `modifiedTime` to local mtime. After success verify returned md5Checksum equals local md5; mismatch -> AppError::Drive("md5 mismatch") retry.
## Bandwidth limiter
Token bucket (`limiter.rs`): `acquire(bytes).await` using tokio time; `upload_kbps=0` is a no-op fast path. Re-read config on change.
## Progress (REAL)
`ProgressTx` sends `Progress{job_id,rel_path,bytes_done,bytes_total,speed_bps,eta_secs}` computed from bytes actually acknowledged by the server (after each chunk and also every 1 MiB inside a chunk via counting stream wrapper). Speed = EMA(alpha 0.2) over 1 s windows; ETA = remaining/speed (None if speed<=0). Batch aggregate: `BatchProgress{files_done,files_total,bytes_done,bytes_total,eta}` from queue totals. Emit Tauri event `transfer://progress` throttled to 4/s per job.
On success update Db (drive_id, drive_md5, drive_rev, state=synced) and log activity. `delete` jobs follow `policy.deletion`.
## Done-test
Wiremock tests: multipart create, resumable with a forced 308 resume after a dropped connection, update-not-duplicate, md5 mismatch retry, 429 Retry-After honored, limiter rate within 5% of setting, progress never exceeds 100% and ends at exactly bytes_total. Manual: upload a 2 GB file; progress bar matches Drive web upload; pause CPU burner -> uploads pause.
