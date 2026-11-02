//! P09 – Drive Changes API + folder listing.

use std::collections::HashMap;

use reqwest::header;
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::auth;
use crate::drive::client::DriveClient;
use crate::error::AppError;

const API_BASE: &str = "https://www.googleapis.com/drive/v3";

// ── Types ─────────────────────────────────────────────────────────────────────

/// A single entry from the Drive folder listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveEntry {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub parents: Option<Vec<String>>,
    #[serde(default)]
    pub md5_checksum: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub trashed: Option<bool>,
}

/// A single entry from the Changes API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveChange {
    pub file_id: String,
    #[serde(default)]
    pub removed: Option<bool>,
    #[serde(default)]
    pub file: Option<DriveEntry>,
}

/// Result of `fetch_changes`.
#[derive(Debug)]
pub struct ChangesResult {
    pub changes: Vec<DriveChange>,
    /// Present on the last page — becomes the new stored token.
    pub new_start_page_token: Option<String>,
    /// Present on intermediate pages.
    pub next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesPage {
    #[serde(default)]
    changes: Vec<DriveChange>,
    #[serde(default)]
    next_page_token: Option<String>,
    #[serde(default)]
    new_start_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartTokenResp {
    start_page_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePage {
    #[serde(default)]
    files: Vec<DriveEntry>,
    #[serde(default, rename = "nextPageToken")]
    next_page_token: Option<String>,
}

// ── API functions ─────────────────────────────────────────────────────────────

/// Get the current start page token for the Changes API.
pub async fn get_start_page_token(drive: &DriveClient) -> Result<String, AppError> {
    let token = auth::access_token().await?;
    let url = format!("{API_BASE}/changes/startPageToken");
    let resp = drive
        .execute_with_retry(|| {
            drive
                .http
                .get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("supportsAllDrives", "true")])
        })
        .await?;
    let r: StartTokenResp = resp
        .json()
        .await
        .map_err(|e| AppError::Drive(format!("startPageToken parse: {e}")))?;
    Ok(r.start_page_token)
}

/// Fetch all changes since `page_token`.
/// Filters to changes whose ancestor chain includes `root_folder_id`.
#[allow(unused_assignments)]
pub async fn fetch_changes(
    drive: &DriveClient,
    page_token: &str,
    root_folder_id: &str,
) -> Result<ChangesResult, AppError> {
    let token = auth::access_token().await?;
    let url = format!("{API_BASE}/changes");
    let fields = "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,parents,md5Checksum,modifiedTime,size,mimeType,trashed))";

    let mut all_changes: Vec<DriveChange> = Vec::new();
    let mut current_token = page_token.to_string();
    let mut final_new_start: Option<String> = None;
    let mut final_next_tok: Option<String> = None;

    // Cache for parent-ancestor resolution: file_id -> known ancestor of root?
    let mut ancestor_cache: HashMap<String, bool> = HashMap::new();

    loop {
        let resp = drive
            .execute_with_retry(|| {
                drive
                    .http
                    .get(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[
                        ("pageToken",        current_token.as_str()),
                        ("fields",           fields),
                        ("pageSize",         "1000"),
                        ("supportsAllDrives","true"),
                    ])
            })
            .await?;

        let page: ChangesPage = resp
            .json()
            .await
            .map_err(|e| AppError::Drive(format!("changes parse: {e}")))?;

        for change in page.changes {
            // Only keep changes that belong to our Drive folder tree.
            let in_tree = is_in_folder_tree(
                drive, &change, root_folder_id, &mut ancestor_cache,
            )
            .await;
            if in_tree {
                debug!("change in tree: {}", change.file_id);
                all_changes.push(change);
            }
        }

        final_new_start = page.new_start_page_token;
        final_next_tok  = page.next_page_token.clone();

        match page.next_page_token {
            Some(t) => current_token = t,
            None    => break,
        }
    }

    Ok(ChangesResult {
        changes: all_changes,
        new_start_page_token: final_new_start,
        next_page_token: final_next_tok,
    })
}

/// Recursively check if a change's file is under `root_folder_id`.
/// Uses `ancestor_cache` to avoid repeated API calls.
async fn is_in_folder_tree(
    drive: &DriveClient,
    change: &DriveChange,
    root_folder_id: &str,
    cache: &mut HashMap<String, bool>,
) -> bool {
    // Removed files have no parents metadata — include them (we'll look up by file_id in Db).
    if change.removed == Some(true) {
        return true;
    }
    let Some(file) = &change.file else { return false };
    let parents = match &file.parents {
        Some(p) if !p.is_empty() => p.clone(),
        _ => return false,
    };

    // BFS through parent chain.
    let mut queue: Vec<String> = parents.clone();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();

    while let Some(pid) = queue.pop() {
        if pid == root_folder_id {
            return true;
        }
        if !visited.insert(pid.clone()) {
            continue;
        }
        if let Some(&known) = cache.get(&pid) {
            if known { return true; }
            continue;
        }

        // Look up this folder's parents via API.
        match fetch_parents(drive, &pid).await {
            Ok(parent_ids) => {
                for gp in parent_ids {
                    queue.push(gp);
                }
            }
            Err(_) => {
                cache.insert(pid, false);
            }
        }
    }

    false
}

/// Fetch the parent IDs of a Drive file/folder.
async fn fetch_parents(drive: &DriveClient, file_id: &str) -> Result<Vec<String>, AppError> {
    let token = auth::access_token().await?;
    let url = format!("{API_BASE}/files/{file_id}");
    let resp = drive
        .execute_with_retry(|| {
            drive
                .http
                .get(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("fields", "id,parents"), ("supportsAllDrives", "true")])
        })
        .await?;

    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        parents: Option<Vec<String>>,
    }
    let r: Resp = resp
        .json()
        .await
        .map_err(|e| AppError::Drive(format!("fetch_parents parse: {e}")))?;
    Ok(r.parents.unwrap_or_default())
}

/// List all files in a Drive folder tree (recursive via pageSize=1000).
/// Returns a flat list of all non-trashed files.
pub async fn list_drive_folder(
    drive: &DriveClient,
    root_folder_id: &str,
) -> Result<Vec<DriveEntry>, AppError> {
    let token = auth::access_token().await?;
    let url = "https://www.googleapis.com/drive/v3/files".to_string();
    let fields = "nextPageToken,files(id,name,parents,md5Checksum,modifiedTime,size,mimeType,trashed)";

    let mut all: Vec<DriveEntry> = Vec::new();
    // Use a stack of folder IDs to explore.
    let mut folders_to_explore = vec![root_folder_id.to_string()];

    while let Some(folder_id) = folders_to_explore.pop() {
        let mut page_token: Option<String> = None;

        loop {
            let q = format!("'{folder_id}' in parents");
            let resp = drive
                .execute_with_retry(|| {
                    let mut req = drive
                        .http
                        .get(&url)
                        .header(header::AUTHORIZATION, format!("Bearer {token}"))
                        .query(&[
                            ("q",                 q.as_str()),
                            ("fields",            fields),
                            ("pageSize",          "1000"),
                            ("supportsAllDrives", "true"),
                        ]);
                    if let Some(ref tok) = page_token {
                        req = req.query(&[("pageToken", tok.as_str())]);
                    }
                    req
                })
                .await?;

            let page: FilePage = resp
                .json()
                .await
                .map_err(|e| AppError::Drive(format!("list_drive_folder parse: {e}")))?;

            for entry in page.files {
                if entry.trashed == Some(true) {
                    continue;
                }
                let is_folder = entry.mime_type.as_deref()
                    == Some("application/vnd.google-apps.folder");
                if is_folder {
                    folders_to_explore.push(entry.id.clone());
                }
                all.push(entry);
            }

            match page.next_page_token {
                Some(t) => page_token = Some(t),
                None    => break,
            }
        }
    }

    Ok(all)
}

