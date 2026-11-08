//! P08 – Drive Trash API.
//!
//! list_trashed, untrash.

use reqwest::header;
use serde::{Deserialize, Serialize};

use crate::auth;
use crate::drive::client::DriveClient;
use crate::error::AppError;


/// A trashed file entry (includes `name` which `DriveFile` omits).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedFile {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub md5_checksum: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TrashedPage {
    #[serde(default)]
    files: Vec<TrashedFile>,
    #[serde(rename = "nextPageToken", default)]
    next_page_token: Option<String>,
}

impl DriveClient {
    /// List trashed files. If `parent_id` is given, restricts to that parent.
    /// Pages through all results (pageSize=1000).
    pub async fn list_trashed(
        &self,
        parent_id: Option<&str>,
    ) -> Result<Vec<TrashedFile>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);

        let q = match parent_id {
            Some(pid) => format!("trashed=true and '{pid}' in parents"),
            None      => "trashed=true".to_string(),
        };

        let mut files: Vec<TrashedFile> = Vec::new();
        let mut page_token: Option<String> = None;

        loop {
            let resp = self
                .execute_with_retry(|| {
                    let mut req = self.http.get(&url)
                        .header(header::AUTHORIZATION, format!("Bearer {token}"))
                        .query(&[
                            ("q",     q.as_str()),
                            ("fields","nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,size)"),
                            ("pageSize","1000"),
                        ]);
                    if let Some(ref tok) = page_token {
                        req = req.query(&[("pageToken", tok.as_str())]);
                    }
                    req
                })
                .await?;

            let page: TrashedPage = resp
                .json()
                .await
                .map_err(|e| AppError::Drive(format!("list_trashed parse: {e}")))?;

            files.extend(page.files);

            match page.next_page_token {
                Some(tok) => page_token = Some(tok),
                None => break,
            }
        }

        Ok(files)
    }

    /// Restore a trashed file by setting `trashed=false`.
    pub async fn untrash(&self, file_id: &str) -> Result<(), AppError> {
        let clean_id = file_id.trim();
        if clean_id.is_empty() {
            return Ok(());
        }
        let token = auth::access_token().await?;
        let url = format!("{}/files/{clean_id}", self.base_url);
        let body = serde_json::json!({ "trashed": false });
        let res = self.execute_with_retry(|| {
            self.http
                .patch(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[
                    ("fields", "id"),
                    ("supportsAllDrives", "true"),
                ])
                .json(&body)
        })
        .await;

        match res {
            Ok(_) => Ok(()),
            Err(e) => {
                let s = e.to_string();
                if crate::drive::client::is_already_deleted_or_not_found(&s) || s.to_ascii_lowercase().contains("nottrashed") {
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }
}
