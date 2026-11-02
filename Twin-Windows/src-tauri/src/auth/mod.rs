use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::error::AppError;

// ── Credential Manager keys ────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "twin";
const KEY_CLIENT_ID: &str = "client_id";
const KEY_CLIENT_SECRET: &str = "client_secret";
const KEY_REFRESH_TOKEN: &str = "refresh_token";
const KEY_GITHUB_TOKEN: &str = "github_token";

// ── GitHub PAT helpers ────────────────────────────────────────────────────

/// Read GitHub PAT from Credential Manager. Returns `None` if not stored.
/// The token value is **never** logged.
pub fn github_token() -> Result<Option<String>, AppError> {
    match cred_get(KEY_GITHUB_TOKEN) {
        Ok(t) => Ok(Some(t)),
        Err(_) => Ok(None),
    }
}

/// Tauri command: persist a GitHub PAT in Credential Manager.
#[tauri::command]
pub fn gh_set_token(token: String) -> Result<(), String> {
    cred_set(KEY_GITHUB_TOKEN, &token).map_err(|e| e.to_string())
}

/// Tauri command: remove GitHub PAT from Credential Manager.
#[tauri::command]
pub fn gh_clear_token() -> Result<(), String> {
    cred_delete(KEY_GITHUB_TOKEN);
    Ok(())
}

fn cred_get(key: &str) -> Result<String, AppError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| AppError::Auth(format!("keyring open {key}: {e}")))?;
    entry
        .get_password()
        .map_err(|e| AppError::Auth(format!("keyring read {key}: {e}")))
}

fn cred_set(key: &str, value: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| AppError::Auth(format!("keyring open {key}: {e}")))?;
    entry
        .set_password(value)
        .map_err(|e| AppError::Auth(format!("keyring write {key}: {e}")))
}

fn cred_delete(key: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key) {
        let _ = entry.delete_credential();
    }
}

// ── In-memory token state ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct TokenState {
    access_token: String,
    expires_at: Instant,
}

/// Global in-memory auth state, lazily initialized.
static AUTH_STATE: std::sync::OnceLock<Arc<Mutex<Option<TokenState>>>> =
    std::sync::OnceLock::new();

fn auth_state() -> &'static Arc<Mutex<Option<TokenState>>> {
    AUTH_STATE.get_or_init(|| Arc::new(Mutex::new(None)))
}

// ── OAuth endpoints (overridable in tests) ─────────────────────────────────

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.appdata";

/// Built-in Twin Google OAuth client credentials.
/// Replace placeholder below with your Twin Google Cloud Console credentials.
pub const DEFAULT_CLIENT_ID: &str = "YOUR_TWIN_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
pub const DEFAULT_CLIENT_SECRET: &str = "YOUR_TWIN_GOOGLE_CLIENT_SECRET";

/// Read client_id from env, Credential Manager, or built-in default.
pub fn get_client_id() -> String {
    if let Ok(v) = std::env::var("TWIN_CLIENT_ID") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    match cred_get(KEY_CLIENT_ID) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT_CLIENT_ID.to_string(),
    }
}

/// Read client_secret from env, Credential Manager, or built-in default.
pub fn get_client_secret() -> String {
    if let Ok(v) = std::env::var("TWIN_CLIENT_SECRET") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    match cred_get(KEY_CLIENT_SECRET) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT_CLIENT_SECRET.to_string(),
    }
}

// ── Token exchange / refresh helpers ──────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
}

async fn exchange_code(
    client: &reqwest::Client,
    token_url: &str,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    code: &str,
) -> Result<TokenResponse, AppError> {
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", redirect_uri),
    ];

    let resp = client
        .post(token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("token exchange: {e}")))?;

    handle_token_response(resp).await
}

async fn refresh_access_token_with_url(
    client: &reqwest::Client,
    token_url: &str,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<TokenResponse, AppError> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ];

    let resp = client
        .post(token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("token refresh: {e}")))?;

    handle_token_response(resp).await
}

async fn handle_token_response(resp: reqwest::Response) -> Result<TokenResponse, AppError> {
    let status = resp.status();
    if status == reqwest::StatusCode::BAD_REQUEST {
        // Check for invalid_grant
        let body: serde_json::Value = resp
            .json()
            .await
            .unwrap_or(serde_json::Value::Null);
        if body.get("error").and_then(|v| v.as_str()) == Some("invalid_grant") {
            cred_delete(KEY_REFRESH_TOKEN);
            return Err(AppError::Auth("relogin".into()));
        }
        return Err(AppError::Auth(format!("token error 400: {body}")));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Auth(format!("token error {status}: {body}")));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| AppError::Auth(format!("parse token response: {e}")))
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Open the browser OAuth flow, accept the redirect, exchange code for tokens.
/// Stores refresh_token in Credential Manager; keeps access_token in memory.
pub async fn login(app: &tauri::AppHandle) -> Result<(), AppError> {
    login_with_urls(app, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL).await
}

/// Testable version with injectable URLs.
pub async fn login_with_urls(
    app: &tauri::AppHandle,
    auth_url: &str,
    token_url: &str,
) -> Result<(), AppError> {
    let client_id = get_client_id();
    let client_secret = get_client_secret();

    // Bind to a random port on loopback.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::Auth(format!("bind loopback: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Auth(format!("local_addr: {e}")))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    // Random state to prevent CSRF.
    let state = uuid::Uuid::new_v4().to_string();

    // Build the auth URL.
    let url = format!(
        "{auth_url}?client_id={client_id}&redirect_uri={redirect_uri}&response_type=code\
         &scope={DRIVE_SCOPE}&access_type=offline&prompt=consent&state={state}",
        redirect_uri = urlencoding_simple(&redirect_uri),
        client_id = urlencoding_simple(&client_id),
    );

    // Open in default browser using cmd /c start (Windows only; no extra crate).
    open_browser(&url)?;

    info!("Waiting for OAuth redirect on port {port}");

    // Accept exactly one connection within 120 s.
    let (mut stream, _) =
        tokio::time::timeout(Duration::from_secs(120), listener.accept())
            .await
            .map_err(|_| AppError::Auth("OAuth timeout (120 s)".into()))?
            .map_err(|e| AppError::Auth(format!("accept: {e}")))?;

    let request = read_http_request(&mut stream).await?;

    // Parse query params from GET /?code=...&state=...
    let (code, returned_state) = parse_redirect_params(&request)?;

    // Write "You can close this tab" response.
    write_http_ok(&mut stream).await;

    // Verify state.
    if returned_state != state {
        return Err(AppError::Auth("OAuth state mismatch".into()));
    }

    // Exchange code for tokens.
    let http = build_client()?;
    let token_resp = exchange_code(
        &http,
        token_url,
        &client_id,
        &client_secret,
        &redirect_uri,
        &code,
    )
    .await?;

    // Persist refresh token.
    if let Some(rt) = &token_resp.refresh_token {
        cred_set(KEY_REFRESH_TOKEN, rt)?;
        info!("Refresh token stored in Credential Manager");
    } else {
        warn!("Token exchange returned no refresh_token");
    }

    // Cache access token in memory.
    let expires_at = Instant::now() + Duration::from_secs(token_resp.expires_in);
    *auth_state().lock().await = Some(TokenState {
        access_token: token_resp.access_token,
        expires_at,
    });

    app.emit("auth://changed", true)
        .map_err(|e| AppError::Other(format!("emit: {e}")))?;
    info!("OAuth login complete");
    Ok(())
}

/// Clear tokens from memory and Credential Manager.
pub async fn logout() -> Result<(), AppError> {
    *auth_state().lock().await = None;
    cred_delete(KEY_REFRESH_TOKEN);
    info!("Logged out");
    Ok(())
}

/// Return a valid access token, refreshing if needed (< 60 s left).
/// Mutex-guarded: only one refresh runs concurrently.
pub async fn access_token() -> Result<String, AppError> {
    access_token_with_url(GOOGLE_TOKEN_URL).await
}

pub async fn access_token_with_url(token_url: &str) -> Result<String, AppError> {
    let mut guard = auth_state().lock().await;

    if let Some(state) = &*guard {
        let remaining = state.expires_at.saturating_duration_since(Instant::now());
        if remaining > Duration::from_secs(60) {
            return Ok(state.access_token.clone());
        }
    }

    // Need to refresh.
    let client_id = get_client_id();
    let client_secret = get_client_secret();
    let refresh_token = cred_get(KEY_REFRESH_TOKEN)?;

    let http = build_client()?;
    let token_resp = refresh_access_token_with_url(
        &http,
        token_url,
        &client_id,
        &client_secret,
        &refresh_token,
    )
    .await?;

    let expires_at = Instant::now() + Duration::from_secs(token_resp.expires_in);
    let access = token_resp.access_token.clone();
    *guard = Some(TokenState {
        access_token: token_resp.access_token,
        expires_at,
    });
    Ok(access)
}

/// Returns true if a refresh token exists in Credential Manager.
pub fn is_logged_in() -> bool {
    cred_get(KEY_REFRESH_TOKEN).is_ok()
}

#[doc(hidden)]
pub async fn set_token_for_test(token: &str) {
    let expires_at = Instant::now() + Duration::from_secs(3600);
    *auth_state().lock().await = Some(TokenState {
        access_token: token.to_string(),
        expires_at,
    });
}

// ── Settings helpers (called from Tauri commands) ─────────────────────────

/// Store client_id in Credential Manager.
pub fn set_client_id(value: &str) -> Result<(), AppError> {
    cred_set(KEY_CLIENT_ID, value)
}

/// Store client_secret in Credential Manager.
pub fn set_client_secret(value: &str) -> Result<(), AppError> {
    cred_set(KEY_CLIENT_SECRET, value)
}

/// Clear client_id from Credential Manager.
pub fn clear_client_id() {
    cred_delete(KEY_CLIENT_ID);
}

/// Clear client_secret from Credential Manager.
pub fn clear_client_secret() {
    cred_delete(KEY_CLIENT_SECRET);
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub client_id_set: bool,
    pub client_secret_set: bool,
}

#[tauri::command]
pub async fn auth_login(app: tauri::AppHandle) -> Result<(), AppError> {
    login(&app).await
}

#[tauri::command]
pub async fn auth_logout() -> Result<(), AppError> {
    logout().await
}

#[tauri::command]
pub fn auth_status() -> AuthStatus {
    let cid = get_client_id();
    let is_configured = !cid.is_empty() && cid != "YOUR_TWIN_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
    AuthStatus {
        logged_in: is_logged_in(),
        client_id_set: is_configured || cred_get(KEY_CLIENT_ID).is_ok(),
        client_secret_set: is_configured || cred_get(KEY_CLIENT_SECRET).is_ok(),
    }
}

#[tauri::command]
pub fn auth_set_client_id(value: String) -> Result<(), AppError> {
    set_client_id(&value)
}

#[tauri::command]
pub fn auth_set_client_secret(value: String) -> Result<(), AppError> {
    set_client_secret(&value)
}

#[tauri::command]
pub fn auth_clear_credentials() {
    clear_client_id();
    clear_client_secret();
    cred_delete(KEY_REFRESH_TOKEN);
}

// ── Internal helpers ───────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .build()
        .map_err(|e| AppError::Network(format!("build http client: {e}")))
}

/// Minimal URL encoder: percent-encode characters that break query strings.
fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' | b':' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Open URL in the default Windows browser without an extra crate.
fn open_browser(url: &str) -> Result<(), AppError> {
    // Escape `&` as `^&` for cmd.
    let escaped = url.replace('&', "^&");
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &escaped])
        .spawn()
        .map_err(|e| AppError::Other(format!("open browser: {e}")))?;
    Ok(())
}

/// Read one HTTP request line + headers from a raw TCP stream.
async fn read_http_request(
    stream: &mut tokio::net::TcpStream,
) -> Result<String, AppError> {
    use tokio::io::AsyncReadExt;
    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf))
        .await
        .map_err(|_| AppError::Auth("timeout reading redirect request".into()))?
        .map_err(|e| AppError::Auth(format!("read redirect: {e}")))?;
    String::from_utf8_lossy(&buf[..n])
        .lines()
        .next()
        .map(str::to_owned)
        .ok_or_else(|| AppError::Auth("empty redirect request".into()))
}

/// Extract `code` and `state` from `GET /?code=X&state=Y HTTP/1.1`.
fn parse_redirect_params(request_line: &str) -> Result<(String, String), AppError> {
    // request_line: "GET /?code=X&state=Y HTTP/1.1"
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| AppError::Auth("malformed redirect request".into()))?;

    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    for part in query.split('&') {
        if let Some(v) = part.strip_prefix("code=") {
            code = Some(v.to_owned());
        } else if let Some(v) = part.strip_prefix("state=") {
            state = Some(v.to_owned());
        }
    }
    let code = code.ok_or_else(|| AppError::Auth("no code in redirect".into()))?;
    let state = state.ok_or_else(|| AppError::Auth("no state in redirect".into()))?;
    Ok((code, state))
}

/// Send a minimal HTTP 200 response with a "you can close this tab" body.
async fn write_http_ok(stream: &mut tokio::net::TcpStream) {
    use tokio::io::AsyncWriteExt;
    let body = "<html><body><h2>Twin: authentication successful. You can close this tab.</h2></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn token_ok_body(with_refresh: bool) -> serde_json::Value {
        let mut body = serde_json::json!({
            "access_token": "test_access_token",
            "expires_in": 3600,
            "token_type": "Bearer"
        });
        if with_refresh {
            body["refresh_token"] = serde_json::json!("test_refresh_token");
        }
        body
    }

    #[tokio::test]
    async fn token_exchange_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(token_ok_body(true)))
            .mount(&server)
            .await;

        let client = build_client().unwrap();
        let url = format!("{}/token", server.uri());
        let resp = exchange_code(
            &client, &url, "cid", "csec", "http://127.0.0.1:9999", "mycode",
        )
        .await
        .unwrap();

        assert_eq!(resp.access_token, "test_access_token");
        assert_eq!(resp.refresh_token.as_deref(), Some("test_refresh_token"));
        assert_eq!(resp.expires_in, 3600);
    }

    #[tokio::test]
    async fn token_refresh_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(token_ok_body(false)))
            .mount(&server)
            .await;

        let client = build_client().unwrap();
        let url = format!("{}/token", server.uri());
        let resp =
            refresh_access_token_with_url(&client, &url, "cid", "csec", "rt")
                .await
                .unwrap();

        assert_eq!(resp.access_token, "test_access_token");
    }

    #[tokio::test]
    async fn invalid_grant_clears_token_and_returns_relogin() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error": "invalid_grant"})),
            )
            .mount(&server)
            .await;

        let client = build_client().unwrap();
        let url = format!("{}/token", server.uri());
        let err =
            refresh_access_token_with_url(&client, &url, "cid", "csec", "bad_rt")
                .await
                .unwrap_err();

        assert!(
            matches!(&err, AppError::Auth(msg) if msg == "relogin"),
            "expected relogin, got: {err:?}"
        );
    }

    #[test]
    fn parse_redirect_params_ok() {
        let line = "GET /?code=abc123&state=xyz HTTP/1.1";
        let (code, state) = parse_redirect_params(line).unwrap();
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
    }

    #[test]
    fn parse_redirect_params_missing_code() {
        let line = "GET /?state=xyz HTTP/1.1";
        assert!(parse_redirect_params(line).is_err());
    }

    #[test]
    fn urlencoding_simple_encodes_special_chars() {
        let encoded = urlencoding_simple("http://127.0.0.1:9999/callback");
        assert_eq!(encoded, "http://127.0.0.1:9999/callback");
        let encoded2 = urlencoding_simple("a b&c=d");
        assert!(encoded2.contains("%20"));
        assert!(encoded2.contains("%26"));
    }
}

