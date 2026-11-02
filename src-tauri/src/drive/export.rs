//! P08 – Google Docs/Sheets/Slides export.
//!
//! Exports Google-native files (application/vnd.google-apps.*) to
//! local office formats.  Export limit is 10 MB; on 403
//! `exportSizeLimitExceeded`, logs and skips (returns `Ok(None)`).

use reqwest::header;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::auth;
use crate::drive::client::DriveClient;
use crate::error::AppError;


/// Configured export format for Google-native mime types.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExportFormats {
    /// MIME for Google Docs export (default: docx).
    pub docs: String,
    /// MIME for Google Sheets export (default: xlsx).
    pub sheets: String,
    /// MIME for Google Slides export (default: pptx).
    pub slides: String,
}

impl Default for ExportFormats {
    fn default() -> Self {
        ExportFormats {
            docs:   "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into(),
            sheets: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
            slides: "application/vnd.openxmlformats-officedocument.presentationml.presentation".into(),
        }
    }
}

/// Extension that matches exported MIME to a file extension.
pub fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/csv" => "csv",
        _ => "bin",
    }
}

/// Resolve the export MIME type for a Google-native Drive MIME.
/// Returns `None` for non-Google-native (or shortcut) types.
pub fn export_mime(drive_mime: &str, fmts: &ExportFormats) -> Option<String> {
    match drive_mime {
        "application/vnd.google-apps.document"     => Some(fmts.docs.clone()),
        "application/vnd.google-apps.spreadsheet"  => Some(fmts.sheets.clone()),
        "application/vnd.google-apps.presentation" => Some(fmts.slides.clone()),
        // Other google-apps types get pdf as fallback.
        m if m.starts_with("application/vnd.google-apps.") => {
            Some("application/pdf".into())
        }
        _ => None,
    }
}

impl DriveClient {
    /// Export a Google-native file.
    ///
    /// Returns `Ok(Some(bytes))` on success, `Ok(None)` if the file is too
    /// large (403 exportSizeLimitExceeded), and `Err` on any other failure.
    pub async fn export_file(
        &self,
        file_id: &str,
        export_mime_type: &str,
    ) -> Result<Option<Vec<u8>>, AppError> {
        let token = auth::access_token().await?;
        let url = format!("{}/files/{file_id}/export", self.base_url);

        let resp = self.http
            .get(&url)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .query(&[("mimeType", export_mime_type)])
            .send()
            .await
            .map_err(|e| AppError::Drive(format!("export_file send: {e}")))?;

        let status = resp.status();

        if status.as_u16() == 403 {
            let body = resp.text().await.unwrap_or_default();
            if body.contains("exportSizeLimitExceeded") {
                warn!("export_file: exportSizeLimitExceeded for {file_id}, skipping");
                return Ok(None);
            }
            return Err(AppError::Drive(format!("export_file 403: {body}")));
        }

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Drive(format!("export_file HTTP {status}: {body}")));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Drive(format!("export_file body: {e}")))?;

        info!("export_file: {file_id} → {export_mime_type} ({} bytes)", bytes.len());
        Ok(Some(bytes.to_vec()))
    }
}

