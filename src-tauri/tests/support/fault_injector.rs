//! Fault injector for simulated network and filesystem operations.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::rng::TestRng;

/// Action that the fault injector prescribes for an operation.
#[derive(Debug, Clone)]
pub enum FaultAction {
    /// Proceed normally.
    Ok,
    /// Yield an IO error with the given error kind.
    IoErr(io::ErrorKind),
    /// Delay before returning or executing.
    Delay(Duration),
    /// Abruptly drop/close the connection after sending `n` bytes of body.
    DropAtByte(usize),
    /// Return an HTTP response with given status, optional Retry-After (seconds), and body.
    Http {
        status: u16,
        retry_after: Option<u64>,
        body: Option<String>,
    },
    /// Truncate response body to `len` bytes.
    TruncateResponse(usize),
    /// Corrupt byte at `offset` with `value`.
    CorruptByte {
        offset: usize,
        value: u8,
    },
    /// Stream body slowly at `bytes_per_sec` bytes per second.
    SlowTrickle {
        bytes_per_sec: u64,
    },
    /// Fails only on the Nth matching call (1-based index).
    FailNth {
        n: usize,
        fault: Box<FaultAction>,
    },
    /// Fails with probability `p` (0.0 to 1.0) using a seeded RNG.
    FailProbability {
        p: f64,
        fault: Box<FaultAction>,
    },
}

impl FaultAction {
    pub fn http(status: u16) -> Self {
        FaultAction::Http {
            status,
            retry_after: None,
            body: None,
        }
    }

    pub fn http_with_retry_after(status: u16, retry_after_secs: u64) -> Self {
        FaultAction::Http {
            status,
            retry_after: Some(retry_after_secs),
            body: None,
        }
    }
}

/// Thread-safe fault injector configuration and call counter.
#[derive(Clone)]
pub struct FaultInjector {
    inner: Arc<Mutex<FaultInjectorInner>>,
    call_counts: Arc<Mutex<HashMap<String, usize>>>,
}

struct FaultInjectorInner {
    global_fault: Option<FaultAction>,
    route_faults: HashMap<String, FaultAction>,
    rng: TestRng,
}

impl FaultInjector {
    /// Create a new FaultInjector with a deterministic seed.
    pub fn new(seed: u64) -> Self {
        FaultInjector {
            inner: Arc::new(Mutex::new(FaultInjectorInner {
                global_fault: None,
                route_faults: HashMap::new(),
                rng: TestRng::new(seed),
            })),
            call_counts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Set a global fault that applies to all operations unless overridden.
    pub fn set_global(&self, fault: FaultAction) {
        let mut inner = self.inner.lock().unwrap();
        inner.global_fault = Some(fault);
    }

    /// Clear global fault.
    pub fn clear_global(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.global_fault = None;
    }

    /// Set a fault action for a specific method and path prefix (e.g. ("GET", "/files")).
    pub fn set_route(&self, method: &str, path_prefix: &str, fault: FaultAction) {
        let mut inner = self.inner.lock().unwrap();
        let key = format!("{}:{}", method.to_uppercase(), path_prefix);
        inner.route_faults.insert(key, fault);
    }

    /// Remove a route-specific fault.
    pub fn clear_route(&self, method: &str, path_prefix: &str) {
        let mut inner = self.inner.lock().unwrap();
        let key = format!("{}:{}", method.to_uppercase(), path_prefix);
        inner.route_faults.remove(&key);
    }

    /// Clear all faults and reset call counts.
    pub fn reset(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.global_fault = None;
        inner.route_faults.clear();
        let mut counts = self.call_counts.lock().unwrap();
        counts.clear();
    }

    /// Get total calls evaluated for a given key.
    pub fn call_count(&self, key: &str) -> usize {
        let counts = self.call_counts.lock().unwrap();
        counts.get(key).copied().unwrap_or(0)
    }

    /// Increment call count and evaluate the effective fault action.
    pub fn evaluate(&self, method: &str, path: &str) -> FaultAction {
        let route_key = format!("{}:{}", method.to_uppercase(), path);
        
        let call_num = {
            let mut counts = self.call_counts.lock().unwrap();
            let count = counts.entry(route_key.clone()).or_insert(0);
            *count += 1;
            *count
        };

        let mut inner = self.inner.lock().unwrap();

        // 1. Check exact route match
        if let Some(fault) = inner.route_faults.get(&route_key).cloned() {
            return Self::resolve_fault(fault, call_num, &mut inner.rng);
        }

        // 2. Check path prefix match
        for (pattern, fault) in inner.route_faults.iter() {
            if let Some((m, p)) = pattern.split_once(':') {
                if m == method.to_uppercase() && path.starts_with(p) {
                    let f = fault.clone();
                    return Self::resolve_fault(f, call_num, &mut inner.rng);
                }
            }
        }

        // 3. Fall back to global fault if any
        if let Some(fault) = inner.global_fault.clone() {
            return Self::resolve_fault(fault, call_num, &mut inner.rng);
        }

        FaultAction::Ok
    }

    fn resolve_fault(fault: FaultAction, call_num: usize, rng: &mut TestRng) -> FaultAction {
        match fault {
            FaultAction::FailNth { n, fault } => {
                if call_num == n {
                    *fault
                } else {
                    FaultAction::Ok
                }
            }
            FaultAction::FailProbability { p, fault } => {
                if rng.gen_bool(p) {
                    *fault
                } else {
                    FaultAction::Ok
                }
            }
            other => other,
        }
    }
}

