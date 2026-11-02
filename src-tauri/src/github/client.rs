//! GitHub Contents API client.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::error::AppError;

const API_BASE: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "twin";

pub struct GitHubClient {
    http:     Client,
    /// Never logged — kept private.
    token:    String,
    repo:     String,
    branch:   String,
    base_url: String,
}

impl GitHubClient {
    pub fn new(token: String, repo: String, branch: String) -> Self {
        Self {
            http: Client::builder()
                .user_agent(USER_AGENT)
                .build()
                .unwrap_or_default(),
            token,
            repo,
            branch,
            base_url: API_BASE.into(),
        }
    }

    pub fn with_base_url(mut self, base_url: String) -> Self {
        self.base_url = base_url;
        self
    }

    pub(crate) fn auth_header(&self) -> String {
        // Note: token is never included in log messages.
        format!("Bearer {}", self.token)
    }

    fn common_headers(&self) -> Vec<(header::HeaderName, String)> {
        vec![
            (header::AUTHORIZATION,  self.auth_header()),
            (header::ACCEPT,         "application/vnd.github+json".into()),
            (header::HeaderName::from_static("x-github-api-version"), GITHUB_API_VERSION.into()),
        ]
    }

    // ── GET file ─────────────────────────────────────────────────────────────

    /// Download raw file content. Returns raw bytes (decoded from base64).
    pub async fn get_file(&self, path: &str) -> Result<Vec<u8>, AppError> {
        let (bytes, _sha) = self.get_file_with_sha(path).await?;
        Ok(bytes)
    }

    /// Download file content + current blob sha (needed for PUT).
    pub async fn get_file_with_sha(&self, path: &str) -> Result<(Vec<u8>, String), AppError> {
        let url = format!("{}/repos/{}/contents/{path}", self.base_url, self.repo);
        let mut req = self.http.get(&url);
        for (k, v) in self.common_headers() {
            req = req.header(k, v);
        }
        req = req.query(&[("ref", self.branch.as_str())]);

        let resp = req.send().await
            .map_err(|e| AppError::Drive(format!("gh get_file send: {e}")))?;

        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(AppError::Other("gh: file not found (404)".into()));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("gh get_file {status}: {body}")));
        }

        let file: ContentFile = resp.json().await
            .map_err(|e| AppError::Other(format!("gh get_file parse: {e}")))?;

        // GitHub returns content with newlines embedded — strip them.
        let clean = file.content.replace('\n', "");
        let bytes = B64.decode(&clean)
            .map_err(|e| AppError::Other(format!("gh get_file base64: {e}")))?;

        debug!("gh: downloaded {} ({} bytes)", path, bytes.len());
        Ok((bytes, file.sha))
    }

    // ── PUT file ─────────────────────────────────────────────────────────────

    /// Create or update a file. Handles 409/422 sha conflicts with one retry.
    pub async fn put_file(&self, path: &str, content: &[u8]) -> Result<(), AppError> {
        // Get current SHA if file exists.
        let current_sha = match self.get_file_with_sha(path).await {
            Ok((_b, sha)) => Some(sha),
            Err(_) => None, // 404 = create
        };
        self.put_file_inner(path, content, current_sha.as_deref()).await
    }

    async fn put_file_inner(
        &self,
        path:    &str,
        content: &[u8],
        sha:     Option<&str>,
    ) -> Result<(), AppError> {
        let machine = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "local".into());
        let now = chrono_now_iso();
        let message = format!("twin state {machine} {now}");

        let body = PutBody {
            message,
            content: B64.encode(content),
            sha:     sha.map(str::to_string),
            branch:  self.branch.clone(),
        };

        let url = format!("{}/repos/{}/contents/{path}", self.base_url, self.repo);
        let mut req = self.http.put(&url);
        for (k, v) in self.common_headers() {
            req = req.header(k, v);
        }

        let resp = req.json(&body).send().await
            .map_err(|e| AppError::Drive(format!("gh put_file send: {e}")))?;

        let status = resp.status();

        // 409 / 422 = sha conflict → re-GET and retry once.
        if status == reqwest::StatusCode::CONFLICT
            || status.as_u16() == 422
        {
            let new_sha = self.get_file_with_sha(path).await.ok().map(|(_, s)| s);
            // Retry with fresh sha.
            let body2 = PutBody {
                sha: new_sha,
                ..body
            };
            let mut req2 = self.http.put(&url);
            for (k, v) in self.common_headers() {
                req2 = req2.header(k, v);
            }
            let resp2 = req2.json(&body2).send().await
                .map_err(|e| AppError::Drive(format!("gh put_file retry send: {e}")))?;
            let status2 = resp2.status();
            if !status2.is_success() {
                let body_text = resp2.text().await.unwrap_or_default();
                return Err(AppError::Other(format!("gh put_file retry {status2}: {body_text}")));
            }
            debug!("gh: put {} (conflict retry ok)", path);
            return Ok(());
        }

        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("gh put_file {status}: {body_text}")));
        }

        debug!("gh: put {} ok", path);
        Ok(())
    }

    // ── DELETE file ───────────────────────────────────────────────────────────

    /// Best-effort delete. Returns Ok(()) even if file doesn't exist.
    pub async fn delete_file(&self, path: &str) -> Result<(), AppError> {
        let sha = match self.get_file_with_sha(path).await {
            Ok((_b, sha)) => sha,
            Err(_) => return Ok(()), // doesn't exist
        };
        let machine = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "local".into());
        let body = DeleteBody {
            message: format!("twin: remove {path} ({machine})"),
            sha,
            branch: self.branch.clone(),
        };
        let url = format!("{}/repos/{}/contents/{path}", self.base_url, self.repo);
        let mut req = self.http.delete(&url);
        for (k, v) in self.common_headers() {
            req = req.header(k, v);
        }
        let resp = req.json(&body).send().await
            .map_err(|e| AppError::Drive(format!("gh delete_file send: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("gh delete_file {status}: {body_text}")));
        }
        Ok(())
    }
}

// ── JSON types ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ContentFile {
    content: String,
    sha:     String,
}

#[derive(Serialize)]
struct PutBody {
    message: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha:     Option<String>,
    branch:  String,
}

#[derive(Serialize)]
struct DeleteBody {
    message: String,
    sha:     String,
    branch:  String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn chrono_now_iso() -> String {
    use chrono::DateTime;
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    DateTime::from_timestamp(secs, 0)
        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

