//! Stateful in-process Google Drive API mock server with integrated fault injection.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

use super::fault_injector::{FaultAction, FaultInjector};

static ID_GEN: AtomicU64 = AtomicU64::new(1000);

// ── In-memory Drive Data Structures ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeRevision {
    pub id: String,
    pub modified_time: String,
    pub size: u64,
    pub keep_forever: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeFile {
    pub id: String,
    pub name: String,
    pub parents: Vec<String>,
    pub mime_type: String,
    pub size: u64,
    pub md5_checksum: Option<String>,
    pub modified_time: String,
    pub trashed: bool,
    pub starred: bool,
    pub description: Option<String>,
    #[serde(skip)]
    pub data: Vec<u8>,
    pub revisions: Vec<FakeRevision>,
}

#[derive(Debug, Clone)]
pub struct FakeResumableSession {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub mime_type: String,
    pub modified_time: String,
    pub total_size: u64,
    pub received: Vec<u8>,
    pub existing_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeChange {
    pub file_id: String,
    pub removed: bool,
    pub file: Option<FakeFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeDriveInfo {
    pub id: String,
    pub name: String,
}

pub struct FakeDriveState {
    pub files: HashMap<String, FakeFile>,
    pub sessions: HashMap<String, FakeResumableSession>,
    pub changes: Vec<FakeChange>,
    pub quota_limit: u64,
    pub quota_usage: u64,
    pub shared_drives: Vec<FakeDriveInfo>,
    pub export_size_limit_exceeded: bool,
}

impl Default for FakeDriveState {
    fn default() -> Self {
        FakeDriveState {
            files: HashMap::new(),
            sessions: HashMap::new(),
            changes: Vec::new(),
            quota_limit: 100 * 1024 * 1024 * 1024, // 100 GB
            quota_usage: 10 * 1024 * 1024 * 1024,  // 10 GB
            shared_drives: vec![FakeDriveInfo {
                id: "shared-drive-1".into(),
                name: "Team Drive".into(),
            }],
            export_size_limit_exceeded: false,
        }
    }
}

// ── FakeDrive Server ─────────────────────────────────────────────────────────

pub struct FakeDrive {
    addr: SocketAddr,
    state: Arc<RwLock<FakeDriveState>>,
    faults: FaultInjector,
    id_counter: AtomicU64,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl FakeDrive {
    /// Start the in-process FakeDrive server on an ephemeral port.
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake drive listener");
        let addr = listener.local_addr().expect("local addr");
        let state = Arc::new(RwLock::new(FakeDriveState::default()));
        let faults = FaultInjector::new(42);
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let state_clone = Arc::clone(&state);
        let faults_clone = faults.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accept_res = listener.accept() => {
                        match accept_res {
                            Ok((stream, _)) => {
                                let st = Arc::clone(&state_clone);
                                let fi = faults_clone.clone();
                                tokio::spawn(handle_connection(stream, st, fi, addr));
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        });

        FakeDrive {
            addr,
            state,
            faults,
            id_counter: AtomicU64::new(100),
            shutdown_tx: Some(shutdown_tx),
        }
    }

    /// Return the base HTTP URL of this fake drive server (e.g. "http://127.0.0.1:54321").
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Access the fault injector to configure test errors.
    pub fn fault_injector(&self) -> &FaultInjector {
        &self.faults
    }

    /// Access the underlying in-memory state.
    pub fn state(&self) -> Arc<RwLock<FakeDriveState>> {
        Arc::clone(&self.state)
    }

    /// Insert or update a file directly in memory.
    pub async fn add_file(&self, mut file: FakeFile) {
        if file.md5_checksum.is_none() && !file.data.is_empty() {
            let mut h = Md5::new();
            h.update(&file.data);
            file.md5_checksum = Some(format!("{:x}", h.finalize()));
            file.size = file.data.len() as u64;
        }
        let mut st = self.state.write().await;
        st.files.insert(file.id.clone(), file);
    }

    /// Seed a simple file with content.
    pub async fn seed_file(&self, id: &str, parent_id: &str, name: &str, data: &[u8]) {
        let mut h = Md5::new();
        h.update(data);
        let md5 = format!("{:x}", h.finalize());

        let file = FakeFile {
            id: id.to_string(),
            name: name.to_string(),
            parents: vec![parent_id.to_string()],
            mime_type: "application/octet-stream".into(),
            size: data.len() as u64,
            md5_checksum: Some(md5),
            modified_time: "2026-01-01T00:00:00Z".into(),
            trashed: false,
            starred: false,
            description: None,
            data: data.to_vec(),
            revisions: Vec::new(),
        };
        self.add_file(file).await;
    }

    /// Generate a unique ID for new files.
    pub fn next_id(&self) -> String {
        let n = self.id_counter.fetch_add(1, Ordering::Relaxed);
        format!("fake-drive-id-{}", n)
    }
}

impl Drop for FakeDrive {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

// ── HTTP Connection Handler ──────────────────────────────────────────────────

async fn handle_connection(
    mut stream: TcpStream,
    state: Arc<RwLock<FakeDriveState>>,
    faults: FaultInjector,
    server_addr: SocketAddr,
) {
    let mut buf = Vec::with_capacity(8192);
    let mut temp = [0u8; 4096];

    // Read headers until \r\n\r\n
    let header_end;
    loop {
        match stream.read(&mut temp).await {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&temp[..n]);
                if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
                    header_end = pos + 4;
                    break;
                }
            }
            Err(_) => return,
        }
    }

    let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header_str.lines();
    let request_line = match lines.next() {
        Some(l) => l.to_string(),
        None => return,
    };

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0].to_uppercase();
    let full_path = parts[1].to_string();

    let (path, query) = match full_path.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (full_path, String::new()),
    };

    // Extract headers
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }

    // Read full body if Content-Length specified
    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let body_start = header_end;
    while buf.len() < body_start + content_length {
        match stream.read(&mut temp).await {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&temp[..n]),
            Err(_) => return,
        }
    }

    let body = if buf.len() >= body_start {
        buf[body_start..body_start + content_length].to_vec()
    } else {
        Vec::new()
    };

    // Evaluate Fault Injector
    let fault = faults.evaluate(&method, &path);
    match fault {
        FaultAction::Ok => {}
        FaultAction::Delay(dur) => {
            tokio::time::sleep(dur).await;
        }
        FaultAction::IoErr(_) => {
            // Drop stream immediately to simulate connection reset
            return;
        }
        FaultAction::DropAtByte(n) => {
            // Write partial response then close socket
            let partial = b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n";
            let mut to_send = Vec::new();
            to_send.extend_from_slice(partial);
            to_send.extend(vec![b'A'; n.saturating_sub(partial.len())]);
            let _ = stream.write_all(&to_send[..n.min(to_send.len())]).await;
            let _ = stream.shutdown().await;
            return;
        }
        FaultAction::Http { status, retry_after, body } => {
            let resp_body = body.unwrap_or_else(|| format!("Fault injection status {status}"));
            let mut resp = format!(
                "HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
                resp_body.len()
            );
            if let Some(secs) = retry_after {
                resp.push_str(&format!("Retry-After: {secs}\r\n"));
            }
            resp.push_str("\r\n");
            resp.push_str(&resp_body);
            let _ = stream.write_all(resp.as_bytes()).await;
            return;
        }
        FaultAction::TruncateResponse(len) => {
            let full_resp = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123456789";
            let truncated = &full_resp[..len.min(full_resp.len())];
            let _ = stream.write_all(truncated).await;
            let _ = stream.shutdown().await;
            return;
        }
        FaultAction::CorruptByte { offset, value } => {
            let mut normal_resp = Vec::new();
            process_request(
                &method, &path, &query, &headers, &body, state, server_addr, &mut normal_resp,
            ).await;
            if offset < normal_resp.len() {
                normal_resp[offset] = value;
            }
            let _ = stream.write_all(&normal_resp).await;
            return;
        }
        FaultAction::SlowTrickle { bytes_per_sec } => {
            let mut normal_resp = Vec::new();
            process_request(
                &method, &path, &query, &headers, &body, state, server_addr, &mut normal_resp,
            ).await;
            let chunk_size = (bytes_per_sec / 10).max(1) as usize;
            for chunk in normal_resp.chunks(chunk_size) {
                let _ = stream.write_all(chunk).await;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            return;
        }
        _ => {}
    }

    // Process Normal Request
    let mut response_bytes = Vec::new();
    process_request(
        &method,
        &path,
        &query,
        &headers,
        &body,
        state,
        server_addr,
        &mut response_bytes,
    )
    .await;

    let _ = stream.write_all(&response_bytes).await;
}

// ── Routing & Request Processing ─────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn process_request(
    method: &str,
    path: &str,
    query: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
    state: Arc<RwLock<FakeDriveState>>,
    server_addr: SocketAddr,
    out: &mut Vec<u8>,
) {
    let q_params = parse_query(query);

    // 1. Resumable Upload Session PUT: /upload/session/{session_id}
    if method == "PUT" && path.starts_with("/upload/session/") {
        let session_id = &path["/upload/session/".len()..];
        handle_resumable_chunk(session_id, headers, body, state, out).await;
        return;
    }

    // 2. /files: List or Create
    if path == "/files" {
        match method {
            "GET" => {
                handle_list_files(&q_params, state, out).await;
            }
            "POST" => {
                let upload_type = q_params.get("uploadType").map(|s| s.as_str());
                handle_create_file(None, upload_type, headers, body, state, server_addr, out).await;
            }
            _ => method_not_allowed(out),
        }
        return;
    }

    // 3. /files/{id}/revisions
    if let Some(rest) = path.strip_prefix("/files/") {
        if let Some((file_id, rev_suffix)) = rest.split_once("/revisions") {
            if rev_suffix.is_empty() || rev_suffix == "/" {
                if method == "GET" {
                    handle_list_revisions(file_id, state, out).await;
                    return;
                }
            } else if let Some(rev_id) = rev_suffix.strip_prefix('/') {
                match method {
                    "GET" => {
                        handle_get_revision(file_id, rev_id, &q_params, state, out).await;
                    }
                    "PATCH" => {
                        handle_patch_revision(file_id, rev_id, body, state, out).await;
                    }
                    _ => method_not_allowed(out),
                }
                return;
            }
        }
    }

    // 4. /files/{id}/export
    if let Some(rest) = path.strip_prefix("/files/") {
        if let Some((file_id, "export")) = rest.split_once('/') {
            if method == "GET" {
                handle_export_file(file_id, &q_params, state, out).await;
                return;
            }
        }
    }

    // 5. /files/{id}/permissions
    if let Some(rest) = path.strip_prefix("/files/") {
        if let Some((file_id, "permissions")) = rest.split_once('/') {
            if method == "POST" {
                handle_create_permission(file_id, body, state, out).await;
                return;
            }
        }
    }

    // 6. /files/{id}: Get, Patch, Delete
    if let Some(file_id) = path.strip_prefix("/files/") {
        if !file_id.contains('/') {
            match method {
                "GET" => {
                    handle_get_file(file_id, &q_params, headers, state, out).await;
                }
                "PATCH" => {
                    let upload_type = q_params.get("uploadType").map(|s| s.as_str());
                    handle_create_file(Some(file_id), upload_type, headers, body, state, server_addr, out).await;
                }
                "DELETE" => {
                    handle_delete_file(file_id, state, out).await;
                }
                _ => method_not_allowed(out),
            }
            return;
        }
    }

    // 7. /changes/startPageToken
    if path == "/changes/startPageToken" && method == "GET" {
        let json = serde_json::json!({ "startPageToken": "1" });
        write_json(200, &json, out);
        return;
    }

    // 8. /changes
    if path == "/changes" && method == "GET" {
        let st = state.read().await;
        let json = serde_json::json!({
            "changes": st.changes,
            "newStartPageToken": "2",
        });
        write_json(200, &json, out);
        return;
    }

    // 9. /about
    if path == "/about" && method == "GET" {
        let st = state.read().await;
        let json = serde_json::json!({
            "storageQuota": {
                "limit": st.quota_limit.to_string(),
                "usage": st.quota_usage.to_string(),
                "usageInDrive": st.quota_usage.to_string(),
                "usageInDriveTrash": "0"
            }
        });
        write_json(200, &json, out);
        return;
    }

    // 10. /drives
    if path == "/drives" && method == "GET" {
        let st = state.read().await;
        let json = serde_json::json!({
            "drives": st.shared_drives,
        });
        write_json(200, &json, out);
        return;
    }

    // 404 Not Found
    write_json(
        404,
        &serde_json::json!({ "error": { "code": 404, "message": "Not found" } }),
        out,
    );
}

// ── Handler Functions ────────────────────────────────────────────────────────

async fn handle_list_files(
    q_params: &HashMap<String, String>,
    state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let st = state.read().await;
    let q = q_params.get("q").cloned().unwrap_or_default();

    // Simple filter simulation
    let trashed_filter = if q.contains("trashed=true") {
        Some(true)
    } else if q.contains("trashed=false") {
        Some(false)
    } else {
        None
    };

    let parent_filter = if let Some(start) = q.find("' in parents") {
        let prefix = &q[..start];
        prefix.rfind('\'').map(|quote_start| &prefix[quote_start + 1..])
    } else {
        None
    };

    let name_filter = if let Some(start) = q.find("name='") {
        let rest = &q[start + 6..];
        rest.find('\'').map(|end| &rest[..end])
    } else {
        None
    };

    let mut matches = Vec::new();
    for f in st.files.values() {
        if let Some(t) = trashed_filter {
            if f.trashed != t {
                continue;
            }
        }
        if let Some(parent) = parent_filter {
            if !f.parents.iter().any(|p| p == parent) {
                continue;
            }
        }
        if let Some(name) = name_filter {
            if f.name != name {
                continue;
            }
        }
        matches.push(drive_file_json(f));
    }

    let json = serde_json::json!({ "files": matches });
    write_json(200, &json, out);
}

#[allow(clippy::too_many_arguments)]
async fn handle_create_file(
    existing_id: Option<&str>,
    upload_type: Option<&str>,
    headers: &HashMap<String, String>,
    body: &[u8],
    state: Arc<RwLock<FakeDriveState>>,
    server_addr: SocketAddr,
    out: &mut Vec<u8>,
) {
    match upload_type {
        Some("resumable") => {
            // Initiate resumable session
            let meta: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
            let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or("unnamed").to_string();
            let parent_id = meta.get("parents")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let modified_time = meta.get("modifiedTime").and_then(|v| v.as_str()).unwrap_or("2026-01-01T00:00:00Z").to_string();
            let mime = headers.get("x-upload-content-type").cloned().unwrap_or_else(|| "application/octet-stream".into());
            let total_size: u64 = headers.get("x-upload-content-length").and_then(|v| v.parse().ok()).unwrap_or(0);

            let session_id = format!("sess-{}", ID_GEN.fetch_add(1, Ordering::Relaxed));
            let session = FakeResumableSession {
                id: session_id.clone(),
                parent_id,
                name,
                mime_type: mime,
                modified_time,
                total_size,
                received: Vec::new(),
                existing_id: existing_id.map(|s| s.to_string()),
            };

            {
                let mut st = state.write().await;
                st.sessions.insert(session_id.clone(), session);
            }

            let location = format!("http://{}/upload/session/{}", server_addr, session_id);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
            );
            out.extend_from_slice(resp.as_bytes());
        }
        Some("multipart") => {
            // Multipart upload
            let (meta_json, file_bytes) = parse_multipart_body(body);
            let name = meta_json.get("name").and_then(|v| v.as_str()).unwrap_or("upload.bin").to_string();
            let modified_time = meta_json.get("modifiedTime").and_then(|v| v.as_str()).unwrap_or("2026-01-01T00:00:00Z").to_string();
            let parent_id = meta_json.get("parents")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("root")
                .to_string();

            let mut h = Md5::new();
            h.update(&file_bytes);
            let md5 = format!("{:x}", h.finalize());
            let size = file_bytes.len() as u64;

            let file_id = existing_id
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("file-{}", ID_GEN.fetch_add(1, Ordering::Relaxed)));

            let fake_file = FakeFile {
                id: file_id.clone(),
                name,
                parents: vec![parent_id],
                mime_type: "application/octet-stream".into(),
                size,
                md5_checksum: Some(md5.clone()),
                modified_time: modified_time.clone(),
                trashed: false,
                starred: false,
                description: None,
                data: file_bytes,
                revisions: vec![FakeRevision {
                    id: "1".into(),
                    modified_time: modified_time.clone(),
                    size,
                    keep_forever: false,
                    data: Vec::new(),
                }],
            };

            {
                let mut st = state.write().await;
                st.files.insert(file_id.clone(), fake_file);
            }

            let resp_json = serde_json::json!({
                "id": file_id,
                "md5Checksum": md5,
                "modifiedTime": modified_time,
                "headRevisionId": "1"
            });
            write_json(200, &resp_json, out);
        }
        _ => {
            // Standard JSON metadata (e.g. folder creation or metadata patch)
            let meta: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
            let mut st = state.write().await;

            if let Some(id) = existing_id {
                // PATCH metadata
                if let Some(f) = st.files.get_mut(id) {
                    if let Some(name) = meta.get("name").and_then(|v| v.as_str()) {
                        f.name = name.to_string();
                    }
                    if let Some(trashed) = meta.get("trashed").and_then(|v| v.as_bool()) {
                        f.trashed = trashed;
                    }
                    if let Some(starred) = meta.get("starred").and_then(|v| v.as_bool()) {
                        f.starred = starred;
                    }
                    if let Some(desc) = meta.get("description").and_then(|v| v.as_str()) {
                        f.description = Some(desc.to_string());
                    }
                    let resp = drive_file_json(f);
                    write_json(200, &resp, out);
                } else {
                    write_json(404, &serde_json::json!({ "error": "file not found" }), out);
                }
            } else {
                // POST create folder / file
                let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or("folder").to_string();
                let mime_type = meta.get("mimeType").and_then(|v| v.as_str()).unwrap_or("application/vnd.google-apps.folder").to_string();
                let parent_id = meta.get("parents")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .unwrap_or("root")
                    .to_string();

                let id = format!("file-{}", ID_GEN.fetch_add(1, Ordering::Relaxed));
                let fake_file = FakeFile {
                    id: id.clone(),
                    name,
                    parents: vec![parent_id],
                    mime_type,
                    size: 0,
                    md5_checksum: None,
                    modified_time: "2026-01-01T00:00:00Z".into(),
                    trashed: false,
                    starred: false,
                    description: None,
                    data: Vec::new(),
                    revisions: Vec::new(),
                };
                st.files.insert(id.clone(), fake_file.clone());
                write_json(200, &drive_file_json(&fake_file), out);
            }
        }
    }
}

async fn handle_resumable_chunk(
    session_id: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
    state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let content_range = headers.get("content-range").cloned().unwrap_or_default();
    let mut st = state.write().await;

    let session = match st.sessions.get_mut(session_id) {
        Some(s) => s,
        None => {
            write_json(404, &serde_json::json!({ "error": "session expired" }), out);
            return;
        }
    };

    // Query offset: "bytes */total"
    if content_range.starts_with("bytes */") {
        let received_len = session.received.len();
        if received_len == 0 {
            let resp = "HTTP/1.1 308 Resume Incomplete\r\nContent-Length: 0\r\n\r\n";
            out.extend_from_slice(resp.as_bytes());
        } else {
            let range_hdr = format!("bytes=0-{}", received_len - 1);
            let resp = format!(
                "HTTP/1.1 308 Resume Incomplete\r\nRange: {range_hdr}\r\nContent-Length: 0\r\n\r\n"
            );
            out.extend_from_slice(resp.as_bytes());
        }
        return;
    }

    // Chunk upload: "bytes start-end/total"
    if let Some(range_str) = content_range.strip_prefix("bytes ") {
        if let Some((range_part, total_part)) = range_str.split_once('/') {
            let total_size: u64 = total_part.parse().unwrap_or(session.total_size);
            if let Some((start_s, _end_s)) = range_part.split_once('-') {
                let start_byte: usize = start_s.parse().unwrap_or(0);
                if session.received.len() < start_byte + body.len() {
                    session.received.resize(start_byte + body.len(), 0);
                }
                session.received[start_byte..start_byte + body.len()].copy_from_slice(body);

                if session.received.len() as u64 >= total_size {
                    // Upload Complete!
                    let session = st.sessions.remove(session_id).unwrap();
                    let mut h = Md5::new();
                    h.update(&session.received);
                    let md5 = format!("{:x}", h.finalize());

                    let file_id = session.existing_id.unwrap_or_else(|| format!("file-{}", ID_GEN.fetch_add(1, Ordering::Relaxed)));
                    let parent = session.parent_id.unwrap_or_else(|| "root".into());
                    let fake = FakeFile {
                        id: file_id.clone(),
                        name: session.name.clone(),
                        parents: vec![parent],
                        mime_type: session.mime_type.clone(),
                        size: total_size,
                        md5_checksum: Some(md5.clone()),
                        modified_time: session.modified_time.clone(),
                        trashed: false,
                        starred: false,
                        description: None,
                        data: session.received.clone(),
                        revisions: vec![FakeRevision {
                            id: "1".into(),
                            modified_time: session.modified_time.clone(),
                            size: total_size,
                            keep_forever: false,
                            data: session.received.clone(),
                        }],
                    };
                    st.files.insert(file_id.clone(), fake);

                    let json = serde_json::json!({
                        "id": file_id,
                        "md5Checksum": md5,
                        "modifiedTime": session.modified_time,
                        "headRevisionId": "1"
                    });
                    write_json(200, &json, out);
                    return;
                } else {
                    // 308 Incomplete
                    let next = session.received.len();
                    let range_hdr = format!("bytes=0-{}", next.saturating_sub(1));
                    let resp = format!(
                        "HTTP/1.1 308 Resume Incomplete\r\nRange: {range_hdr}\r\nContent-Length: 0\r\n\r\n"
                    );
                    out.extend_from_slice(resp.as_bytes());
                    return;
                }
            }
        }
    }

    write_json(400, &serde_json::json!({ "error": "invalid Content-Range" }), out);
}

async fn handle_get_file(
    file_id: &str,
    q_params: &HashMap<String, String>,
    headers: &HashMap<String, String>,
    state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let st = state.read().await;
    let file = match st.files.get(file_id) {
        Some(f) => f,
        None => {
            write_json(404, &serde_json::json!({ "error": "file not found" }), out);
            return;
        }
    };

    if q_params.get("alt").map(|s| s.as_str()) == Some("media") {
        // Media download (supports Range requests)
        let total_size = file.data.len();
        if let Some(range_hdr) = headers.get("range") {
            if let Some(range_spec) = range_hdr.strip_prefix("bytes=") {
                if let Some((start_s, end_s)) = range_spec.split_once('-') {
                    let start: usize = start_s.parse().unwrap_or(0);
                    let end: usize = if end_s.is_empty() {
                        total_size.saturating_sub(1)
                    } else {
                        end_s.parse().unwrap_or(total_size.saturating_sub(1))
                    };

                    let end = end.min(total_size.saturating_sub(1));
                    let slice = if start <= end && start < total_size {
                        &file.data[start..=end]
                    } else {
                        &[]
                    };

                    let content_range = format!("bytes {start}-{end}/{total_size}");
                    let resp_hdr = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Range: {content_range}\r\nContent-Length: {}\r\n\r\n",
                        slice.len()
                    );
                    out.extend_from_slice(resp_hdr.as_bytes());
                    out.extend_from_slice(slice);
                    return;
                }
            }
        }

        // Full download
        let resp_hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
            file.data.len()
        );
        out.extend_from_slice(resp_hdr.as_bytes());
        out.extend_from_slice(&file.data);
    } else {
        // Metadata
        write_json(200, &drive_file_json(file), out);
    }
}

async fn handle_delete_file(
    file_id: &str,
    state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let mut st = state.write().await;
    st.files.remove(file_id);
    let resp = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
    out.extend_from_slice(resp.as_bytes());
}

async fn handle_list_revisions(
    file_id: &str,
    state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let st = state.read().await;
    if let Some(f) = st.files.get(file_id) {
        let json = serde_json::json!({ "revisions": f.revisions });
        write_json(200, &json, out);
    } else {
        write_json(404, &serde_json::json!({ "error": "file not found" }), out);
    }
}

async fn handle_get_revision(
    file_id: &str,
    rev_id: &str,
    q_params: &HashMap<String, String>,
    state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let st = state.read().await;
    if let Some(f) = st.files.get(file_id) {
        if let Some(rev) = f.revisions.iter().find(|r| r.id == rev_id) {
            if q_params.get("alt").map(|s| s.as_str()) == Some("media") {
                let data = if !rev.data.is_empty() { &rev.data } else { &f.data };
                let resp_hdr = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
                    data.len()
                );
                out.extend_from_slice(resp_hdr.as_bytes());
                out.extend_from_slice(data);
            } else {
                write_json(200, &serde_json::json!(rev), out);
            }
            return;
        }
    }
    write_json(404, &serde_json::json!({ "error": "revision not found" }), out);
}

async fn handle_patch_revision(
    file_id: &str,
    rev_id: &str,
    body: &[u8],
    state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let meta: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let mut st = state.write().await;
    if let Some(f) = st.files.get_mut(file_id) {
        if let Some(rev) = f.revisions.iter_mut().find(|r| r.id == rev_id) {
            if let Some(keep) = meta.get("keepForever").and_then(|v| v.as_bool()) {
                rev.keep_forever = keep;
            }
            write_json(200, &serde_json::json!(rev), out);
            return;
        }
    }
    write_json(404, &serde_json::json!({ "error": "revision not found" }), out);
}

async fn handle_export_file(
    file_id: &str,
    _q_params: &HashMap<String, String>,
    state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let st = state.read().await;
    if st.export_size_limit_exceeded {
        let resp = serde_json::json!({
            "error": {
                "errors": [{ "reason": "exportSizeLimitExceeded" }],
                "message": "Export size limit exceeded"
            }
        });
        write_json(403, &resp, out);
        return;
    }
    if let Some(f) = st.files.get(file_id) {
        let export_bytes = if f.data.is_empty() {
            b"fake-exported-office-content".to_vec()
        } else {
            f.data.clone()
        };
        let resp_hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
            export_bytes.len()
        );
        out.extend_from_slice(resp_hdr.as_bytes());
        out.extend_from_slice(&export_bytes);
    } else {
        write_json(404, &serde_json::json!({ "error": "file not found" }), out);
    }
}

async fn handle_create_permission(
    _file_id: &str,
    _body: &[u8],
    _state: Arc<RwLock<FakeDriveState>>,
    out: &mut Vec<u8>,
) {
    let json = serde_json::json!({ "id": "anyoneWithLink", "type": "anyone", "role": "reader" });
    write_json(200, &json, out);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Encode file metadata exactly as the Google Drive v3 JSON API does.
///
/// In particular, Drive serializes `size` as a decimal string. Returning the
/// in-memory u64 directly made the fake incompatible with the real client and
/// hid all folder-creation paths from earlier transfer tests.
fn drive_file_json(file: &FakeFile) -> serde_json::Value {
    serde_json::json!({
        "id": file.id,
        "name": file.name,
        "parents": file.parents,
        "mimeType": file.mime_type,
        "size": file.size.to_string(),
        "md5Checksum": file.md5_checksum,
        "modifiedTime": file.modified_time,
        "trashed": file.trashed,
        "starred": file.starred,
        "description": file.description,
    })
}

fn write_json(status: u16, json: &serde_json::Value, out: &mut Vec<u8>) {
    let body = json.to_string();
    let status_text = match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Status",
    };
    let hdr = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    out.extend_from_slice(hdr.as_bytes());
    out.extend_from_slice(body.as_bytes());
}

fn method_not_allowed(out: &mut Vec<u8>) {
    let resp = "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n";
    out.extend_from_slice(resp.as_bytes());
}

fn parse_query(q: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for part in q.split('&') {
        if let Some((k, v)) = part.split_once('=') {
            map.insert(url_decode(k), url_decode(v));
        }
    }
    map
}

fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        match b {
            b'%' => {
                let h1 = bytes.next().unwrap_or(b'0');
                let h2 = bytes.next().unwrap_or(b'0');
                if let Ok(num) = u8::from_str_radix(&format!("{}{}", h1 as char, h2 as char), 16) {
                    out.push(num as char);
                }
            }
            b'+' => out.push(' '),
            _ => out.push(b as char),
        }
    }
    out
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn parse_multipart_body(body: &[u8]) -> (serde_json::Value, Vec<u8>) {
    let mut meta = serde_json::Value::Null;
    let mut file_bytes = Vec::new();

    let sep = b"\r\n\r\n";
    if let Some(first_header) = find_subsequence(body, sep) {
        let rest = &body[first_header + 4..];
        if let Some(second_header) = find_subsequence(rest, sep) {
            let json_slice = &rest[..second_header];
            if let Some(bound_idx) = find_subsequence(json_slice, b"\r\n--") {
                if let Ok(j) = serde_json::from_slice(&json_slice[..bound_idx]) {
                    meta = j;
                }
            } else if let Ok(j) = serde_json::from_slice(json_slice) {
                meta = j;
            }

            let file_slice = &rest[second_header + 4..];
            if let Some(bound_idx) = find_subsequence(file_slice, b"\r\n--") {
                file_bytes = file_slice[..bound_idx].to_vec();
            } else {
                file_bytes = file_slice.to_vec();
            }
        }
    }

    (meta, file_bytes)
}

