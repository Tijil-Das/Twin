//! Test harness & support fakes for Tether stress testing.
#![allow(unused_imports)]
#![allow(dead_code)]

pub mod fake_clock;
pub mod fake_cpu;
pub mod fake_drive;
pub mod fake_fs;
pub mod fake_power;
pub mod fault_injector;
pub mod rng;

pub use fake_clock::FakeClock;
pub use fake_cpu::FakeCpu;
pub use fake_drive::{FakeChange, FakeDrive, FakeFile, FakeRevision};
pub use fake_fs::{FileSystem, InjectedFs};
pub use fake_power::FakePower;
pub use fault_injector::{FaultAction, FaultInjector};
pub use rng::{proptest_cases, TestRng};

