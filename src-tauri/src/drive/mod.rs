//! Drive module — Google Drive API client + Drive sub-APIs.
pub mod client;
pub mod export;
pub mod revisions;
pub mod trash;
pub use client::DriveClient;

#[cfg(test)]
mod tests;

