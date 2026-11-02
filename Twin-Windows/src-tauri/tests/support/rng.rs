//! Deterministic seeded PRNG and test configuration helpers.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// A simple, fast, deterministic 64-bit LCG / XorShift PRNG.
#[derive(Debug, Clone)]
pub struct TestRng {
    seed: u64,
    state: Arc<AtomicU64>,
}

impl TestRng {
    /// Create a new TestRng with a specific seed.
    pub fn new(seed: u64) -> Self {
        // Ensure non-zero state
        let s = if seed == 0 { 0x853c49e6748fea9b } else { seed };
        TestRng {
            seed,
            state: Arc::new(AtomicU64::new(s)),
        }
    }

    /// Create a new TestRng initialized from system time, printing the seed
    /// so any failure can be reproduced.
    pub fn from_time() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let rng = Self::new(seed);
        println!("[TestRng] Initialized with seed: {}", rng.seed);
        rng
    }

    /// Return the initial seed of this RNG.
    pub fn seed(&self) -> u64 {
        self.seed
    }

    /// Next random 64-bit integer.
    pub fn next_u64(&self) -> u64 {
        loop {
            let current = self.state.load(Ordering::Relaxed);
            let mut x = current;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            if self.state.compare_exchange_weak(current, x, Ordering::Relaxed, Ordering::Relaxed).is_ok() {
                return x;
            }
        }
    }

    /// Next random 32-bit integer.
    pub fn next_u32(&self) -> u32 {
        (self.next_u64() & 0xFFFF_FFFF) as u32
    }

    /// Next random float in [0.0, 1.0).
    pub fn next_f64(&self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Next random integer in range [min, max].
    pub fn gen_range_u64(&self, min: u64, max: u64) -> u64 {
        if min >= max {
            return min;
        }
        min + (self.next_u64() % (max - min + 1))
    }

    /// Next random usize in range [min, max].
    pub fn gen_range(&self, min: usize, max: usize) -> usize {
        self.gen_range_u64(min as u64, max as u64) as usize
    }

    /// Next random bool with probability p of being true.
    pub fn gen_bool(&self, p: f64) -> bool {
        self.next_f64() < p
    }

    /// Fill a slice with random bytes.
    pub fn fill_bytes(&self, buf: &mut [u8]) {
        for chunk in buf.chunks_mut(8) {
            let val = self.next_u64();
            let bytes = val.to_le_bytes();
            let len = chunk.len();
            chunk.copy_from_slice(&bytes[..len]);
        }
    }
}

/// Returns the configured number of proptest cases from environment variable `PROPTEST_CASES`.
/// Defaults to 2,000 locally, and 20,000 when `CI` or `NIGHTLY` is set.
pub fn proptest_cases() -> u32 {
    if let Ok(val) = std::env::var("PROPTEST_CASES") {
        if let Ok(n) = val.parse::<u32>() {
            return n;
        }
    }
    if std::env::var("CI").is_ok() || std::env::var("NIGHTLY").is_ok() {
        20_000
    } else {
        2_000
    }
}

