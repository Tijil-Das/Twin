//! Scriptable CPU sampler for testing Governor and resource throttle transitions.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Yields pre-programmed sequences of CPU % usage samples.
#[derive(Clone)]
pub struct FakeCpu {
    samples: Arc<Vec<f32>>,
    index: Arc<AtomicUsize>,
    default_usage: f32,
}

impl FakeCpu {
    /// Create a FakeCpu that cycles through `samples`, returning `default_usage` once exhausted.
    pub fn new(samples: Vec<f32>, default_usage: f32) -> Self {
        FakeCpu {
            samples: Arc::new(samples),
            index: Arc::new(AtomicUsize::new(0)),
            default_usage,
        }
    }

    /// Sample the next CPU % usage value.
    pub fn sample(&self) -> f32 {
        let idx = self.index.fetch_add(1, Ordering::Relaxed);
        if idx < self.samples.len() {
            self.samples[idx]
        } else {
            self.default_usage
        }
    }

    /// Reset sequence index back to 0.
    pub fn reset(&self) {
        self.index.store(0, Ordering::Relaxed);
    }
}

