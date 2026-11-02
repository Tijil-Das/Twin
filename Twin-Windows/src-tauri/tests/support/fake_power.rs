//! Scriptable power/battery sampler for testing battery throttle behavior.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;

/// Scriptable battery & power status.
#[derive(Clone)]
pub struct FakePower {
    on_battery: Arc<AtomicBool>,
    battery_percent: Arc<AtomicU8>,
}

impl FakePower {
    pub fn new(on_battery: bool, battery_percent: u8) -> Self {
        FakePower {
            on_battery: Arc::new(AtomicBool::new(on_battery)),
            battery_percent: Arc::new(AtomicU8::new(battery_percent)),
        }
    }

    pub fn is_on_battery(&self) -> bool {
        self.on_battery.load(Ordering::Relaxed)
    }

    pub fn battery_level(&self) -> u8 {
        self.battery_percent.load(Ordering::Relaxed)
    }

    pub fn set_on_battery(&self, on_battery: bool) {
        self.on_battery.store(on_battery, Ordering::Relaxed);
    }

    pub fn set_battery_level(&self, level: u8) {
        self.battery_percent.store(level, Ordering::Relaxed);
    }
}

