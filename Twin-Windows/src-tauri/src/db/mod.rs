//! P04 – SQLite state DB
//!
//! Single file at `data/state.db`; WAL + NORMAL durability.
//! One writer path (mutations use `&self` with an internal Mutex); readers
//! also go through the same connection under the same lock – this is a
//! desktop app so a single shared connection is fine.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::error::AppError;

// ── migrations ────────────────────────────────────────────────────────────────

/// Each entry is applied exactly once, in order, using `PRAGMA user_version`.
static MIGRATIONS: &[&str] = &[
    // version 1 – initial schema
    r#"
    CREATE TABLE IF NOT EXISTS files(
        pair_id         TEXT NOT NULL,
        rel_path        TEXT NOT NULL,
        size            INTEGER,
        mtime_ms        INTEGER,
        md5             TEXT,
        drive_id        TEXT,
        drive_md5       TEXT,
        drive_mtime_ms  INTEGER,
        drive_rev       TEXT,
        state           TEXT NOT NULL DEFAULT 'dirty',
        PRIMARY KEY(pair_id, rel_path)
    );
    CREATE INDEX IF NOT EXISTS idx_files_drive ON files(drive_id);

    CREATE TABLE IF NOT EXISTS pair_meta(
        pair_id             TEXT PRIMARY KEY,
        changes_page_token  TEXT,
        last_full_scan_ms   INTEGER,
        last_sync_ms        INTEGER
    );

    CREATE TABLE IF NOT EXISTS jobs(
        id          INTEGER PRIMARY KEY,
        pair_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        rel_path    TEXT NOT NULL,
        priority    INTEGER NOT NULL DEFAULT 0,
        attempts    INTEGER NOT NULL DEFAULT 0,
        next_try_ms INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'queued',
        last_error  TEXT,
        created_ms  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity(
        id       INTEGER PRIMARY KEY,
        ts_ms    INTEGER NOT NULL,
        pair_id  TEXT NOT NULL,
        kind     TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        result   TEXT NOT NULL,
        detail   TEXT
    );

    CREATE TABLE IF NOT EXISTS upload_sessions(
        pair_id    TEXT NOT NULL,
        rel_path   TEXT NOT NULL,
        session_uri TEXT NOT NULL,
        total      INTEGER NOT NULL,
        mtime_ms   INTEGER NOT NULL,
        PRIMARY KEY(pair_id, rel_path)
    );
    "#,
];

const MAX_ACTIVITY_ROWS: i64 = 2000;
const MAX_JOB_ATTEMPTS: i64 = 8;
const MAX_BACKOFF_SECS: i64 = 300;

// ── row types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRow {
    pub pair_id: String,
    pub rel_path: String,
    pub size: Option<i64>,
    pub mtime_ms: Option<i64>,
    pub md5: Option<String>,
    pub drive_id: Option<String>,
    pub drive_md5: Option<String>,
    pub drive_mtime_ms: Option<i64>,
    pub drive_rev: Option<String>,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewJob {
    pub pair_id: String,
    pub kind: String,
    pub rel_path: String,
    pub priority: i64,
    pub created_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: i64,
    pub pair_id: String,
    pub kind: String,
    pub rel_path: String,
    pub priority: i64,
    pub attempts: i64,
    pub next_try_ms: i64,
    pub status: String,
    pub last_error: Option<String>,
    pub created_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    pub id: Option<i64>,
    pub ts_ms: i64,
    pub pair_id: String,
    pub kind: String,
    pub rel_path: String,
    pub result: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveJobSummary {
    pub id: i64,
    pub kind: String,
    pub rel_path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairSyncStatus {
    pub pair_id: String,
    pub queued: i64,
    pub running: i64,
    pub failed: i64,
    pub dirty: i64,
    pub conflict: i64,
    pub synced: i64,
    pub total: i64,
    pub is_synced: bool,
    #[serde(default)]
    pub deleted: i64,
    #[serde(default)]
    pub active_jobs: Vec<ActiveJobSummary>,
    #[serde(default)]
    pub last_activity: Option<Activity>,
    #[serde(default)]
    pub last_sync_ms: Option<i64>,
}

// ── Db ────────────────────────────────────────────────────────────────────────

pub struct Db {
    conn: Mutex<Connection>,
    #[allow(dead_code)]
    path: std::path::PathBuf,
}

fn is_corrupt_err(e: &AppError) -> bool {
    let msg = e.to_string().to_lowercase();
    msg.contains("corrupt")
        || msg.contains("malformed")
        || msg.contains("not a database")
        || msg.contains("integrity check failed")
        || msg.contains("file is not a database")
        || msg.contains("database disk image")
        || msg.contains("disk i/o error")
        || msg.contains("unsupported file format")
}

impl Db {
    /// Open (and migrate) the SQLite database at `path`.
    /// On detected database corruption, automatically archives the corrupt database
    /// to `<filename>.corrupt-<ts>` and rebuilds a clean database without panicking.
    pub fn open(path: &Path) -> Result<Db, AppError> {
        Self::open_inner(path, true)
    }

    fn open_inner(path: &Path, recover_on_corrupt: bool) -> Result<Db, AppError> {
        // Ensure parent directory exists.
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Db(format!("create data dir: {e}")))?;
        }

        let open_res = (|| -> Result<Db, AppError> {
            let conn = Connection::open(path)
                .map_err(|e| AppError::Db(format!("open db: {e}")))?;

            // WAL mode + NORMAL durability + 5s busy timeout.
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;")
                .map_err(|e| AppError::Db(format!("pragma: {e}")))?;

            // Full integrity check on open
            let check: String = conn
                .query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))
                .unwrap_or_else(|_| "corrupt".into());
            if check != "ok" {
                return Err(AppError::Db(format!("integrity check failed: {check}")));
            }

            // Run migrations.
            let db = Db { conn: Mutex::new(conn), path: path.to_path_buf() };
            db.migrate()?;

            // Re-queue any jobs left in 'running' from a previous crash/shutdown
            if let Ok(count) = db.reset_stale_running_jobs() {
                if count > 0 {
                    tracing::info!("Startup: recovered {count} interrupted running job(s) back to queued");
                }
            }

            Ok(db)
        })();

        match open_res {
            Ok(db) => Ok(db),
            Err(e) if recover_on_corrupt && is_corrupt_err(&e) => {
                let now_ns = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let stem = path.file_name().and_then(|n| n.to_str()).unwrap_or("state.db");
                let corrupt_name = format!("{stem}.corrupt-{now_ns}");
                let corrupt_path = path.with_file_name(corrupt_name);
                tracing::warn!("DB corrupt ({e}); moving to {} and rebuilding", corrupt_path.display());

                if std::fs::rename(path, &corrupt_path).is_err() {
                    let _ = std::fs::copy(path, &corrupt_path);
                    let _ = std::fs::remove_file(path);
                }
                let _ = std::fs::remove_file(format!("{}-wal", path.display()));
                let _ = std::fs::remove_file(format!("{}-shm", path.display()));

                Self::open_inner(path, false)
            }
            Err(e) => Err(e),
        }
    }

    /// Run full `PRAGMA integrity_check` returning true if "ok".
    pub fn check_integrity(&self) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let res: String = conn
            .query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))
            .map_err(|e| AppError::Db(format!("integrity_check: {e}")))?;
        Ok(res == "ok")
    }

    /// Run `PRAGMA foreign_key_check` returning true if 0 errors.
    pub fn check_foreign_keys(&self) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check()", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(count == 0)
    }

    fn migrate(&self) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;

        let current: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| AppError::Db(format!("user_version: {e}")))?;

        let target = MIGRATIONS.len() as i64;
        if current >= target {
            return Ok(());
        }

        for (idx, migration) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            conn.execute_batch(migration)
                .map_err(|e| AppError::Db(format!("migration {}: {e}", idx + 1)))?;
            // user_version cannot be set with a bound parameter.
            let new_ver = (idx + 1) as i64;
            conn.execute_batch(&format!("PRAGMA user_version = {new_ver}"))
                .map_err(|e| AppError::Db(format!("set user_version: {e}")))?;
            info!("DB migration {} applied", new_ver);
        }

        Ok(())
    }

    // ── files ────────────────────────────────────────────────────────────────

    pub fn get_file(&self, pair: &str, rel: &str) -> Result<Option<FileRow>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.query_row(
            "SELECT pair_id,rel_path,size,mtime_ms,md5,drive_id,drive_md5,drive_mtime_ms,drive_rev,state
             FROM files WHERE pair_id=?1 AND rel_path=?2",
            params![pair, rel],
            row_to_file,
        )
        .optional()
        .map_err(|e| AppError::Db(format!("get_file: {e}")))
    }

    /// Find any file row across any pair matching rel_path that has an associated Google Drive ID.
    pub fn find_any_file_by_rel_path(&self, rel: &str) -> Result<Option<FileRow>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.query_row(
            "SELECT pair_id,rel_path,size,mtime_ms,md5,drive_id,drive_md5,drive_mtime_ms,drive_rev,state
             FROM files WHERE rel_path=?1 AND drive_id IS NOT NULL ORDER BY mtime_ms DESC LIMIT 1",
            params![rel],
            row_to_file,
        )
        .optional()
        .map_err(|e| AppError::Db(format!("find_any_file_by_rel_path: {e}")))
    }

    pub fn upsert_file(&self, row: FileRow) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "INSERT INTO files(pair_id,rel_path,size,mtime_ms,md5,drive_id,drive_md5,drive_mtime_ms,drive_rev,state)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(pair_id,rel_path) DO UPDATE SET
               size=excluded.size, mtime_ms=excluded.mtime_ms, md5=excluded.md5,
               drive_id=excluded.drive_id, drive_md5=excluded.drive_md5,
               drive_mtime_ms=excluded.drive_mtime_ms, drive_rev=excluded.drive_rev,
               state=excluded.state",
            params![
                row.pair_id, row.rel_path, row.size, row.mtime_ms, row.md5,
                row.drive_id, row.drive_md5, row.drive_mtime_ms, row.drive_rev, row.state
            ],
        )
        .map_err(|e| AppError::Db(format!("upsert_file: {e}")))?;
        Ok(())
    }

    /// Store Google Drive metadata for a file without touching local fields.
    /// Inserts a row if the file is not tracked yet.
    pub fn set_drive_meta(
        &self,
        pair: &str,
        rel: &str,
        drive_id: &str,
        drive_md5: Option<&str>,
        drive_mtime_ms: Option<i64>,
        drive_rev: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "INSERT INTO files(pair_id,rel_path,size,mtime_ms,md5,drive_id,drive_md5,drive_mtime_ms,drive_rev,state)
             VALUES(?1,?2,NULL,NULL,NULL,?3,?4,?5,?6,'dirty')
             ON CONFLICT(pair_id,rel_path) DO UPDATE SET
               drive_id=excluded.drive_id, drive_md5=excluded.drive_md5,
               drive_mtime_ms=excluded.drive_mtime_ms, drive_rev=excluded.drive_rev",
            params![pair, rel, drive_id, drive_md5, drive_mtime_ms, drive_rev],
        )
        .map_err(|e| AppError::Db(format!("set_drive_meta: {e}")))?;
        Ok(())
    }

    /// Forget the Drive object associated with a local file (e.g. it was
    /// removed remotely) and mark it dirty so the next upload recreates it.
    pub fn clear_drive_meta(&self, pair: &str, rel: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "UPDATE files
                SET drive_id=NULL, drive_md5=NULL, drive_mtime_ms=NULL, drive_rev=NULL,
                    state='dirty'
              WHERE pair_id=?1 AND rel_path=?2",
            params![pair, rel],
        )
        .map_err(|e| AppError::Db(format!("clear_drive_meta: {e}")))?;
        Ok(())
    }

    pub fn mark_state(&self, pair: &str, rel: &str, st: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "UPDATE files SET state=?1 WHERE pair_id=?2 AND rel_path=?3",
            params![st, pair, rel],
        )
        .map_err(|e| AppError::Db(format!("mark_state: {e}")))?;
        Ok(())
    }

    pub fn list_dirty(&self, pair: &str, limit: usize) -> Result<Vec<FileRow>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let mut stmt = conn
            .prepare(
                "SELECT pair_id,rel_path,size,mtime_ms,md5,drive_id,drive_md5,drive_mtime_ms,drive_rev,state
                 FROM files WHERE pair_id=?1 AND state='dirty' LIMIT ?2",
            )
            .map_err(|e| AppError::Db(format!("list_dirty prepare: {e}")))?;

        let rows = stmt
            .query_map(params![pair, limit as i64], row_to_file)
            .map_err(|e| AppError::Db(format!("list_dirty query: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Db(format!("list_dirty collect: {e}")))?;

        Ok(rows)
    }

    pub fn delete_file(&self, pair: &str, rel: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "DELETE FROM files WHERE pair_id=?1 AND rel_path=?2",
            params![pair, rel],
        )
        .map_err(|e| AppError::Db(format!("delete_file: {e}")))?;
        Ok(())
    }

    // ── jobs ─────────────────────────────────────────────────────────────────

    /// Insert a job, but only if no queued job already exists for (pair, kind, rel_path).
    pub fn enqueue(&self, job: NewJob) -> Result<i64, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;

        // Dedupe: return existing id if already queued or running.
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM jobs WHERE pair_id=?1 AND kind=?2 AND rel_path=?3 AND (status='queued' OR status='running')",
                params![job.pair_id, job.kind, job.rel_path],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| AppError::Db(format!("enqueue dedupe: {e}")))?;

        if let Some(id) = existing {
            return Ok(id);
        }

        // Avoid enqueuing duplicate upload jobs if the file is already fully
        // synced with Drive. A stale "synced" row whose local md5 differs from
        // the recorded Drive md5 must still be allowed to upload.
        if job.kind == "upload" {
            let is_synced: bool = conn
                .query_row(
                    "SELECT 1 FROM files WHERE pair_id=?1 AND rel_path=?2
                       AND state='synced' AND drive_id IS NOT NULL
                       AND md5 IS NOT NULL AND drive_md5 IS NOT NULL AND md5 = drive_md5",
                    params![job.pair_id, job.rel_path],
                    |_| Ok(()),
                )
                .optional()
                .unwrap_or(None)
                .is_some();
            if is_synced {
                return Ok(0);
            }
        }

        conn.execute(
            "INSERT INTO jobs(pair_id,kind,rel_path,priority,attempts,next_try_ms,status,created_ms)
             VALUES(?1,?2,?3,?4,0,0,'queued',?5)",
            params![job.pair_id, job.kind, job.rel_path, job.priority, job.created_ms],
        )
        .map_err(|e| AppError::Db(format!("enqueue insert: {e}")))?;

        Ok(conn.last_insert_rowid())
    }

    /// Return the highest-priority job whose `next_try_ms <= now_ms` and status='queued'.
    pub fn next_due_job(&self, now_ms: i64) -> Result<Option<Job>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        // Fetch the next queued job and atomically mark it 'running' so the
        // dispatcher never double-picks the same row.
        let job = conn.query_row(
            "SELECT id,pair_id,kind,rel_path,priority,attempts,next_try_ms,status,last_error,created_ms
             FROM jobs WHERE status='queued' AND next_try_ms<=?1
             ORDER BY priority DESC, id ASC LIMIT 1",
            params![now_ms],
            row_to_job,
        )
        .optional()
        .map_err(|e| AppError::Db(format!("next_due_job: {e}")))?;

        if let Some(ref j) = job {
            conn.execute(
                "UPDATE jobs SET status='running' WHERE id=?1",
                params![j.id],
            )
            .map_err(|e| AppError::Db(format!("next_due_job mark running: {e}")))?;
        }

        Ok(job)
    }

    pub fn complete_job(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "UPDATE jobs SET status='done' WHERE id=?1",
            params![id],
        )
        .map_err(|e| AppError::Db(format!("complete_job: {e}")))?;
        Ok(())
    }

    /// Reset any leftover 'running' jobs back to 'queued' so interrupted transfers resume immediately.
    pub fn reset_stale_running_jobs(&self) -> Result<usize, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let count = conn.execute("UPDATE jobs SET status='queued' WHERE status='running'", [])
            .map_err(|e| AppError::Db(format!("reset running jobs: {e}")))?;
        Ok(count)
    }

    /// Exponential backoff: `2^attempts` seconds, capped at `MAX_BACKOFF_SECS`.
    /// After `MAX_JOB_ATTEMPTS` the job is marked `failed` permanently.
    pub fn fail_job(&self, id: i64, err: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;

        let attempts: i64 = conn
            .query_row(
                "SELECT attempts FROM jobs WHERE id=?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| AppError::Db(format!("fail_job read: {e}")))?;

        let new_attempts = attempts + 1;
        if new_attempts >= MAX_JOB_ATTEMPTS {
            conn.execute(
                "UPDATE jobs SET status='failed', attempts=?1, last_error=?2 WHERE id=?3",
                params![new_attempts, err, id],
            )
            .map_err(|e| AppError::Db(format!("fail_job mark failed: {e}")))?;
        } else {
            // Compute delay: 2^new_attempts seconds, capped.
            let delay_secs = (1i64 << new_attempts).min(MAX_BACKOFF_SECS);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            let next_try = now + delay_secs * 1000;
            conn.execute(
                "UPDATE jobs SET status='queued', attempts=?1, next_try_ms=?2, last_error=?3 WHERE id=?4",
                params![new_attempts, next_try, err, id],
            )
            .map_err(|e| AppError::Db(format!("fail_job reschedule: {e}")))?;
        }

        Ok(())
    }

    /// Count jobs with the given status string.
    pub fn count_jobs_by_status(&self, status: &str) -> Result<i64, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status=?1",
            params![status],
            |r| r.get(0),
        )
        .map_err(|e| AppError::Db(format!("count_jobs: {e}")))
    }

    /// Re-queue failed jobs (optionally filtered by pair_id).
    pub fn retry_failed_jobs(&self, pair_id: Option<&str>) -> Result<usize, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let count = match pair_id {
            Some(pid) => conn.execute(
                "UPDATE jobs SET status='queued', attempts=0, next_try_ms=0, last_error=NULL
                 WHERE pair_id=?1 AND status='failed'",
                params![pid],
            ),
            None => conn.execute(
                "UPDATE jobs SET status='queued', attempts=0, next_try_ms=0, last_error=NULL
                 WHERE status='failed'",
                [],
            ),
        }
        .map_err(|e| AppError::Db(format!("retry_failed_jobs: {e}")))?;
        Ok(count)
    }

    // ── activity ─────────────────────────────────────────────────────────────

    /// Insert an activity row, then prune so at most `MAX_ACTIVITY_ROWS` remain.
    pub fn log_activity(&self, a: Activity) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;

        conn.execute(
            "INSERT INTO activity(ts_ms,pair_id,kind,rel_path,result,detail)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![a.ts_ms, a.pair_id, a.kind, a.rel_path, a.result, a.detail],
        )
        .map_err(|e| AppError::Db(format!("log_activity insert: {e}")))?;

        // Prune: delete oldest rows beyond the cap.
        conn.execute(
            "DELETE FROM activity WHERE id NOT IN (
                SELECT id FROM activity ORDER BY id DESC LIMIT ?1
             )",
            params![MAX_ACTIVITY_ROWS],
        )
        .map_err(|e| AppError::Db(format!("log_activity prune: {e}")))?;

        Ok(())
    }

    pub fn recent_activity(&self, limit: usize) -> Result<Vec<Activity>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let mut stmt = conn
            .prepare(
                "SELECT id,ts_ms,pair_id,kind,rel_path,result,detail
                 FROM activity ORDER BY id DESC LIMIT ?1",
            )
            .map_err(|e| AppError::Db(format!("recent_activity prepare: {e}")))?;

        let rows = stmt
            .query_map(params![limit as i64], row_to_activity)
            .map_err(|e| AppError::Db(format!("recent_activity query: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Db(format!("recent_activity collect: {e}")))?;

        Ok(rows)
    }

    // ── pair_meta ─────────────────────────────────────────────────────────────

    pub fn get_page_token(&self, pair: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let result: rusqlite::Result<Option<String>> = conn.query_row(
            "SELECT changes_page_token FROM pair_meta WHERE pair_id=?1",
            params![pair],
            |r| r.get(0),
        );
        match result {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Db(format!("get_page_token: {e}"))),
        }
    }

    pub fn set_page_token(&self, pair: &str, token: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "INSERT INTO pair_meta(pair_id,changes_page_token) VALUES(?1,?2)
             ON CONFLICT(pair_id) DO UPDATE SET changes_page_token=excluded.changes_page_token",
            params![pair, token],
        )
        .map_err(|e| AppError::Db(format!("set_page_token: {e}")))?;
        Ok(())
    }

    // ── GitHub sync helpers ────────────────────────────────────────────────────

    /// Retrieve the `last_sync_ms` timestamp for a pair (GitHub push timestamp).
    pub fn get_last_sync_ms(&self, pair: &str) -> Result<Option<i64>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let result: rusqlite::Result<Option<i64>> = conn.query_row(
            "SELECT last_sync_ms FROM pair_meta WHERE pair_id=?1",
            params![pair],
            |r| r.get(0),
        );
        match result {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Db(format!("get_last_sync_ms: {e}"))),
        }
    }

    /// Insert or update `pair_meta` fields selectively (None = leave existing value).
    pub fn upsert_pair_meta(
        &self,
        pair: &str,
        token: Option<&str>,
        last_sync_ms: Option<i64>,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "INSERT INTO pair_meta(pair_id, changes_page_token, last_sync_ms)
             VALUES(?1, ?2, ?3)
             ON CONFLICT(pair_id) DO UPDATE SET
               changes_page_token = COALESCE(excluded.changes_page_token, changes_page_token),
               last_sync_ms       = COALESCE(excluded.last_sync_ms,       last_sync_ms)",
            params![pair, token, last_sync_ms],
        )
        .map_err(|e| AppError::Db(format!("upsert_pair_meta: {e}")))?;
        Ok(())
    }

    // ── upload_sessions ───────────────────────────────────────────────────────

    pub fn get_upload_session(
        &self,
        pair: &str,
        rel: &str,
    ) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.query_row(
            "SELECT session_uri FROM upload_sessions WHERE pair_id=?1 AND rel_path=?2",
            params![pair, rel],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| AppError::Db(format!("get_upload_session: {e}")))
    }

    pub fn set_upload_session(
        &self,
        pair: &str,
        rel: &str,
        uri: &str,
        total: i64,
        mtime_ms: i64,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "INSERT INTO upload_sessions(pair_id,rel_path,session_uri,total,mtime_ms)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(pair_id,rel_path) DO UPDATE SET
               session_uri=excluded.session_uri, total=excluded.total, mtime_ms=excluded.mtime_ms",
            params![pair, rel, uri, total, mtime_ms],
        )
        .map_err(|e| AppError::Db(format!("set_upload_session: {e}")))?;
        Ok(())
    }

    pub fn delete_upload_session(&self, pair: &str, rel: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.execute(
            "DELETE FROM upload_sessions WHERE pair_id=?1 AND rel_path=?2",
            params![pair, rel],
        )
        .map_err(|e| AppError::Db(format!("delete_upload_session: {e}")))?;
        Ok(())
    }

    /// List all file rows for a pair (all states).
    pub fn list_all_files(&self, pair: &str) -> Result<Vec<FileRow>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let mut stmt = conn
            .prepare(
                "SELECT pair_id,rel_path,size,mtime_ms,md5,drive_id,drive_md5,drive_mtime_ms,drive_rev,state
                 FROM files WHERE pair_id=?1",
            )
            .map_err(|e| AppError::Db(format!("list_all_files prepare: {e}")))?;

        let rows = stmt
            .query_map(params![pair], row_to_file)
            .map_err(|e| AppError::Db(format!("list_all_files query: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Db(format!("list_all_files collect: {e}")))?;

        Ok(rows)
    }

    /// Look up a file row by Drive file id (for remote-delete handling).
    pub fn get_file_by_drive_id(&self, pair: &str, drive_id: &str) -> Result<Option<FileRow>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        conn.query_row(
            "SELECT pair_id,rel_path,size,mtime_ms,md5,drive_id,drive_md5,drive_mtime_ms,drive_rev,state
             FROM files WHERE pair_id=?1 AND drive_id=?2",
            params![pair, drive_id],
            row_to_file,
        )
        .optional()
        .map_err(|e| AppError::Db(format!("get_file_by_drive_id: {e}")))
    }

    pub fn get_stats(&self, db_path: &std::path::Path) -> Result<DatabaseStats, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let file_size_bytes = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);
        let total_files: usize = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0)).unwrap_or(0);
        let activity_count: usize = conn.query_row("SELECT COUNT(*) FROM activity", [], |r| r.get(0)).unwrap_or(0);
        let completed_jobs: usize = conn.query_row("SELECT COUNT(*) FROM jobs WHERE status='done'", [], |r| r.get(0)).unwrap_or(0);
        let failed_jobs: usize = conn.query_row("SELECT COUNT(*) FROM jobs WHERE status='failed'", [], |r| r.get(0)).unwrap_or(0);

        Ok(DatabaseStats {
            file_size_bytes,
            total_files,
            activity_count,
            completed_jobs,
            failed_jobs,
        })
    }

    pub fn prune_and_optimize(&self, db_path: &std::path::Path, keep_days: u32, max_rows: usize) -> Result<PruneStats, AppError> {
        let before_size = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;

        let cutoff_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
            - (keep_days as i64 * 86_400_000);

        // 1. Delete activity older than cutoff_ms OR exceeding max_rows
        let act_count_before: usize = conn.query_row("SELECT COUNT(*) FROM activity", [], |r| r.get(0)).unwrap_or(0);
        let _ = conn.execute("DELETE FROM activity WHERE ts_ms < ?1", params![cutoff_ms]);
        let _ = conn.execute(
            "DELETE FROM activity WHERE id NOT IN (
                SELECT id FROM activity ORDER BY id DESC LIMIT ?1
            )",
            params![max_rows],
        );
        let act_count_after: usize = conn.query_row("SELECT COUNT(*) FROM activity", [], |r| r.get(0)).unwrap_or(0);
        let activity_rows_removed = act_count_before.saturating_sub(act_count_after);

        // 2. Delete done and cancelled jobs older than 7 days
        let job_cutoff_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
            - (7 * 86_400_000);
        let jobs_removed = conn.execute(
            "DELETE FROM jobs WHERE (status='done' OR status='cancelled') AND created_at < ?1",
            params![job_cutoff_ms],
        )
        .unwrap_or(0);

        // 3. Compact & optimize
        let _ = conn.execute_batch("
            PRAGMA optimize;
            PRAGMA wal_checkpoint(TRUNCATE);
            VACUUM;
        ");

        let after_size = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);

        Ok(PruneStats {
            activity_rows_removed,
            jobs_removed,
            db_size_before_bytes: before_size,
            db_size_after_bytes: after_size,
        })
    }

    /// Aggregated sync status for all folder pairs (< 1ms execution time).
    pub fn get_all_pair_sync_statuses(&self) -> Result<std::collections::HashMap<String, PairSyncStatus>, AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;

        // 1. Aggregate job counts per pair
        let mut job_stmt = conn
            .prepare(
                "SELECT pair_id, status, count(*)
                 FROM jobs
                 WHERE status IN ('queued', 'running', 'failed')
                 GROUP BY pair_id, status"
            )
            .map_err(|e| AppError::Db(format!("prepare jobs: {e}")))?;

        let mut job_rows = job_stmt
            .query([])
            .map_err(|e| AppError::Db(format!("query jobs: {e}")))?;

        let mut job_map: std::collections::HashMap<(String, String), i64> = std::collections::HashMap::new();
        let mut all_pairs: std::collections::HashSet<String> = std::collections::HashSet::new();

        while let Some(row) = job_rows.next().map_err(|e| AppError::Db(e.to_string()))? {
            let pair_id: String = row.get(0).map_err(|e| AppError::Db(e.to_string()))?;
            let status: String = row.get(1).map_err(|e| AppError::Db(e.to_string()))?;
            let count: i64 = row.get(2).map_err(|e| AppError::Db(e.to_string()))?;
            all_pairs.insert(pair_id.clone());
            job_map.insert((pair_id, status), count);
        }

        // 2. Aggregate active file counts per pair (excluding deleted/tombstone rows)
        let mut file_stmt = conn
            .prepare(
                "SELECT pair_id, state, count(*),
                        SUM(CASE WHEN drive_id IS NOT NULL AND drive_id != '' THEN 1 ELSE 0 END)
                 FROM files
                 WHERE state NOT IN ('deleted', 'deleted_local', 'remote_deleted', 'trashed')
                 GROUP BY pair_id, state"
            )
            .map_err(|e| AppError::Db(format!("prepare files: {e}")))?;

        let mut file_rows = file_stmt
            .query([])
            .map_err(|e| AppError::Db(format!("query files: {e}")))?;

        let mut file_map: std::collections::HashMap<(String, String), (i64, i64)> = std::collections::HashMap::new();
        while let Some(row) = file_rows.next().map_err(|e| AppError::Db(e.to_string()))? {
            let pair_id: String = row.get(0).map_err(|e| AppError::Db(e.to_string()))?;
            let state: String = row.get(1).map_err(|e| AppError::Db(e.to_string()))?;
            let count: i64 = row.get(2).map_err(|e| AppError::Db(e.to_string()))?;
            let with_drive_id: i64 = row.get(3).unwrap_or(0);
            all_pairs.insert(pair_id.clone());
            file_map.insert((pair_id, state), (count, with_drive_id));
        }

        // Count deleted/tombstone files for metrics
        let mut deleted_map: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        if let Ok(mut del_stmt) = conn.prepare(
            "SELECT pair_id, count(*)
             FROM files
             WHERE state IN ('deleted', 'deleted_local', 'remote_deleted', 'trashed')
             GROUP BY pair_id"
        ) {
            if let Ok(mut del_rows) = del_stmt.query([]) {
                while let Ok(Some(row)) = del_rows.next() {
                    let pid: String = row.get(0).unwrap_or_default();
                    let count: i64 = row.get(1).unwrap_or(0);
                    deleted_map.insert(pid, count);
                }
            }
        }

        // 3. Check pair_meta for last scan/sync timestamps
        let mut meta_stmt = conn
            .prepare("SELECT pair_id, last_full_scan_ms, last_sync_ms FROM pair_meta")
            .map_err(|e| AppError::Db(format!("prepare pair_meta: {e}")))?;

        let mut meta_rows = meta_stmt
            .query([])
            .map_err(|e| AppError::Db(format!("query pair_meta: {e}")))?;

        let mut meta_map: std::collections::HashMap<String, (Option<i64>, Option<i64>)> = std::collections::HashMap::new();
        while let Some(row) = meta_rows.next().map_err(|e| AppError::Db(e.to_string()))? {
            let pair_id: String = row.get(0).map_err(|e| AppError::Db(e.to_string()))?;
            let last_scan: Option<i64> = row.get(1).map_err(|e| AppError::Db(e.to_string()))?;
            let last_sync: Option<i64> = row.get(2).map_err(|e| AppError::Db(e.to_string()))?;
            all_pairs.insert(pair_id.clone());
            meta_map.insert(pair_id, (last_scan, last_sync));
        }

        // 4. Fetch active/running/queued jobs per pair
        let mut active_jobs_map: std::collections::HashMap<String, Vec<ActiveJobSummary>> = std::collections::HashMap::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, pair_id, kind, rel_path, status
             FROM jobs
             WHERE status IN ('running', 'queued')
             ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, priority DESC, id ASC
             LIMIT 60"
        ) {
            if let Ok(mut rows) = stmt.query([]) {
                while let Ok(Some(row)) = rows.next() {
                    let id: i64 = row.get(0).unwrap_or(0);
                    let pid: String = row.get(1).unwrap_or_default();
                    let kind: String = row.get(2).unwrap_or_default();
                    let rel_path: String = row.get(3).unwrap_or_default();
                    let status: String = row.get(4).unwrap_or_default();
                    all_pairs.insert(pid.clone());
                    let list = active_jobs_map.entry(pid).or_default();
                    if list.len() < 5 {
                        list.push(ActiveJobSummary { id, kind, rel_path, status });
                    }
                }
            }
        }

        // 5. Fetch most recent activity per pair
        let mut last_activity_map: std::collections::HashMap<String, Activity> = std::collections::HashMap::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT a.id, a.ts_ms, a.pair_id, a.kind, a.rel_path, a.result, a.detail
             FROM activity a
             INNER JOIN (
                 SELECT pair_id, MAX(id) as max_id
                 FROM activity
                 GROUP BY pair_id
             ) m ON a.pair_id = m.pair_id AND a.id = m.max_id"
        ) {
            if let Ok(mut rows) = stmt.query([]) {
                while let Ok(Some(row)) = rows.next() {
                    let pid: String = row.get(2).unwrap_or_default();
                    if let Ok(act) = row_to_activity(row) {
                        last_activity_map.insert(pid, act);
                    }
                }
            }
        }

        let mut statuses = std::collections::HashMap::new();
        for pair_id in all_pairs {
            let queued = job_map.get(&(pair_id.clone(), "queued".into())).copied().unwrap_or(0);
            let running = job_map.get(&(pair_id.clone(), "running".into())).copied().unwrap_or(0);
            let failed = job_map.get(&(pair_id.clone(), "failed".into())).copied().unwrap_or(0);

            let dirty = file_map.get(&(pair_id.clone(), "dirty".into())).map(|(c, _)| *c).unwrap_or(0);
            let conflict = file_map.get(&(pair_id.clone(), "conflict".into())).map(|(c, _)| *c).unwrap_or(0);
            let (synced, _synced_with_drive) = file_map.get(&(pair_id.clone(), "synced".into())).copied().unwrap_or((0, 0));

            let mut total = 0;
            for ((p, _), (c, _)) in &file_map {
                if p == &pair_id {
                    total += *c;
                }
            }

            let deleted = deleted_map.get(&pair_id).copied().unwrap_or(0);
            let (last_scan, last_sync) = meta_map.get(&pair_id).copied().unwrap_or((None, None));
            let last_sync_ms = last_sync.or(last_scan);
            let verified_scan = last_scan.is_some() || last_sync.is_some();

            // Truly synced condition:
            // 0 queued, 0 running, 0 failed, 0 dirty, 0 conflict
            // AND all active files are synced (synced == total, or empty folder verified)
            let is_synced = queued == 0
                && running == 0
                && failed == 0
                && dirty == 0
                && conflict == 0
                && (synced == total || (total == 0 && verified_scan));

            let active_jobs = active_jobs_map.remove(&pair_id).unwrap_or_default();
            let last_activity = last_activity_map.remove(&pair_id);

            statuses.insert(
                pair_id.clone(),
                PairSyncStatus {
                    pair_id,
                    queued,
                    running,
                    failed,
                    dirty,
                    conflict,
                    synced,
                    total,
                    is_synced,
                    deleted,
                    active_jobs,
                    last_activity,
                    last_sync_ms,
                },
            );
        }

        Ok(statuses)
    }

    /// Retrieve sync status for a single folder pair.
    pub fn get_pair_sync_status(&self, pair_id: &str) -> Result<PairSyncStatus, AppError> {
        let mut statuses = self.get_all_pair_sync_statuses()?;
        Ok(statuses.remove(pair_id).unwrap_or_else(|| PairSyncStatus {
            pair_id: pair_id.to_string(),
            queued: 0,
            running: 0,
            failed: 0,
            dirty: 0,
            conflict: 0,
            synced: 0,
            total: 0,
            is_synced: false,
            deleted: 0,
            active_jobs: Vec::new(),
            last_activity: None,
            last_sync_ms: None,
        }))
    }

    /// Checkpoint SQLite WAL file to keep disk space lean and commit WAL pages.
    pub fn checkpoint_wal(&self) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|_| AppError::Db("lock poisoned".into()))?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
        Ok(())
    }
}

// ── row mapping helpers ───────────────────────────────────────────────────────

fn row_to_file(r: &rusqlite::Row<'_>) -> rusqlite::Result<FileRow> {
    Ok(FileRow {
        pair_id: r.get(0)?,
        rel_path: r.get(1)?,
        size: r.get(2)?,
        mtime_ms: r.get(3)?,
        md5: r.get(4)?,
        drive_id: r.get(5)?,
        drive_md5: r.get(6)?,
        drive_mtime_ms: r.get(7)?,
        drive_rev: r.get(8)?,
        state: r.get(9)?,
    })
}

fn row_to_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job {
        id: r.get(0)?,
        pair_id: r.get(1)?,
        kind: r.get(2)?,
        rel_path: r.get(3)?,
        priority: r.get(4)?,
        attempts: r.get(5)?,
        next_try_ms: r.get(6)?,
        status: r.get(7)?,
        last_error: r.get(8)?,
        created_ms: r.get(9)?,
    })
}

fn row_to_activity(r: &rusqlite::Row<'_>) -> rusqlite::Result<Activity> {
    Ok(Activity {
        id: r.get(0)?,
        ts_ms: r.get(1)?,
        pair_id: r.get(2)?,
        kind: r.get(3)?,
        rel_path: r.get(4)?,
        result: r.get(5)?,
        detail: r.get(6)?,
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Return the last `limit` activity rows.
#[tauri::command]
pub fn get_activity(
    state: tauri::State<'_, DbState>,
    limit: usize,
) -> Result<Vec<Activity>, String> {
    state
        .0
        .recent_activity(limit)
        .map_err(|e| e.to_string())
}

/// Re-queue a failed job.
#[tauri::command]
pub fn retry_job(state: tauri::State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.0.conn.lock().map_err(|_| "lock poisoned".to_string())?;
    conn.execute(
        "UPDATE jobs SET status='queued', attempts=0, next_try_ms=0, last_error=NULL
         WHERE id=?1 AND status='failed'",
        params![id],
    )
    .map_err(|e| format!("retry_job: {e}"))?;
    Ok(())
}

/// Re-queue all failed jobs.
#[tauri::command]
pub fn retry_all_failed(state: tauri::State<'_, DbState>) -> Result<usize, String> {
    state.0.retry_failed_jobs(None).map_err(|e| e.to_string())
}

/// Trigger a passive SQLite WAL checkpoint.
#[tauri::command]
pub fn db_checkpoint_wal(state: tauri::State<'_, DbState>) -> Result<(), String> {
    state.0.checkpoint_wal().map_err(|e| e.to_string())
}

/// Retrieve real-time sync statuses for all folder pairs (< 1ms execution).
#[tauri::command]
pub fn get_pair_statuses(
    state: tauri::State<'_, DbState>,
) -> Result<std::collections::HashMap<String, PairSyncStatus>, String> {
    state.0.get_all_pair_sync_statuses().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseStats {
    pub file_size_bytes: u64,
    pub total_files: usize,
    pub activity_count: usize,
    pub completed_jobs: usize,
    pub failed_jobs: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PruneStats {
    pub activity_rows_removed: usize,
    pub jobs_removed: usize,
    pub db_size_before_bytes: u64,
    pub db_size_after_bytes: u64,
}

#[tauri::command]
pub fn get_database_stats(state: tauri::State<'_, DbState>) -> Result<DatabaseStats, String> {
    state.0.get_stats(&state.1).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn run_database_maintenance(
    state: tauri::State<'_, DbState>,
    keep_days: Option<u32>,
    max_rows: Option<usize>,
) -> Result<PruneStats, String> {
    state.0.prune_and_optimize(&state.1, keep_days.unwrap_or(30), max_rows.unwrap_or(5000)).map_err(|e| e.to_string())
}

/// Tauri managed state wrapper.
pub struct DbState(pub Db, pub std::path::PathBuf);

impl DbState {
    pub fn db_path(&self) -> std::path::PathBuf {
        self.1.clone()
    }
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn temp_db() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.db");
        let db = Db::open(&path).unwrap();
        (dir, db)
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn sample_file(pair: &str, rel: &str) -> FileRow {
        FileRow {
            pair_id: pair.into(),
            rel_path: rel.into(),
            size: Some(1024),
            mtime_ms: Some(1_700_000_000_000),
            md5: Some("abc123".into()),
            drive_id: None,
            drive_md5: None,
            drive_mtime_ms: None,
            drive_rev: None,
            state: "dirty".into(),
        }
    }

    // ── migrations idempotent ────────────────────────────────────────────────

    #[test]
    fn migrations_idempotent() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.db");
        // Open twice; second open must not error.
        let _db1 = Db::open(&path).unwrap();
        let _db2 = Db::open(&path).unwrap();
    }

    // ── upsert + get ─────────────────────────────────────────────────────────

    #[test]
    fn upsert_and_get_file() {
        let (_dir, db) = temp_db();
        let row = sample_file("p1", "foo/bar.txt");
        db.upsert_file(row.clone()).unwrap();

        let got = db.get_file("p1", "foo/bar.txt").unwrap().unwrap();
        assert_eq!(got.md5.as_deref(), Some("abc123"));
        assert_eq!(got.state, "dirty");
    }

    #[test]
    fn mark_state_updates_row() {
        let (_dir, db) = temp_db();
        db.upsert_file(sample_file("p1", "a.txt")).unwrap();
        db.mark_state("p1", "a.txt", "synced").unwrap();
        let got = db.get_file("p1", "a.txt").unwrap().unwrap();
        assert_eq!(got.state, "synced");
    }

    #[test]
    fn list_dirty_returns_only_dirty() {
        let (_dir, db) = temp_db();
        db.upsert_file(sample_file("p1", "a.txt")).unwrap();
        db.upsert_file(sample_file("p1", "b.txt")).unwrap();
        db.mark_state("p1", "b.txt", "synced").unwrap();

        let dirty = db.list_dirty("p1", 100).unwrap();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].rel_path, "a.txt");
    }

    // ── job dedupe ───────────────────────────────────────────────────────────

    #[test]
    fn enqueue_dedupes_queued_jobs() {
        let (_dir, db) = temp_db();
        let job = NewJob {
            pair_id: "p1".into(),
            kind: "upload".into(),
            rel_path: "x.txt".into(),
            priority: 5,
            created_ms: now_ms(),
        };
        let id1 = db.enqueue(job.clone()).unwrap();
        let id2 = db.enqueue(job.clone()).unwrap();
        assert_eq!(id1, id2, "duplicate enqueue must return same id");
    }

    #[test]
    fn enqueue_allows_after_completion() {
        let (_dir, db) = temp_db();
        let job = NewJob {
            pair_id: "p1".into(),
            kind: "upload".into(),
            rel_path: "x.txt".into(),
            priority: 5,
            created_ms: now_ms(),
        };
        let id1 = db.enqueue(job.clone()).unwrap();
        db.complete_job(id1).unwrap();
        let id2 = db.enqueue(job).unwrap();
        assert_ne!(id1, id2, "after completion a new job should get a new id");
    }

    // ── backoff schedule ─────────────────────────────────────────────────────

    #[test]
    fn backoff_schedule_values() {
        let (_dir, db) = temp_db();
        let job = NewJob {
            pair_id: "p1".into(),
            kind: "upload".into(),
            rel_path: "y.txt".into(),
            priority: 0,
            created_ms: now_ms(),
        };
        let id = db.enqueue(job).unwrap();

        // Fail it repeatedly and check next_try_ms increases exponentially.
        let mut prev_next = 0i64;
        for attempt in 1..=(MAX_JOB_ATTEMPTS - 1) {
            db.fail_job(id, "some error").unwrap();

            // Read back the row.
            let conn = db.conn.lock().unwrap();
            let (attempts, next_try, status): (i64, i64, String) = conn
                .query_row(
                    "SELECT attempts,next_try_ms,status FROM jobs WHERE id=?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            drop(conn);

            assert_eq!(attempts, attempt);
            assert_eq!(status, "queued");
            // next_try must be strictly greater than previous next_try (or 0).
            assert!(next_try > prev_next, "attempt {attempt}: next_try did not advance");
            prev_next = next_try;

            // Verify the delay is 2^attempt seconds (or MAX_BACKOFF_SECS if capped).
            let expected_delay_secs = (1i64 << attempt).min(MAX_BACKOFF_SECS);
            let now = now_ms();
            // Allow ±2 s slop for slow CI.
            assert!(
                next_try >= now + (expected_delay_secs - 2) * 1000,
                "attempt {attempt}: delay too short, expected ~{expected_delay_secs}s"
            );
        }

        // Last fail should mark it 'failed'.
        db.fail_job(id, "terminal").unwrap();
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "failed");
    }

    // ── activity pruning ─────────────────────────────────────────────────────

    #[test]
    fn activity_pruned_at_2000() {
        let (_dir, db) = temp_db();
        let base_ts = now_ms();

        // Insert 2010 rows.
        for i in 0..2010i64 {
            db.log_activity(Activity {
                id: None,
                ts_ms: base_ts + i,
                pair_id: "p1".into(),
                kind: "upload".into(),
                rel_path: format!("file{i}.txt"),
                result: "ok".into(),
                detail: None,
            })
            .unwrap();
        }

        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM activity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, MAX_ACTIVITY_ROWS, "activity should be pruned to 2000");
    }

    // ── concurrent upserts from 4 threads ────────────────────────────────────

    #[test]
    fn concurrent_upserts_no_lock_errors() {
        let (_dir, db) = temp_db();
        let db = Arc::new(db);
        let mut handles = Vec::new();

        for t in 0u64..4 {
            let db_clone = Arc::clone(&db);
            handles.push(std::thread::spawn(move || {
                for i in 0u64..50 {
                    let row = FileRow {
                        pair_id: format!("pair{t}"),
                        rel_path: format!("file{i}.txt"),
                        size: Some((t * 100 + i) as i64),
                        mtime_ms: Some(1_700_000_000_000 + i as i64),
                        md5: Some(format!("md5_{t}_{i}")),
                        drive_id: None,
                        drive_md5: None,
                        drive_mtime_ms: None,
                        drive_rev: None,
                        state: "dirty".into(),
                    };
                    db_clone.upsert_file(row).expect("upsert should not fail");
                }
            }));
        }

        for h in handles {
            h.join().expect("thread panicked");
        }

        // Verify total rows: 4 threads × 50 files = 200.
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 200);
    }

    // ── upload session round-trip ─────────────────────────────────────────────

    #[test]
    fn upload_session_roundtrip() {
        let (_dir, db) = temp_db();
        db.set_upload_session("p1", "big.bin", "https://example/upload/xyz", 1_000_000, now_ms())
            .unwrap();
        let uri = db.get_upload_session("p1", "big.bin").unwrap();
        assert_eq!(uri.as_deref(), Some("https://example/upload/xyz"));
        db.delete_upload_session("p1", "big.bin").unwrap();
        let uri2 = db.get_upload_session("p1", "big.bin").unwrap();
        assert!(uri2.is_none());
    }

    // ── page token round-trip ─────────────────────────────────────────────────

    #[test]
    fn page_token_roundtrip() {
        let (_dir, db) = temp_db();
        db.set_page_token("p1", "tok123").unwrap();
        let tok = db.get_page_token("p1").unwrap();
        assert_eq!(tok.as_deref(), Some("tok123"));
    }
}

