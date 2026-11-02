//! FakeFs trait wrapper with configurable fault injection.

use std::fs::Metadata;
use std::io;
use std::path::Path;

use super::fault_injector::{FaultAction, FaultInjector};

pub trait FileSystem: Send + Sync {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    fn write(&self, path: &Path, data: &[u8]) -> io::Result<()>;
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn metadata(&self, path: &Path) -> io::Result<Metadata>;
}

/// A real filesystem wrapper armed with a `FaultInjector`.
#[derive(Clone)]
pub struct InjectedFs {
    faults: FaultInjector,
}

impl InjectedFs {
    pub fn new(faults: FaultInjector) -> Self {
        InjectedFs { faults }
    }

    fn check_fault(&self, op: &str, path: &Path) -> io::Result<()> {
        let path_str = path.to_string_lossy();
        let action = self.faults.evaluate(op, &path_str);
        match action {
            FaultAction::Ok => Ok(()),
            FaultAction::IoErr(kind) => Err(io::Error::new(kind, format!("Fault injected on {op} {path_str}"))),
            FaultAction::Delay(dur) => {
                std::thread::sleep(dur);
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

impl FileSystem for InjectedFs {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        self.check_fault("READ", path)?;
        std::fs::read(path)
    }

    fn write(&self, path: &Path, data: &[u8]) -> io::Result<()> {
        self.check_fault("WRITE", path)?;
        std::fs::write(path, data)
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        self.check_fault("MKDIR", path)?;
        std::fs::create_dir_all(path)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        self.check_fault("REMOVE", path)?;
        std::fs::remove_file(path)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.check_fault("RENAME", from)?;
        std::fs::rename(from, to)
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        self.check_fault("STAT", path)?;
        std::fs::metadata(path)
    }
}

