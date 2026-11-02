//! FakeClock for deterministic time manipulation in async tests.

use std::time::Duration;
use tokio::time::{advance, pause, resume};

/// Controller for deterministic virtual time advancement.
pub struct FakeClock {
    paused: bool,
}

impl FakeClock {
    /// Pause Tokio's virtual clock so time only moves when explicitly advanced.
    pub fn pause() -> Self {
        pause();
        FakeClock { paused: true }
    }

    /// Advance virtual time by `duration`.
    pub async fn advance(&self, duration: Duration) {
        advance(duration).await;
    }

    /// Resume normal clock flow.
    pub fn resume(&mut self) {
        if self.paused {
            resume();
            self.paused = false;
        }
    }
}

impl Drop for FakeClock {
    fn drop(&mut self) {
        self.resume();
    }
}

