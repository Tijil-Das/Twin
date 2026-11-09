//! P07 – Progress tracking and Tauri event emission.
//!
//! Extends the base `ProgressUpdate` from queue with speed (EMA) and ETA.
//! Emits `transfer://progress` events throttled to 4/s per job.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::queue::{ProgressRx, ProgressUpdate};

// ── Rich progress ─────────────────────────────────────────────────────────────

/// Extended progress emitted to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RichProgress {
    pub job_id: i64,
    pub pair_id: String,
    pub rel_path: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Bytes/second (EMA smoothed).
    pub speed_bps: f64,
    /// Seconds remaining (None if speed == 0).
    pub eta_secs: Option<f64>,
    /// Wall-clock time when this transfer started (epoch milliseconds).
    pub start_ms: i64,
    #[serde(default)]
    pub kind: String,
}

/// Per-job EMA state.
struct JobState {
    speed_ema: f64,
    last_emit: Instant,
    last_bytes: u64,
    last_time: Instant,
    start_ms: i64,
    kind: String,
}

impl JobState {
    fn new() -> Self {
        let now = Instant::now();
        let start_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(250);
        JobState {
            speed_ema: 0.0,
            last_emit: now.checked_sub(MIN_EMIT_INTERVAL).unwrap_or(now),
            last_bytes: 0,
            last_time: now,
            start_ms,
            kind: String::new(),
        }
    }

    /// Update EMA speed and return rich progress.  Returns None if throttled.
    fn update(&mut self, upd: &ProgressUpdate) -> Option<RichProgress> {
        const ALPHA: f64 = 0.2;
        const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(250); // 4/s

        if !upd.kind.is_empty() {
            self.kind = upd.kind.clone();
        }

        let now = Instant::now();
        let dt = now.duration_since(self.last_time).as_secs_f64();

        if dt >= 1.0 {
            let bytes_delta = upd.bytes_done.saturating_sub(self.last_bytes) as f64;
            let instant_speed = bytes_delta / dt;
            // EMA
            self.speed_ema = ALPHA * instant_speed + (1.0 - ALPHA) * self.speed_ema;
            self.last_bytes = upd.bytes_done;
            self.last_time = now;
        }

        // Always emit on start (first event) and 100% completion; otherwise throttle emit rate.
        let is_complete = upd.bytes_done >= upd.bytes_total && upd.bytes_total > 0;
        let is_start = self.last_bytes == 0 && upd.bytes_done == 0;
        if !is_complete && !is_start && now.duration_since(self.last_emit) < MIN_EMIT_INTERVAL {
            return None;
        }
        self.last_emit = now;

        let eta_secs = if self.speed_ema > 0.0 {
            let remaining = upd.bytes_total.saturating_sub(upd.bytes_done) as f64;
            Some(remaining / self.speed_ema)
        } else {
            None
        };

        Some(RichProgress {
            job_id: upd.job_id,
            pair_id: upd.pair_id.clone(),
            rel_path: upd.rel_path.clone(),
            bytes_done: upd.bytes_done,
            bytes_total: upd.bytes_total,
            speed_bps: self.speed_ema,
            eta_secs,
            start_ms: self.start_ms,
            kind: if !upd.kind.is_empty() {
                upd.kind.clone()
            } else {
                self.kind.clone()
            },
        })
    }
}

// ── Progress relay task ───────────────────────────────────────────────────────

/// Consumes `ProgressRx`, computes EMA, emits Tauri events throttled to 4/s.
/// Returns when the sender side is dropped.
pub async fn relay_progress(
    mut rx: ProgressRx,
    app: tauri::AppHandle,
) {
    use tauri::Emitter;
    let states: Arc<Mutex<HashMap<i64, JobState>>> = Arc::new(Mutex::new(HashMap::new()));

    while let Some(upd) = rx.recv().await {
        let mut map = states.lock().await;
        let state = map.entry(upd.job_id).or_insert_with(JobState::new);

        if let Some(rich) = state.update(&upd) {
            // Remove finished jobs from state.
            if rich.bytes_done >= rich.bytes_total && rich.bytes_total > 0 {
                map.remove(&upd.job_id);
            }
            drop(map);

            if let Err(e) = app.emit("transfer://progress", &rich) {
                warn!("emit progress: {e}");
            }
        }
    }
}

