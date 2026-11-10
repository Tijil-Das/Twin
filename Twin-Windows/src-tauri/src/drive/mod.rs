//! Drive module — Google Drive API client + Drive sub-APIs.
pub mod client;
pub mod colorizer;
pub mod export;
pub mod extras;
pub mod revisions;
pub mod trash;
pub use client::{DriveClient, DriveFile, DriveFileMeta, ResumableStatus};
pub use colorizer::*;
pub use extras::*;

#[cfg(test)]
mod tests;

