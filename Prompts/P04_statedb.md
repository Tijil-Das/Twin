# P04 State DB
Read MASTER.md COMMON RULES and SPEC.md. Module `src-tauri/src/db/`. File: `data/state.db` (gitignored). rusqlite bundled; WAL mode, `synchronous=NORMAL`; ONE writer thread with a channel, readers use short-lived connections.
## Schema
```sql
CREATE TABLE files(
 pair_id TEXT, rel_path TEXT, size INTEGER, mtime_ms INTEGER, md5 TEXT,
 drive_id TEXT, drive_md5 TEXT, drive_mtime_ms INTEGER, drive_rev TEXT,
 state TEXT,            -- synced|dirty|deleted_local|deleted_remote|conflict|error
 PRIMARY KEY(pair_id, rel_path));
CREATE INDEX idx_files_drive ON files(drive_id);
CREATE TABLE pair_meta(pair_id TEXT PRIMARY KEY, changes_page_token TEXT, last_full_scan_ms INTEGER, last_sync_ms INTEGER);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, pair_id TEXT, kind TEXT, rel_path TEXT, priority INTEGER,
 attempts INTEGER DEFAULT 0, next_try_ms INTEGER, status TEXT, last_error TEXT, created_ms INTEGER);
CREATE TABLE activity(id INTEGER PRIMARY KEY, ts_ms INTEGER, pair_id TEXT, kind TEXT, rel_path TEXT, result TEXT, detail TEXT);
CREATE TABLE upload_sessions(pair_id TEXT, rel_path TEXT, session_uri TEXT, total INTEGER, mtime_ms INTEGER, PRIMARY KEY(pair_id,rel_path));
```
`PRAGMA user_version` migrations: array of SQL steps, apply missing ones.
## API (exact)
```rust
pub struct Db; impl Db {
 pub fn open(path:&Path)->Result<Db,AppError>;
 pub fn get_file(&self,pair:&str,rel:&str)->Result<Option<FileRow>,AppError>;
 pub fn upsert_file(&self,row:FileRow)->Result<(),AppError>;
 pub fn mark_state(&self,pair:&str,rel:&str,st:&str)->Result<(),AppError>;
 pub fn list_dirty(&self,pair:&str,limit:usize)->Result<Vec<FileRow>,AppError>;
 pub fn enqueue(&self,job:NewJob)->Result<i64,AppError>;  // dedupe by (pair,kind,rel_path) while status=queued
 pub fn next_due_job(&self,now_ms:i64)->Result<Option<Job>,AppError>;
 pub fn complete_job(&self,id:i64)->Result<(),AppError>;
 pub fn fail_job(&self,id:i64,err:&str)->Result<(),AppError>; // backoff 2^attempts s, cap 300 s, give up at 8
 pub fn log_activity(&self,a:Activity)->Result<(),AppError>;  // keep last 2000 rows, prune on insert
 pub fn recent_activity(&self,limit:usize)->Result<Vec<Activity>,AppError>;
 pub fn get/set_page_token, get/set_upload_session, delete_upload_session
}
```
Commands: `get_activity`, `retry_job`.
## Done-test
Tests with tempfile: migrations idempotent, dedupe, backoff schedule values, activity pruning at 2000, concurrent upserts from 4 threads without lock errors.
