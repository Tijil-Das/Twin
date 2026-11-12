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

static GLOBAL_PATH_CACHE: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
static PATH_ENSURE_LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();

fn global_path_cache() -> &'static Mutex<HashMap<String, String>> {
    GLOBAL_PATH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn path_ensure_lock() -> &'static Mutex<()> {
    PATH_ENSURE_LOCK.get_or_init(|| Mutex::new(()))
}

/// Evict all path cache entries starting with `{pair_id}|{rel_path}`.
pub async fn invalidate_path_cache(pair_id: &str, rel_path: &str) {
    let mut cache = global_path_cache().lock().await;
    let clean_rel = rel_path.trim_matches('/');
    let prefix = if clean_rel.is_empty() {
        format!("{pair_id}|")
    } else {
        format!("{pair_id}|{clean_rel}")
    };
    cache.retain(|k, _| !k.starts_with(&prefix));
}

/// Check if an error message indicates the file is already deleted, trashed, or not found on Drive.
pub fn is_already_deleted_or_not_found(err_str: &str) -> bool {
    let s = err_str.to_ascii_lowercase();
    s.contains("404")
        || s.contains("410")
        || s.contains("notfound")
        || s.contains("not found")
        || s.contains("alreadytrashed")
        || s.contains("cannottrash")
        || s.contains("item has been deleted")
        || s.contains("item is in trash")
}

// DriveClient

/// Shared Drive API client. Clone-friendly (Arc inside).
#[derive(Clone)]
pub struct DriveClient {
    pub(crate) http: Client,
    pub(crate) base_url: String,
    pub(crate) upload_base_url: String,
    /// Cache: Drive folder path -> folder id, keyed by (pair_id, rel_dir).
    _path_cache: Arc<Mutex<HashMap<String, String>>>,
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
            _path_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Build a client with a custom reqwest::Client and base URL (useful for testing against in-process fakes).
    pub fn new_with_client(http: Client, base_url: String) -> Self {
        DriveClient {
            http,
            upload_base_url: base_url.clone(),
            base_url,
            _path_cache: Arc::new(Mutex::new(HashMap::new())),
        }
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
                    ("fields", "files(id,name,md5Checksum,modifiedTime,size,mimeType)"),
                    ("pageSize", "10"),
                    ("supportsAllDrives", "true"),
                    ("includeItemsFromAllDrives", "true"),
                ])
        }).await?;

        let list: FileList = resp.json().await
            .map_err(|e| AppError::Drive(format!("find_child parse: {e}")))?;
        Ok(list.files.into_iter().next())
    }

    /// Find an existing non-trashed folder by name inside a parent folder.
    pub async fn find_child_folder(
        &self,
        parent_id: &str,
        name: &str,
    ) -> Result<Option<DriveFile>, AppError> {
        let token = auth::access_token().await?;
        let q = format!(
            "'{parent_id}' in parents and name='{n}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            n = name.replace('\'', "\\'")
        );
        let url = format!("{}/files", self.base_url);
        let resp = self.execute_with_retry(|| {
            self.http.get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[
                    ("q", q.as_str()),
                    ("fields", "files(id,name,mimeType)"),
                    ("pageSize", "10"),
                    ("supportsAllDrives", "true"),
                    ("includeItemsFromAllDrives", "true"),
                ])
        }).await?;

        let list: FileList = resp.json().await
            .map_err(|e| AppError::Drive(format!("find_child_folder parse: {e}")))?;
        Ok(list.files.into_iter().next())
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
                    ("fields",                    "files(id,name,mimeType,md5Checksum,modifiedTime,size,description,starred,parents,folderColorRgb)"),
                    ("pageSize",                  "1000"),
                    ("supportsAllDrives",         "true"),
                ])
        }).await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            tracing::error!("list_folder HTTP {status}: {body}");
            return Err(AppError::Drive(format!("list_folder HTTP {status}: {body}")));
        }
        let list: FileList = resp.json().await
            .map_err(|e| AppError::Drive(format!("list_folder parse: {e}")))?;
        Ok(list.files)
    }

    /// List immediate subfolders of a specific parent folder in Google Drive (ordered by name).
    pub async fn list_subfolders(
        &self,
        parent_id: &str,
    ) -> Result<Vec<DriveFile>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);
        let q = format!("'{parent_id}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false");
        let resp = self.execute_with_retry(|| {
            self.http.get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[
                    ("q",                         q.as_str()),
                    ("fields",                    "files(id,name,mimeType,modifiedTime,parents,starred,shared,folderColorRgb)"),
                    ("pageSize",                  "1000"),
                    ("orderBy",                   "name"),
                    ("supportsAllDrives",         "true"),
                ])
        }).await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            tracing::error!("list_subfolders HTTP {status}: {body}");
            return Err(AppError::Drive(format!("list_subfolders HTTP {status}: {body}")));
        }
        let list: FileList = resp.json().await
            .map_err(|e| AppError::Drive(format!("list_subfolders parse: {e}")))?;
        Ok(list.files)
    }

    /// Get folder details by ID.
    pub async fn get_folder_meta(&self, folder_id: &str) -> Result<DriveFile, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{folder_id}", self.base_url);
        let resp = self.execute_with_retry(|| {
            self.http.get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[
                    ("fields", "id,name,mimeType,modifiedTime,parents,starred,shared,folderColorRgb"),
                    ("supportsAllDrives", "true"),
                ])
        }).await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Drive(format!("get_folder_meta HTTP {status}: {body}")));
        }
        resp.json().await.map_err(|e| AppError::Drive(format!("parse meta: {e}")))
    }

    /// Retrieve folders owned by the authenticated user in My Drive ('me' in owners, pageSize=1000).
    pub async fn get_my_drive_folders(&self) -> Result<Vec<DriveFile>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);
        let q = "(mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and 'me' in owners and trashed = false";
        let resp = self.execute_with_retry(|| {
            self.http.get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[
                    ("q",                         q),
                    ("fields",                    "files(id,name,mimeType,modifiedTime,parents,starred,shared,folderColorRgb)"),
                    ("pageSize",                  "1000"),
                    ("orderBy",                   "name"),
                    ("supportsAllDrives",         "true"),
                ])
        }).await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            tracing::error!("get_my_drive_folders HTTP {status}: {body}");
            return Err(AppError::Drive(format!("get_my_drive_folders HTTP {status}: {body}")));
        }
        let list: FileList = resp.json().await
            .map_err(|e| AppError::Drive(format!("get_my_drive_folders parse: {e}")))?;
        Ok(list.files)
    }

    /// Retrieve folders shared with the user (sharedWithMe = true, pageSize=1000).
    pub async fn get_shared_with_me_folders(&self) -> Result<Vec<DriveFile>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);
        let q = "(mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and sharedWithMe = true and trashed = false";
        let resp = self.execute_with_retry(|| {
            self.http.get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[
                    ("q",                         q),
                    ("fields",                    "files(id,name,mimeType,modifiedTime,parents,starred,shared,folderColorRgb)"),
                    ("pageSize",                  "1000"),
                    ("orderBy",                   "name"),
                    ("supportsAllDrives",         "true"),
                ])
        }).await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            tracing::error!("get_shared_with_me_folders HTTP {status}: {body}");
            return Err(AppError::Drive(format!("get_shared_with_me_folders HTTP {status}: {body}")));
        }
        let list: FileList = resp.json().await
            .map_err(|e| AppError::Drive(format!("get_shared_with_me_folders parse: {e}")))?;
        Ok(list.files)
    }

    /// Default all folders query: returns user-owned My Drive folders.
    pub async fn get_all_folders(&self) -> Result<Vec<DriveFile>, AppError> {
        self.get_my_drive_folders().await
    }

    /// Create a folder in Drive.
    pub async fn create_folder(
        &self,
        parent_id: &str,
        name: &str,
    ) -> Result<String, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);
        let cfg = crate::config::load().unwrap_or_default();
        let mut body_map = serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        });
        if cfg.app.color_drive_folders {
            if let Some(obj) = body_map.as_object_mut() {
                let parent_meta = self.get_folder_meta(parent_id).await.ok();
                let parent_idx = parent_meta
                    .as_ref()
                    .and_then(|m| crate::drive::colorizer::palette_index_of(m.folder_color_rgb.as_deref()))
                    .unwrap_or(0);

                let used_colors: Vec<String> = match self.list_subfolders(parent_id).await {
                    Ok(subs) => subs.into_iter().filter_map(|s| s.folder_color_rgb).collect(),
                    Err(_) => Vec::new(),
                };

                let assigned_color = crate::drive::colorizer::pick_next_available_sibling_color(parent_idx, &used_colors);
                obj.insert("folderColorRgb".to_string(), serde_json::json!(assigned_color));
            }
        }
        let resp = self.execute_with_retry(|| {
            self.http.post(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("fields", "id"), ("supportsAllDrives", "true")])
                .json(&body_map)
        }).await?;
        let created: DriveFile = resp.json().await
            .map_err(|e| AppError::Drive(format!("create_folder parse: {e}")))?;
        Ok(created.id)
    }

    /// Set folder color on Google Drive (folderColorRgb). If None or empty, clears color.
    pub async fn set_folder_color(
        &self,
        folder_id: &str,
        color_rgb: Option<&str>,
    ) -> Result<(), AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{folder_id}", self.base_url);
        let body = match color_rgb {
            Some(c) if !c.trim().is_empty() => serde_json::json!({
                "folderColorRgb": c.trim()
            }),
            _ => serde_json::json!({
                "folderColorRgb": serde_json::Value::Null
            }),
        };
        self.execute_with_retry(|| {
            self.http.patch(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("supportsAllDrives", "true")])
                .json(&body)
        }).await?;
        Ok(())
    }

    /// Ensure all directories in `rel_dir` exist under `root_id`.
    /// Uses global synchronized path cache; creates missing folders in order without racing.
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
            let cache = global_path_cache().lock().await;
            if let Some(id) = cache.get(&cache_key) {
                return Ok(id.clone());
            }
        }

        // Acquire lock so parallel transfer workers don't race to create duplicate folders.
        let _guard = path_ensure_lock().lock().await;

        // Re-check cache under the lock in case another worker just finished ensuring this path.
        {
            let cache = global_path_cache().lock().await;
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
                let cache = global_path_cache().lock().await;
                cache.get(&ck).cloned()
            };

            let folder_id = match folder_id {
                Some(id) => id,
                None => {
                    // Check if folder already exists in Drive (exact folder search).
                    let id = match self.find_child_folder(&parent, component).await? {
                        Some(f) => f.id,
                        None => self.create_folder(&parent, component).await?,
                    };
                    let mut cache = global_path_cache().lock().await;
                    cache.insert(ck, id.clone());
                    id
                }
            };

            parent = folder_id;
        }

        let mut cache = global_path_cache().lock().await;
        cache.insert(cache_key, parent.clone());
        Ok(parent)
    }

    /// Move a file to trash. If the file is already deleted or not found (404/410), succeeds idempotently.
    pub async fn trash(&self, file_id: &str) -> Result<(), AppError> {
        let clean_id = file_id.trim();
        if clean_id.is_empty() {
            return Ok(());
        }
        let token = auth::access_token().await?;
        let url = format!("{}/files/{clean_id}", self.base_url);
        let body = serde_json::json!({ "trashed": true });
        let res = self.execute_with_retry(|| {
            self.http.patch(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("fields", "id"), ("supportsAllDrives", "true")])
                .json(&body)
        }).await;

        match res {
            Ok(_) => Ok(()),
            Err(e) => {
                let s = e.to_string();
                if is_already_deleted_or_not_found(&s) {
                    debug!("trash: file {clean_id} already not found or trashed ({s}), treating as success");
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Permanently delete a file. If the file is already deleted or not found (404/410), succeeds idempotently.
    pub async fn delete(&self, file_id: &str) -> Result<(), AppError> {
        let clean_id = file_id.trim();
        if clean_id.is_empty() {
            return Ok(());
        }
        let token = auth::access_token().await?;
        let url = format!("{}/files/{clean_id}", self.base_url);
        let res = self.execute_with_retry(|| {
            self.http.delete(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("supportsAllDrives", "true")])
        }).await;

        match res {
            Ok(_) => Ok(()),
            Err(e) => {
                let s = e.to_string();
                if is_already_deleted_or_not_found(&s) {
                    debug!("delete: file {clean_id} already not found or deleted ({s}), treating as success");
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Check whether a string looks like a valid Drive file/folder ID (non-empty, no slashes).
    pub fn is_valid_drive_id(id: &str) -> bool {
        let s = id.trim();
        !s.is_empty() && !s.contains('/') && !s.contains('\\')
    }

    /// Rename (and optionally move) a file on Drive — metadata update only, no content upload.
    /// If `new_parent_id` is Some and different from `old_parent_id`, also moves it.
    pub async fn rename_file(
        &self,
        file_id: &str,
        new_name: &str,
        new_parent_id: Option<&str>,
        old_parent_id: Option<&str>,
    ) -> Result<(), AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{file_id}", self.base_url);
        let body = serde_json::json!({ "name": new_name });

        // Validate parent IDs — never pass local file/folder paths to Drive parent query parameters!
        let valid_new = new_parent_id.filter(|id| Self::is_valid_drive_id(id));
        let valid_old = old_parent_id.filter(|id| Self::is_valid_drive_id(id));

        // Build query params conditionally.
        let needs_move = valid_new.is_some()
            && valid_old.is_some()
            && valid_new != valid_old;

        let resp = if needs_move {
            let add = valid_new.unwrap();
            let remove = valid_old.unwrap();
            self.execute_with_retry(|| {
                self.http.patch(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[
                        ("addParents", add),
                        ("removeParents", remove),
                        ("supportsAllDrives", "true"),
                    ])
                    .json(&body)
            }).await?
        } else if let Some(add) = valid_new.filter(|_| old_parent_id.is_none()) {
            // New parent specified without explicit old parent
            self.execute_with_retry(|| {
                self.http.patch(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[
                        ("addParents", add),
                        ("supportsAllDrives", "true"),
                    ])
                    .json(&body)
            }).await?
        } else {
            self.execute_with_retry(|| {
                self.http.patch(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[("supportsAllDrives", "true")])
                    .json(&body)
            }).await?
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(AppError::Drive(format!("rename_file {status}: {body_text}")));
        }
        Ok(())
    }

    /// Reliably move and/or rename a file or folder on Google Drive.
    /// If `target_parent_id` is Some, queries the file's current parents and removes old parents while adding the target.
    /// Safely handles files that already reside in `target_parent_id`.
    pub async fn move_and_rename_file(
        &self,
        file_id: &str,
        new_name: &str,
        target_parent_id: Option<&str>,
    ) -> Result<(), AppError> {
        let clean_target = target_parent_id.filter(|id| Self::is_valid_drive_id(id));

        if let Some(target_id) = clean_target {
            // Fetch current metadata (including current parents) directly from Drive
            let meta = self.get_folder_meta(file_id).await?;
            let current_parents = meta.parents.unwrap_or_default();

            if current_parents.len() == 1 && current_parents[0] == target_id {
                // Already in target parent folder, only rename needed
                return self.rename_file(file_id, new_name, None, None).await;
            }

            let to_remove: Vec<String> = current_parents
                .into_iter()
                .filter(|p| p.as_str() != target_id)
                .collect();
            let remove_arg = if to_remove.is_empty() {
                None
            } else {
                Some(to_remove.join(","))
            };

            self.rename_file(file_id, new_name, Some(target_id), remove_arg.as_deref()).await
        } else {
            self.rename_file(file_id, new_name, None, None).await
        }
    }

    /// Find a folder on Drive by its relative path under `root_id` (e.g. "temp sex/Alcohols & Phenols 2").
    /// Walks child folder components and returns the `DriveFile` of the destination folder if it exists.
    pub async fn find_folder_by_path(
        &self,
        root_id: &str,
        rel_dir: &str,
    ) -> Result<Option<DriveFile>, AppError> {
        let clean = rel_dir.trim_matches('/').replace('\\', "/");
        if clean.is_empty() || clean == "." {
            return self.get_folder_meta(root_id).await.map(Some);
        }

        let mut current_parent = root_id.to_string();
        let mut last_folder: Option<DriveFile> = None;

        for component in clean.split('/').filter(|s| !s.is_empty()) {
            match self.find_child_folder(&current_parent, component).await? {
                Some(folder) => {
                    current_parent = folder.id.clone();
                    last_folder = Some(folder);
                }
                None => return Ok(None),
            }
        }

        Ok(last_folder)
    }

    /// Move a file or folder from old_parent to new_parent in Google Drive.
    pub async fn move_file_parent(
        &self,
        file_id: &str,
        new_parent: &str,
        old_parent: &str,
    ) -> Result<(), AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{file_id}", self.base_url);
        let resp = self
            .execute_with_retry(|| {
                self.http
                    .patch(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[
                        ("addParents", new_parent),
                        ("removeParents", old_parent),
                        ("supportsAllDrives", "true"),
                    ])
            })
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Drive(format!("move_file_parent {status}: {body}")));
        }
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
        // Only send `parents` when creating; a PATCH with `"parents": null`
        // is rejected by the Drive API.
        let mut meta = serde_json::json!({
            "name": name,
            "modifiedTime": modified_time,
        });
        if existing_id.is_none() {
            meta["parents"] = serde_json::json!([parent_id]);
        }
        let meta_str = meta.to_string();

        // Build multipart body manually.
        let boundary = "twin_boundary_42";
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
                .query(&[("fields", "id,md5Checksum,modifiedTime,headRevisionId"), ("supportsAllDrives", "true")])
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
        // Only send `parents` when creating; a PATCH with `"parents": null`
        // is rejected by the Drive API.
        let mut meta = serde_json::json!({
            "name": name,
            "modifiedTime": modified_time,
        });
        if existing_id.is_none() {
            meta["parents"] = serde_json::json!([parent_id]);
        }

        let (method, url) = match existing_id {
            Some(id) => (Method::PATCH, format!("{}/files/{id}?uploadType=resumable", self.upload_base_url)),
            None => (Method::POST, format!("{}/files?uploadType=resumable", self.upload_base_url)),
        };

        let resp = self.http.request(method, &url)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header("X-Upload-Content-Type", mime)
            .header("X-Upload-Content-Length", total_size.to_string())
            .query(&[("fields", "id,md5Checksum,modifiedTime,headRevisionId"), ("supportsAllDrives", "true")])
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
        if chunk.is_empty() {
            return Err(AppError::Drive("upload_chunk called with empty buffer".into()));
        }
        if start_byte >= total_size {
            return Err(AppError::Drive(format!("upload_chunk start_byte {start_byte} >= total_size {total_size}")));
        }
        let end_byte = (start_byte + chunk.len() as u64 - 1).min(total_size.saturating_sub(1));
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
                let retry_after = resp.headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok());
                let body = resp.text().await.unwrap_or_default();
                if let Some(secs) = retry_after {
                    Err(AppError::Drive(format!("upload_chunk HTTP {status} (retry-after: {secs}s): {body}")))
                } else {
                    Err(AppError::Drive(format!("upload_chunk HTTP {status}: {body}")))
                }
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
        match self.query_resumable_status(session_uri, total_size).await? {
            ResumableStatus::Incomplete(offset) => Ok(offset),
            ResumableStatus::Complete(_) => Ok(total_size),
        }
    }

    /// Query the status of an ongoing resumable upload session on Google Drive.
    pub async fn query_resumable_status(
        &self,
        session_uri: &str,
        total_size: u64,
    ) -> Result<ResumableStatus, AppError> {
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
            Ok(ResumableStatus::Incomplete(next))
        } else if status.is_success() {
            let meta: DriveFileMeta = resp.json().await
                .map_err(|e| AppError::Drive(format!("query_status parse meta: {e}")))?;
            Ok(ResumableStatus::Complete(meta))
        } else if status == StatusCode::NOT_FOUND {
            Err(AppError::Drive("resumable session expired (404)".into()))
        } else {
            let body = resp.text().await.unwrap_or_default();
            Err(AppError::Drive(format!("query_offset HTTP {status}: {body}")))
        }
    }

    // ── AppData Folder (Application Data) ──────────────────────────────────────

    /// List all files in the hidden application data folder (`appDataFolder`).
    pub async fn list_appdata(&self) -> Result<Vec<DriveFile>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);

        let resp = self
            .execute_with_retry(|| {
                self.http
                    .get(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[
                        ("spaces", "appDataFolder"),
                        ("fields", "files(id, name, modifiedTime, size, md5Checksum, trashed)"),
                    ])
            })
            .await?;

        let list: FileList = resp
            .json()
            .await
            .map_err(|e| AppError::Drive(format!("parse list_appdata: {e}")))?;

        Ok(list.files.into_iter().filter(|f| f.trashed != Some(true)).collect())
    }

    /// Find a file in `appDataFolder` by filename.
    pub async fn get_appdata_file(&self, filename: &str) -> Result<Option<DriveFile>, AppError> {
        let files = self.list_appdata().await?;
        Ok(files.into_iter().find(|f| f.name.as_deref() == Some(filename)))
    }

    /// Upload or update a file in the hidden `appDataFolder`.
    pub async fn upload_appdata(
        &self,
        filename: &str,
        content: &[u8],
    ) -> Result<DriveFileMeta, AppError> {
        let token = auth::access_token().await?;
        let existing = self.get_appdata_file(filename).await?;

        if let Some(file) = existing {
            // Update existing file content via PATCH /upload/drive/v3/files/{id}?uploadType=media
            let url = format!("{}/files/{}?uploadType=media", self.upload_base_url, file.id);
            let body = content.to_vec();
            let resp = self
                .execute_with_retry(|| {
                    self.http
                        .patch(&url)
                        .header(header::AUTHORIZATION, format!("Bearer {token}"))
                        .header(header::CONTENT_TYPE, "application/octet-stream")
                        .body(body.clone())
                })
                .await?;

            resp.json::<DriveFileMeta>()
                .await
                .map_err(|e| AppError::Drive(format!("parse update_appdata response: {e}")))
        } else {
            // Create new file with parents: ["appDataFolder"]
            let boundary = "BOUNDARY_TWIN_APPDATA";
            let metadata = serde_json::json!({
                "name": filename,
                "parents": ["appDataFolder"]
            });
            let meta_json = serde_json::to_string(&metadata)
                .map_err(|e| AppError::Drive(format!("metadata json: {e}")))?;

            let mut body = Vec::new();
            body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta_json}\r\n").as_bytes());
            body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
            body.extend_from_slice(content);
            body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

            let url = format!("{}/files?uploadType=multipart", self.upload_base_url);
            let resp = self
                .execute_with_retry(|| {
                    self.http
                        .post(&url)
                        .header(header::AUTHORIZATION, format!("Bearer {token}"))
                        .header(
                            header::CONTENT_TYPE,
                            format!("multipart/related; boundary={boundary}"),
                        )
                        .body(body.clone())
                })
                .await?;

            resp.json::<DriveFileMeta>()
                .await
                .map_err(|e| AppError::Drive(format!("parse create_appdata response: {e}")))
        }
    }

    /// Download content of a file in `appDataFolder` by file ID.
    pub async fn download_appdata(&self, file_id: &str) -> Result<Vec<u8>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{}?alt=media", self.base_url, file_id);

        let resp = self
            .execute_with_retry(|| {
                self.http
                    .get(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
            })
            .await?;

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Drive(format!("download_appdata bytes: {e}")))?;

        Ok(bytes.to_vec())
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
    #[serde(default)]
    pub trashed: Option<bool>,
    #[serde(default)]
    pub parents: Option<Vec<String>>,
    #[serde(default)]
    pub shared: Option<bool>,
    #[serde(default)]
    pub folder_color_rgb: Option<String>,
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

/// Status of an in-flight Google Drive resumable upload session.
#[derive(Debug, Clone)]
pub enum ResumableStatus {
    /// Incomplete upload; indicates the next byte offset the server expects.
    Incomplete(u64),
    /// File upload completed; contains finalized Drive file metadata.
    Complete(DriveFileMeta),
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
