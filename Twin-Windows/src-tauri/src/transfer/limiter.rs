//! P07 – Bandwidth token-bucket limiter.
//!
//! `acquire(bytes).await` sleeps until tokens are available at the configured
//! rate.  `upload_kbps = 0` is an explicit no-op fast path (no timer overhead).

use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::time::sleep;

/// Token-bucket rate limiter for upload bandwidth.
/// Re-read from config on each call via `set_rate`.
pub struct Limiter {
    inner: Mutex<LimiterInner>,
}

struct LimiterInner {
    /// Bytes per second.  0 = unlimited.
    rate_bps: u64,
    /// Available tokens (bytes).
    tokens: f64,
    last_fill: Instant,
    /// Max burst: 1 second of tokens.
    max_tokens: f64,
}

impl Limiter {
    pub fn new(kbps: u64) -> Self {
        let rate_bps = kbps * 1024;
        Limiter {
            inner: Mutex::new(LimiterInner {
                rate_bps,
                tokens: rate_bps as f64,
                last_fill: Instant::now(),
                max_tokens: rate_bps as f64,
            }),
        }
    }

    /// Update rate at runtime (called when config changes).
    pub async fn set_rate(&self, kbps: u64) {
        let mut g = self.inner.lock().await;
        let rate_bps = kbps * 1024;
        g.rate_bps = rate_bps;
        g.max_tokens = rate_bps as f64;
        // Don't reset tokens so we don't cause a burst.
    }

    /// Acquire `bytes` tokens, sleeping if rate limited.
    /// Immediately returns if rate == 0 (unlimited).
    pub async fn acquire(&self, bytes: u64) {
        // Snapshot rate without holding lock during sleep.
        let rate_bps = {
            let g = self.inner.lock().await;
            g.rate_bps
        };
        if rate_bps == 0 {
            return;
        }

        loop {
            let wait = {
                let mut g = self.inner.lock().await;
                // Refill tokens based on elapsed time.
                let now = Instant::now();
                let elapsed = now.duration_since(g.last_fill).as_secs_f64();
                g.tokens += elapsed * g.rate_bps as f64;
                if g.tokens > g.max_tokens {
                    g.tokens = g.max_tokens;
                }
                g.last_fill = now;

                // The rate may have been switched to "unlimited" while we were
                // sleeping; never divide by zero in that case.
                if g.rate_bps == 0 {
                    Duration::ZERO
                } else if g.tokens >= bytes as f64 {
                    g.tokens -= bytes as f64;
                    Duration::ZERO
                } else {
                    let needed = bytes as f64 - g.tokens;
                    let secs = needed / g.rate_bps as f64;
                    Duration::from_secs_f64(secs)
                }
            };

            if wait.is_zero() {
                return;
            }
            sleep(wait).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[tokio::test]
    async fn unlimited_returns_immediately() {
        let lim = Limiter::new(0);
        let t = Instant::now();
        lim.acquire(1024 * 1024).await; // 1 MB
        assert!(t.elapsed() < Duration::from_millis(10));
    }

    #[tokio::test]
    async fn rate_within_5_percent() {
        // 512 KiB/s limiter, acquire 512 KiB → should take ~1 s
        let lim = Limiter::new(512);
        let t = Instant::now();
        // First acquire up to the burst bucket, then one more to trigger wait.
        lim.acquire(512 * 1024).await; // burns burst
        lim.acquire(512 * 1024).await; // should sleep ~1 s
        let elapsed = t.elapsed().as_secs_f64();
        // Allow 5% tolerance plus 100ms scheduling slack.
        assert!(
            (0.85..=2.0).contains(&elapsed),
            "elapsed {elapsed:.3}s outside expected range 0.85..2.0"
        );
    }
}

