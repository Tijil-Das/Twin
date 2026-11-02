//! P08 – Drive Revisions API.
//!
//! list_revisions, download_revision, set_keep_forever.

use reqwest::header;
use serde::{Deserialize, Serialize};

use crate::auth;
use crate::drive::client::DriveClient;
use crate::error::AppError;

/// A single revision entry from the Drive Revisions API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub keep_forever: Option<bool>,
    #[serde(default)]
    pub last_modifying_user: Option<RevisionUser>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionUser {
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RevisionList {
    #[serde(default)]
    revisions: Vec<Revision>,
}

impl DriveClient {
    /// List all revisions for a file.
    pub async fn list_revisions(&self, file_id: &str) -> Result<Vec<Revision>, AppError> {
        let token = auth::access_token().await?;
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{file_id}/revisions"
        );
        let resp = self
            .execute_with_retry(|| {
                self.http
                    .get(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[(
                        "fields",
                        "revisions(id,modifiedTime,size,keepForever,lastModifyingUser(displayName))",
                    )])
            })
            .await?;

        let list: RevisionList = resp
            .json()
            .await
            .map_err(|e| AppError::Drive(format!("list_revisions parse: {e}")))?;
        Ok(list.revisions)
    }

    /// Download the content of a specific revision.
    /// Returns the raw bytes stream as `bytes::Bytes` chunks via a `reqwest::Response`.
    pub async fn download_revision_response(
        &self,
        file_id: &str,
        rev_id: &str,
    ) -> Result<reqwest::Response, AppError> {
        let token = auth::access_token().await?;
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{file_id}/revisions/{rev_id}"
        );
        let resp = self
            .execute_with_retry(|| {
                self.http
                    .get(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[("alt", "media")])
            })
            .await?;
        Ok(resp)
    }

    /// Set (or clear) the `keepForever` flag on a revision.
    pub async fn set_keep_forever(
        &self,
        file_id: &str,
        rev_id: &str,
        keep: bool,
    ) -> Result<(), AppError> {
        let token = auth::access_token().await?;
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{file_id}/revisions/{rev_id}"
        );
        let body = serde_json::json!({ "keepForever": keep });
        self.execute_with_retry(|| {
            self.http
                .patch(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("fields", "id,keepForever")])
                .json(&body)
        })
        .await?;
        Ok(())
    }
}

