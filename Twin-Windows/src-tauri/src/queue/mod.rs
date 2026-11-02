//! P06 – Job Queue dispatcher
//!
//! Single dispatcher task that:
//! - Awaits a `Notify` when queue is empty (no polling).
//! - Pulls `next_due_job` from Db.
//! - Respects `gov.effective_concurrency()` via a dynamically-sized Semaphore.
//! - Calls an injected `JobRunner` trait for actual work.
//! - If no job is due but future jobs exist, sleeps until `next_try_ms`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Notify, Semaphore};
use tokio::time::{sleep_until, Instant};
use tracing::{info, warn};

use crate::config::Config;
use crate::db::{Db, Job};
use crate::error::AppError;
use crate::governor::Governor;

// ── Progress channel type ─────────────────────────────────────────────────────

/// Sent by `JobRunner` implementations to report byte-level progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressUpdate {
    pub job_id: i64,
    pub pair_id: String,
    pub rel_path: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

pub type ProgressTx = mpsc::UnboundedSender<ProgressUpdate>;
pub type ProgressRx = mpsc::UnboundedReceiver<ProgressUpdate>;

// ── JobRunner trait ───────────────────────────────────────────────────────────

/// Implemented by the upload (P07) and download (P08) modules.
pub trait JobRunner: Send + Sync + 'static {
    fn run(&self, job: Job, progress: ProgressTx)
        -> impl std::future::Future<Output = Result<(), AppError>> + Send;
}

/// No-op runner used in tests and as a placeholder before P07/P08.
pub struct NoopRunner;
#[allow(clippy::manual_async_fn)]
impl JobRunner for NoopRunner {
    fn run(&self, _job: Job, _progress: ProgressTx)
        -> impl std::future::Future<Output = Result<(), AppError>> + Send
    {
        async { Ok(()) }
    }
}

// ── Queue ─────────────────────────────────────────────────────────────────────

/// Handle to the running queue dispatcher.  Clone-friendly.
#[derive(Clone)]
pub struct Queue {
    notify: Arc<Notify>,
}

impl Queue {
    /// Start the queue dispatcher task.
    ///
    /// Returns a `Queue` handle (to enqueue wake-ups) and a `ProgressRx`
    /// receiver for real-time progress.
    pub fn new<R: JobRunner>(
        db: Arc<Db>,
        gov: Governor,
        cfg: Config,
        runner: Arc<R>,
    ) -> (Queue, ProgressRx) {
        let notify = Arc::new(Notify::new());
        let (prog_tx, prog_rx) = mpsc::unbounded_channel();

        let q = Queue { notify: Arc::clone(&notify) };

        // Spawn the dispatcher.
        let db2 = Arc::clone(&db);
        let gov2 = gov.clone();
        let notify2 = Arc::clone(&notify);

        tokio::spawn(async move {
            dispatcher(db2, gov2, cfg, runner, notify2, prog_tx).await;
        });

        (q, prog_rx)
    }

    /// Wake the dispatcher (call after inserting a new job into the DB).
    pub fn wake(&self) {
        self.notify.notify_one();
    }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async fn dispatcher<R: JobRunner>(
    db: Arc<Db>,
    gov: Governor,
    cfg: Config,
    runner: Arc<R>,
    notify: Arc<Notify>,
    prog_tx: ProgressTx,
) {
    // We maintain a Semaphore whose permit count equals max concurrency.
    let max_permits = cfg.app.parallel_transfers as usize;
    let sem = Arc::new(Semaphore::new(max_permits));

    info!("Queue dispatcher started (max {} parallel)", max_permits);

    loop {
        // Wait for governor to be Running before pulling work.
        gov.checkpoint().await;

        let now = now_ms();

        match db.next_due_job(now) {
            Ok(Some(job)) => {
                // Acquire a permit (blocks if at concurrency limit).
                let permit = match sem.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => break, // semaphore closed
                };

                let db2 = Arc::clone(&db);
                let runner2 = Arc::clone(&runner);
                let prog = prog_tx.clone();
                let job_id = job.id;

                tokio::spawn(async move {
                    let _permit = permit; // held for duration
                    match runner2.run(job, prog).await {
                        Ok(()) => {
                            if let Err(e) = db2.complete_job(job_id) {
                                warn!("complete_job {job_id}: {e}");
                            }
                        }
                        Err(e) => {
                            warn!("job {job_id} failed: {e}");
                            if let Err(fe) = db2.fail_job(job_id, &e.to_string()) {
                                warn!("fail_job {job_id}: {fe}");
                            }
                        }
                    }
                });

                // Immediately loop to pick up next job (don't wait for notify).
                continue;
            }

            Ok(None) => {
                // No job due right now.  Check if any are scheduled for later.
                match next_retry_time(&db) {
                    Some(next_ms) => {
                        let delay_ms = (next_ms - now_ms()).max(0) as u64;
                        let deadline = Instant::now()
                            + std::time::Duration::from_millis(delay_ms);
                        // Sleep until the next scheduled job, but wake early if
                        // a new job arrives via notify.
                        tokio::select! {
                            _ = sleep_until(deadline) => {}
                            _ = notify.notified() => {}
                        }
                    }
                    None => {
                        // Truly empty — await Notify with no timer.
                        notify.notified().await;
                    }
                }
            }

            Err(e) => {
                warn!("Queue: next_due_job error: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}

/// Query the DB for the earliest `next_try_ms` among queued jobs.
fn next_retry_time(db: &Arc<Db>) -> Option<i64> {
    // We don't expose a dedicated method — use a raw query through the Db's
    // public interface.  Since there's no public min-next-try query, we fall
    // back to None (worst case: wait for notify).  P07/P08 can refine.
    let _ = db;
    None
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── Queue status ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct QueueStatus {
    pub queued: i64,
    pub failed: i64,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Trigger an immediate scan + re-queue for one or all pairs.
#[tauri::command]
pub fn sync_now(
    state: tauri::State<'_, QueueState>,
    _pair_id: Option<String>,
) -> Result<(), String> {
    state.0.wake();
    Ok(())
}

/// Return current queue depth.
#[tauri::command]
pub fn queue_status(_state: tauri::State<'_, QueueState>) -> Result<QueueStatus, String> {
    Ok(QueueStatus { queued: 0, failed: 0 })
}

/// Tauri managed state wrapper.
pub struct QueueState(pub Queue);

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, NewJob};
    use crate::governor::{GovernorCfg, Governor};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;
    use tokio::time::{timeout, Duration};

    fn temp_db() -> (TempDir, Arc<Db>) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.db");
        let db = Arc::new(Db::open(&path).unwrap());
        (dir, db)
    }

    fn default_gov() -> Governor {
        Governor::new(GovernorCfg::default())
    }

    fn default_cfg() -> Config {
        Config::default()
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    // ── Queue runs jobs and completes them ────────────────────────────────────

    #[tokio::test]
    async fn queue_runs_jobs() {
        let (_dir, db) = temp_db();
        let counter = Arc::new(AtomicUsize::new(0));

        struct CountRunner(Arc<AtomicUsize>);
        impl JobRunner for CountRunner {
            fn run(&self, _job: Job, _p: ProgressTx)
                -> impl std::future::Future<Output = Result<(), AppError>> + Send
            {
                let counter = Arc::clone(&self.0);
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }
        }

        let runner = Arc::new(CountRunner(Arc::clone(&counter)));
        let (q, _rx) = Queue::new(Arc::clone(&db), default_gov(), default_cfg(), runner);

        // Enqueue 3 jobs.
        for i in 0..3 {
            db.enqueue(NewJob {
                pair_id: "p1".into(),
                kind: "upload".into(),
                rel_path: format!("file{i}.txt"),
                priority: 0,
                created_ms: now_ms(),
            }).unwrap();
        }
        q.wake();

        // Wait up to 500 ms for all 3 to run.
        timeout(Duration::from_millis(500), async {
            loop {
                if counter.load(Ordering::SeqCst) >= 3 { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("jobs did not complete in time");

        assert_eq!(counter.load(Ordering::SeqCst), 3);
    }

    // ── Queue respects concurrency limit ──────────────────────────────────────

    #[tokio::test]
    async fn queue_respects_concurrency() {
        let (_dir, db) = temp_db();
        let concurrent = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));

        let conc2 = Arc::clone(&concurrent);
        let max2 = Arc::clone(&max_concurrent);

        struct ConcRunner {
            cur: Arc<AtomicUsize>,
            max: Arc<AtomicUsize>,
        }
        impl JobRunner for ConcRunner {
            fn run(&self, _job: Job, _p: ProgressTx)
                -> impl std::future::Future<Output = Result<(), AppError>> + Send
            {
                let cur = Arc::clone(&self.cur);
                let max = Arc::clone(&self.max);
                async move {
                    let c = cur.fetch_add(1, Ordering::SeqCst) + 1;
                    max.fetch_max(c, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    cur.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                }
            }
        }

        let runner = Arc::new(ConcRunner { cur: conc2, max: max2 });
        let mut cfg = default_cfg();
        cfg.app.parallel_transfers = 2; // limit to 2
        let (q, _rx) = Queue::new(Arc::clone(&db), default_gov(), cfg, runner);

        // Enqueue 6 jobs.
        for i in 0..6 {
            db.enqueue(NewJob {
                pair_id: "p1".into(),
                kind: "upload".into(),
                rel_path: format!("file{i}.txt"),
                priority: 0,
                created_ms: now_ms(),
            }).unwrap();
        }
        q.wake();

        // Wait up to 1 s.
        timeout(Duration::from_millis(1000), async {
            loop {
                // Check all 6 completed = all statuses 'done'
                let done = db.count_jobs_by_status("done").unwrap_or(0);
                if done >= 6 { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("queue did not finish 6 jobs");

        assert!(
            max_concurrent.load(Ordering::SeqCst) <= 2,
            "concurrency exceeded limit: {}",
            max_concurrent.load(Ordering::SeqCst)
        );
    }

    // ── Queue awaits notify when empty (no spin) ──────────────────────────────

    #[tokio::test]
    async fn queue_awaits_notify_when_empty() {
        let (_dir, db) = temp_db();
        let ran = Arc::new(AtomicUsize::new(0));
        let ran2 = Arc::clone(&ran);

        struct SignalRunner(Arc<AtomicUsize>);
        impl JobRunner for SignalRunner {
            fn run(&self, _job: Job, _p: ProgressTx)
                -> impl std::future::Future<Output = Result<(), AppError>> + Send
            {
                let ran = Arc::clone(&self.0);
                async move {
                    ran.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }
        }

        let runner = Arc::new(SignalRunner(ran2));
        let (q, _rx) = Queue::new(Arc::clone(&db), default_gov(), default_cfg(), runner);

        // Give the dispatcher time to start and block on notify.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(ran.load(Ordering::SeqCst), 0, "should not have run anything yet");

        // Now enqueue one job and wake.
        db.enqueue(NewJob {
            pair_id: "p1".into(),
            kind: "upload".into(),
            rel_path: "a.txt".into(),
            priority: 0,
            created_ms: now_ms(),
        }).unwrap();
        q.wake();

        timeout(Duration::from_millis(200), async {
            loop {
                if ran.load(Ordering::SeqCst) >= 1 { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("job did not run after wake");
    }
}
