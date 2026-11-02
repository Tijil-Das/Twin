//! P12 – Drive extras: storage quota, shared drives, share links, search, metadata.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::header;
use serde::{Deserialize, Serialize};

use crate::auth;
use crate::drive::client::{DriveClient, DriveFile, FileList};
use crate::error::AppError;

// ── Storage Quota ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageQuota {
    pub limit: Option<i64>,
    pub usage: i64,
    pub usage_in_drive: i64,
    pub usage_in_drive_trash: i64,
}

#[derive(Debug, Deserialize)]
struct AboutResponse {
    #[serde(rename = "storageQuota")]
    storage_quota: StorageQuotaRaw,
}

#[derive(Debug, Deserialize)]
struct StorageQuotaRaw {
    limit: Option<String>,
    usage: Option<String>,
    #[serde(rename = "usageInDrive")]
    usage_in_drive: Option<String>,
    #[serde(rename = "usageInDriveTrash")]
    usage_in_drive_trash: Option<String>,
}

static QUOTA_CACHE: Mutex<Option<(Instant, StorageQuota)>> = Mutex::new(None);
const QUOTA_CACHE_TTL: Duration = Duration::from_secs(600); // 10 minutes

// ── Shared Drives ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SharedDrive {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct SharedDriveList {
    #[serde(default)]
    drives: Vec<SharedDrive>,
}

// ── API Implementation ────────────────────────────────────────────────────────

impl DriveClient {
    /// Share link: POST /files/{id}/permissions then GET webViewLink.
    pub async fn share_link(
        &self,
        file_id: &str,
        role: &str,
        anyone: bool,
    ) -> Result<String, AppError> {
        let token = auth::access_token().await?;
        let perm_url = format!("{}/files/{file_id}/permissions", self.base_url);
        let perm_type = if anyone { "anyone" } else { "user" };

        let body = serde_json::json!({
            "role": role,
            "type": perm_type,
        });

        let _ = self
            .execute_with_retry(|| {
                self.http
                    .post(&perm_url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[("supportsAllDrives", "true")])
                    .json(&body)
            })
            .await?;

        // Fetch webViewLink
        let file_url = format!("{}/files/{file_id}", self.base_url);
        let resp = self
            .execute_with_retry(|| {
                self.http
                    .get(&file_url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[
                        ("fields", "webViewLink"),
                        ("supportsAllDrives", "true"),
                    ])
            })
            .await?;

        #[derive(Deserialize)]
        struct LinkResp {
            #[serde(rename = "webViewLink")]
            web_view_link: Option<String>,
        }

        let parsed: LinkResp = resp
            .json()
            .await
            .map_err(|e| AppError::Drive(format!("parse webViewLink: {e}")))?;

        parsed
            .web_view_link
            .ok_or_else(|| AppError::Drive("no webViewLink in response".into()))
    }

    /// Storage quota: GET /about?fields=storageQuota (cached for 10 minutes).
    pub async fn get_storage_quota(&self) -> Result<StorageQuota, AppError> {
        if let Ok(guard) = QUOTA_CACHE.lock() {
            if let Some((cached_at, ref quota)) = *guard {
                if cached_at.elapsed() < QUOTA_CACHE_TTL {
                    return Ok(quota.clone());
                }
            }
        }

        let token = auth::access_token().await?;
        let url = format!("{}/about", self.base_url);
        let resp = self
            .execute_with_retry(|| {
                self.http
                    .get(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[("fields", "storageQuota")])
            })
            .await?;

        let about: AboutResponse = resp
            .json()
            .await
            .map_err(|e| AppError::Drive(format!("parse about response: {e}")))?;

        let raw = about.storage_quota;
        let quota = StorageQuota {
            limit: raw.limit.and_then(|s| s.parse().ok()),
            usage: raw.usage.and_then(|s| s.parse().ok()).unwrap_or(0),
            usage_in_drive: raw.usage_in_drive.and_then(|s| s.parse().ok()).unwrap_or(0),
            usage_in_drive_trash: raw
                .usage_in_drive_trash
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
        };

        if let Ok(mut guard) = QUOTA_CACHE.lock() {
            *guard = Some((Instant::now(), quota.clone()));
        }

        Ok(quota)
    }

    /// List shared drives: GET /drives?pageSize=100.
    pub async fn list_shared_drives(&self) -> Result<Vec<SharedDrive>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/drives", self.base_url);
        let resp = self
            .execute_with_retry(|| {
                self.http
                    .get(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[("pageSize", "100")])
            })
            .await?;

        let list: SharedDriveList = resp
            .json()
            .await
            .map_err(|e| AppError::Drive(format!("parse shared drives: {e}")))?;
        Ok(list.drives)
    }

    /// Set file description: PATCH /files/{id}?supportsAllDrives=true.
    pub async fn set_description(&self, file_id: &str, text: &str) -> Result<(), AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{file_id}", self.base_url);
        let body = serde_json::json!({ "description": text });

        let _ = self
            .execute_with_retry(|| {
                self.http
                    .patch(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[("supportsAllDrives", "true")])
                    .json(&body)
            })
            .await?;
        Ok(())
    }

    /// Set file starred status: PATCH /files/{id}?supportsAllDrives=true.
    pub async fn set_starred(&self, file_id: &str, starred: bool) -> Result<(), AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{file_id}", self.base_url);
        let body = serde_json::json!({ "starred": starred });

        let _ = self
            .execute_with_retry(|| {
                self.http
                    .patch(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[("supportsAllDrives", "true")])
                    .json(&body)
            })
            .await?;
        Ok(())
    }

    /// Search files: safely escape `'` and `\` in query string.
    pub async fn search(
        &self,
        query: &str,
        mime: Option<&str>,
        after: Option<&str>,
    ) -> Result<Vec<DriveFile>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files", self.base_url);

        // Escape backslash first, then single quote.
        let safe_query = query.replace('\\', "\\\\").replace('\'', "\\'");
        let mut q = format!("name contains '{safe_query}' and trashed = false");

        if let Some(m) = mime {
            let safe_mime = m.replace('\\', "\\\\").replace('\'', "\\'");
            q.push_str(&format!(" and mimeType = '{safe_mime}'"));
        }
        if let Some(a) = after {
            let safe_after = a.replace('\\', "\\\\").replace('\'', "\\'");
            q.push_str(&format!(" and modifiedTime > '{safe_after}'"));
        }

        let resp = self
            .execute_with_retry(|| {
                self.http
                    .get(&url)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .query(&[
                        ("q", q.as_str()),
                        (
                            "fields",
                            "files(id,name,mimeType,md5Checksum,modifiedTime,size,description,starred)",
                        ),
                        ("pageSize", "100"),
                        ("supportsAllDrives", "true"),
                        ("includeItemsFromAllDrives", "true"),
                    ])
            })
            .await?;

        let list: FileList = resp
            .json()
            .await
            .map_err(|e| AppError::Drive(format!("parse search results: {e}")))?;
        Ok(list.files)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    use crate::config::Config;
    use crate::db::{Db, Job};
    use crate::governor::{Governor, GovernorCfg};
    use crate::queue::JobRunner;
    use crate::transfer::{Limiter, UploadRunner};

    #[test]
    fn query_escaping_logic() {
        let input = "O'Reilly \\ docs 'test'";
        let escaped = input.replace('\\', "\\\\").replace('\'', "\\'");
        assert_eq!(escaped, "O\\'Reilly \\\\ docs \\'test\\'");
    }

    #[tokio::test]
    async fn wiremock_share_link() {
        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/files/file_abc/permissions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/files/file_abc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "webViewLink": "https://drive.google.com/file/abc"
            })))
            .mount(&server)
            .await;

        let client = DriveClient::new().unwrap().with_base_url(server.uri());
        let link = client.share_link("file_abc", "reader", true).await.unwrap();
        assert_eq!(link, "https://drive.google.com/file/abc");
    }

    #[tokio::test]
    async fn wiremock_storage_quota() {
        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/about"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "storageQuota": {
                    "limit": "1000000",
                    "usage": "500000",
                    "usageInDrive": "400000",
                    "usageInDriveTrash": "100000"
                }
            })))
            .mount(&server)
            .await;

        // Clear cache
        if let Ok(mut g) = QUOTA_CACHE.lock() {
            *g = None;
        }

        let client = DriveClient::new().unwrap().with_base_url(server.uri());
        let quota = client.get_storage_quota().await.unwrap();
        assert_eq!(quota.limit, Some(1000000));
        assert_eq!(quota.usage, 500000);
        assert_eq!(quota.usage_in_drive, 400000);
        assert_eq!(quota.usage_in_drive_trash, 100000);
    }

    #[tokio::test]
    async fn wiremock_shared_drives() {
        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drives"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "drives": [
                    { "id": "drive_1", "name": "Engineering Team" },
                    { "id": "drive_2", "name": "Design Team" }
                ]
            })))
            .mount(&server)
            .await;

        let client = DriveClient::new().unwrap().with_base_url(server.uri());
        let drives = client.list_shared_drives().await.unwrap();
        assert_eq!(drives.len(), 2);
        assert_eq!(drives[0].name, "Engineering Team");
        assert_eq!(drives[1].name, "Design Team");
    }

    #[tokio::test]
    async fn wiremock_set_metadata() {
        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;

        Mock::given(method("PATCH"))
            .and(path("/files/file_meta"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let client = DriveClient::new().unwrap().with_base_url(server.uri());
        assert!(client.set_description("file_meta", "Updated notes").await.is_ok());
        assert!(client.set_starred("file_meta", true).await.is_ok());
    }

    #[tokio::test]
    async fn wiremock_search() {
        crate::auth::set_token_for_test("test_tok").await;
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    { "id": "f_result", "name": "report.pdf", "mimeType": "application/pdf" }
                ]
            })))
            .mount(&server)
            .await;

        let client = DriveClient::new().unwrap().with_base_url(server.uri());
        let results = client.search("report", Some("application/pdf"), None).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name.as_deref(), Some("report.pdf"));
    }

    #[tokio::test]
    async fn dry_run_produces_zero_writes() {
        let dir = TempDir::new().unwrap();
        let db = std::sync::Arc::new(Db::open(&dir.path().join("dry.db")).unwrap());
        let mut cfg = Config::default();
        cfg.app.dry_run = true;

        let gov = Governor::new(GovernorCfg::default());
        let limiter = std::sync::Arc::new(Limiter::new(0));
        let drive = DriveClient::new().unwrap();

        let runner = UploadRunner {
            db: std::sync::Arc::clone(&db),
            cfg,
            gov,
            drive,
            limiter,
        };

        let job = Job {
            id: 1,
            pair_id: "p1".into(),
            kind: "upload".into(),
            rel_path: "secret.txt".into(),
            priority: 0,
            attempts: 0,
            next_try_ms: 0,
            status: "queued".into(),
            last_error: None,
            created_ms: 0,
        };

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res = runner.run(job, tx).await;
        assert!(res.is_ok(), "dry-run must return Ok");

        let activity = db.recent_activity(10).unwrap();
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].result, "dry-run");
        assert_eq!(activity[0].rel_path, "secret.txt");
    }
}

