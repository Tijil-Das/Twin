//! Drive module — Google Drive API client + Drive sub-APIs.
pub mod client;
pub mod export;
pub mod extras;
pub mod revisions;
pub mod trash;
pub use client::{DriveClient, DriveFile};
pub use extras::*;

#[cfg(test)]
mod tests;

