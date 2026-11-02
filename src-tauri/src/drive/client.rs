//! P07 – Google Drive API client.
//!
//! One shared `reqwest::Client` per process (passed as Arc).
//! Every request adds `Authorization: Bearer <token>`.
//! Retries: 429/5xx/network -> exponential backoff with jitter, max 5 retries,
//! honors `Retry-After` header.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use reqwest::{header, Client, Method, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::time::sleep;
use tracing::{debug, warn};

use crate::auth;
use crate::error::AppError;

// Constants

const API_BASE: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE: &str = "https://www.googleapis.com/upload/drive/v3";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RETRIES: u32 = 5;

// DriveClient

/// Shared Drive API client. Clone-friendly (Arc inside).
#[derive(Clone)]
pub struct DriveClient {
    pub(crate) http: Client,
    pub(crate) base_url: String,
    pub(crate) upload_base_url: String,
    /// Cache: Drive folder path -> folder id, keyed by (pair_id, rel_dir).
    path_cache: Arc<Mutex<HashMap<String, String>>>,
}

impl DriveClient {
    /// Build the shared client -- call once at startup.
    pub fn new() -> Result<Self, AppError> {
        let http = Client::builder()
            .use_rustls_tls()
            .http2_prior_knowledge()
            .pool_max_idle_per_host(8)
            .tcp_keepalive(Duration::from_secs(30))
            .connect_timeout(CONNECT_TIMEOUT)
            // No overall timeout -- bodies can be large.
            .build()
            .map_err(|e| AppError::Other(format!("build http client: {e}")))?;
        Ok(DriveClient {
            http,
            base_url: API_BASE.into(),
            upload_base_url: UPLOAD_BASE.into(),
            path_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn with_base_url(mut self, base_url: String) -> Self {
        self.upload_base_url = base_url.clone();
        self.base_url = base_url;
        self
    }

    pub fn with_upload_base_url(mut self, upload_base_url: String) -> Self {
        self.upload_base_url = upload_base_url;
        self
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn upload_base_url(&self) -> &str {
        &self.upload_base_url
    }

    // Helpers

    /// Execute with retry on 429/5xx.
    pub(crate) async fn execute_with_retry(&self, build: impl Fn() -> RequestBuilder) -> Result<Response, AppError> {
        let mut delay = Duration::from_millis(500);
        for attempt in 0..=MAX_RETRIES {
            let resp = build()
                .send()
                .await
                .map_err(|e| AppError::Drive(format!("http send: {e}")))?;

            let status = resp.status();

            if status.is_success() {
                return Ok(resp);
            }

            // 429 or 5xx -> retry.
            let should_retry = status == StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error();

            if !should_retry || attempt == MAX_RETRIES {
                let body = resp.text().await.unwrap_or_default();
                return Err(AppError::Drive(format!("HTTP {status}: {body}")));
            }

            // Honor Retry-After if present.
            let wait = resp
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(delay);

            warn!("HTTP {status} on attempt {attempt}, retrying in {wait:?}");
            sleep(wait).await;

            // Jitter + exponential backoff.
            let jitter = Duration::from_millis(rand_millis(0, 200));
            delay = (delay * 2 + jitter).min(Duration::from_secs(60));
        }
        Err(AppError::Drive("max retries exceeded".into()))
    }

    // Files API

    /// Find a child by name inside a parent folder.
    /// Returns the file metadata if found.
    pub async fn find_child(
        &self,
        parent_id: &str,
        name: &str,
    ) -> Result<Option<DriveFile>, AppError> {
        let token = auth::access_token().await?;
        let q = format!("'{parent_id}' in parents and name='{n}' and trashed=false",
            n = name.replace('\'', "\\'"));
        let url = format!("{}/files", self.base_url);
        let resp = self.execute_with_retry(|| {
            self.http.get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[
                    ("q", q.as_str()),
                    ("fields", "files(id,md5Checksum,modifiedTime,size,mimeType)"),
                    ("pageSize", "2"),
                ])
        }).await?;

        let mut list: FileList = resp.json().await
            .map_err(|e| AppError::Drive(format!("find_child parse: {e}")))?;
        Ok(list.files.pop())
    }

    /// List all non-trashed children of a Drive folder (non-recursive, pageSize=1000).
    pub async fn list_folder(
        &self,
        parent_id: &str,
    ) -> Result<Vec<DriveFile>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);
        let q = format!("'{parent_id}' in parents and trashed=false");
        let resp = self.execute_with_retry(|| {
            self.http.get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[
                    ("q",                         q.as_str()),
                    ("fields",                    "files(id,name,mimeType,md5Checksum,modifiedTime,size,description,starred)"),
                    ("pageSize",                  "1000"),
                    ("supportsAllDrives",         "true"),
                    ("includeItemsFromAllDrives", "true"),
                ])
        }).await?;
        let list: FileList = resp.json().await
            .map_err(|e| AppError::Drive(format!("list_folder parse: {e}")))?;
        Ok(list.files)
    }

    /// Create a folder in Drive.
    pub async fn create_folder(
        &self,
        parent_id: &str,
        name: &str,
    ) -> Result<String, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);
        let body = serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        });
        let resp = self.execute_with_retry(|| {
            self.http.post(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("fields", "id")])
                .json(&body)
        }).await?;
        let created: DriveFile = resp.json().await
            .map_err(|e| AppError::Drive(format!("create_folder parse: {e}")))?;
        Ok(created.id)
    }

    /// Ensure all directories in `rel_dir` exist under `root_id`.
    /// Uses path cache; creates missing folders in order.
    pub async fn ensure_path(
        &self,
        pair_id: &str,
        root_id: &str,
        rel_dir: &str,
    ) -> Result<String, AppError> {
        if rel_dir.is_empty() || rel_dir == "." {
            return Ok(root_id.to_string());
        }

        let cache_key = format!("{pair_id}|{rel_dir}");
        {
            let cache = self.path_cache.lock().await;
            if let Some(id) = cache.get(&cache_key) {
                return Ok(id.clone());
            }
        }

        // Walk each component.
        let mut parent = root_id.to_string();
        let mut cumulative = String::new();
        for component in rel_dir.split('/').filter(|s| !s.is_empty()) {
            if !cumulative.is_empty() {
                cumulative.push('/');
            }
            cumulative.push_str(component);
            let ck = format!("{pair_id}|{cumulative}");

            let folder_id = {
                let cache = self.path_cache.lock().await;
                cache.get(&ck).cloned()
            };

            let folder_id = match folder_id {
                Some(id) => id,
                None => {
                    let id = match self.find_child(&parent, component).await? {
                        Some(f) => f.id,
                        None => self.create_folder(&parent, component).await?,
                    };
                    let mut cache = self.path_cache.lock().await;
                    cache.insert(ck, id.clone());
                    id
                }
            };

            parent = folder_id;
        }

        let mut cache = self.path_cache.lock().await;
        cache.insert(cache_key, parent.clone());
        Ok(parent)
    }

    /// Move a file to trash.
    pub async fn trash(&self, file_id: &str) -> Result<(), AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{file_id}", self.base_url);
        let body = serde_json::json!({ "trashed": true });
        self.execute_with_retry(|| {
            self.http.patch(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("fields", "id")])
                .json(&body)
        }).await?;
        Ok(())
    }

    /// Permanently delete a file.
    pub async fn delete(&self, file_id: &str) -> Result<(), AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{file_id}", self.base_url);
        self.execute_with_retry(|| {
            self.http.delete(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
        }).await?;
        Ok(())
    }

    // Multipart upload (<5 MiB)

    /// Multipart upload for files < 5 MiB.
    /// Creates or updates the file (update avoids duplicates).
    pub async fn multipart_upload(
        &self,
        parent_id: &str,
        name: &str,
        existing_id: Option<&str>,
        modified_time: &str,
        data: Vec<u8>,
        mime: &str,
    ) -> Result<DriveFileMeta, AppError> {
        let token = auth::access_token().await?;
        let meta = serde_json::json!({
            "name": name,
            "parents": if existing_id.is_none() { serde_json::json!([parent_id]) } else { serde_json::Value::Null },
            "modifiedTime": modified_time,
        });
        let meta_str = meta.to_string();

        // Build multipart body manually.
        let boundary = "tether_boundary_42";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes());
        body.extend_from_slice(meta_str.as_bytes());
        body.extend_from_slice(format!("\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(&data);
        body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());

        let content_type = format!("multipart/related; boundary={boundary}");

        let (method, url) = match existing_id {
            Some(id) => (Method::PATCH, format!("{}/files/{id}?uploadType=multipart", self.upload_base_url)),
            None => (Method::POST, format!("{}/files?uploadType=multipart", self.upload_base_url)),
        };

        let resp = self.execute_with_retry(|| {
            self.http.request(method.clone(), &url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, &content_type)
                .query(&[("fields", "id,md5Checksum,modifiedTime,headRevisionId")])
                .body(body.clone())
        }).await?;

        resp.json::<DriveFileMeta>().await
            .map_err(|e| AppError::Drive(format!("multipart parse: {e}")))
    }

    // Resumable upload (>= 5 MiB)

    /// Initiate a resumable upload session. Returns the upload URI.
    pub async fn init_resumable(
        &self,
        parent_id: &str,
        name: &str,
        existing_id: Option<&str>,
        modified_time: &str,
        total_size: u64,
        mime: &str,
    ) -> Result<String, AppError> {
        let token = auth::access_token().await?;
        let meta = serde_json::json!({
            "name": name,
            "parents": if existing_id.is_none() { serde_json::json!([parent_id]) } else { serde_json::Value::Null },
            "modifiedTime": modified_time,
        });

        let (method, url) = match existing_id {
            Some(id) => (Method::PATCH, format!("{}/files/{id}?uploadType=resumable", self.upload_base_url)),
            None => (Method::POST, format!("{}/files?uploadType=resumable", self.upload_base_url)),
        };

        let resp = self.http.request(method, &url)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header("X-Upload-Content-Type", mime)
            .header("X-Upload-Content-Length", total_size.to_string())
            .query(&[("fields", "id,md5Checksum,modifiedTime,headRevisionId")])
            .json(&meta)
            .send()
            .await
            .map_err(|e| AppError::Drive(format!("init_resumable: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let b = resp.text().await.unwrap_or_default();
            return Err(AppError::Drive(format!("init_resumable HTTP {s}: {b}")));
        }

        let location = resp.headers()
            .get("Location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::Drive("init_resumable: no Location header".into()))?
            .to_string();

        Ok(location)
    }

    /// Upload one chunk of a resumable session.
    /// Returns `Ok(None)` on 308 (continue) or `Ok(Some(meta))` on completion.
    pub async fn upload_chunk(
        &self,
        session_uri: &str,
        chunk: Vec<u8>,
        start_byte: u64,
        total_size: u64,
    ) -> Result<Option<DriveFileMeta>, AppError> {
        let end_byte = start_byte + chunk.len() as u64 - 1;
        let content_range = format!("bytes {start_byte}-{end_byte}/{total_size}");
        debug!("upload_chunk {content_range}");

        let resp = self.http.put(session_uri)
            .header("Content-Range", &content_range)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(chunk)
            .send()
            .await
            .map_err(|e| AppError::Drive(format!("upload_chunk send: {e}")))?;

        let status = resp.status();
        match status.as_u16() {
            200 | 201 => {
                let meta: DriveFileMeta = resp.json().await
                    .map_err(|e| AppError::Drive(format!("chunk done parse: {e}")))?;
                Ok(Some(meta))
            }
            308 => Ok(None), // continue
            _ => {
                let body = resp.text().await.unwrap_or_default();
                Err(AppError::Drive(format!("upload_chunk HTTP {status}: {body}")))
            }
        }
    }

    /// Query how many bytes the server has received so far (for resume).
    /// Returns the next byte to send (0 if nothing received yet).
    pub async fn query_resumable_offset(
        &self,
        session_uri: &str,
        total_size: u64,
    ) -> Result<u64, AppError> {
        let resp = self.http.put(session_uri)
            .header("Content-Range", format!("bytes */{total_size}"))
            .header(header::CONTENT_LENGTH, "0")
            .send()
            .await
            .map_err(|e| AppError::Drive(format!("query_offset send: {e}")))?;

        let status = resp.status();
        if status.as_u16() == 308 {
            // Range header: "bytes=0-N" -> next = N+1
            let next = resp.headers()
                .get("Range")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("bytes=0-"))
                .and_then(|s| s.parse::<u64>().ok())
                .map(|n| n + 1)
                .unwrap_or(0);
            Ok(next)
        } else if status.is_success() {
            Ok(total_size) // already complete
        } else if status == StatusCode::NOT_FOUND {
            Err(AppError::Drive("resumable session expired (404)".into()))
        } else {
            let body = resp.text().await.unwrap_or_default();
            Err(AppError::Drive(format!("query_offset HTTP {status}: {body}")))
        }
    }
}

impl Default for DriveClient {
    fn default() -> Self {
        Self::new().expect("DriveClient::new should not fail")
    }
}

// Drive data types

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub md5_checksum: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub starred: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileMeta {
    pub id: String,
    #[serde(default)]
    pub md5_checksum: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub head_revision_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FileList {
    #[serde(default)]
    pub(crate) files: Vec<DriveFile>,
}

// Tiny pseudo-random jitter (no rand crate)

fn rand_millis(min: u64, max: u64) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;
    min + (seed % (max - min + 1))
}
