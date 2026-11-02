# P03 OAuth + Credential Manager
Read MASTER.md COMMON RULES and SPEC.md. Module: `src-tauri/src/auth/`. Crates: reqwest, keyring, base64, blake3 NOT used here; use `sha2`? NOT allowed, so compute PKCE S256 with `blake3`? NO. Use plain OAuth loopback with `client_secret` (Desktop client) and `state`; skip PKCE.
## Flow (hand-written)
1. User provides Google OAuth Desktop client_id and client_secret in Settings (stored in Credential Manager, service `tether`, keys `client_id`, `client_secret`). Never in files.
2. Start a tokio `TcpListener` on `127.0.0.1:0` (random port), build URL `https://accounts.google.com/o/oauth2/v2/auth` with params: client_id, redirect_uri=`http://127.0.0.1:{port}`, response_type=code, scope=`https://www.googleapis.com/auth/drive`, access_type=offline, prompt=consent, state=random uuid. Open default browser via `tauri-plugin-opener`? NOT allowed; use `cmd /c start "" "<url>"` (escape `&` as `^&`).
3. Accept one HTTP request, verify `state`, extract `code`, reply a small HTML "You can close this tab", close listener. 120 s timeout.
4. POST `https://oauth2.googleapis.com/token` (grant_type=authorization_code) -> access_token, refresh_token, expires_in. Store refresh_token in Credential Manager key `refresh_token`. Keep access_token only in memory.
## API (exact)
```rust
pub async fn login(app:&AppHandle)->Result<(),AppError>;
pub async fn logout()->Result<(),AppError>;
pub async fn access_token()->Result<String,AppError>; // refreshes when <60s left, mutex-guarded so only one refresh runs
pub fn is_logged_in()->bool;
```
On 400 `invalid_grant` clear stored token and return AppError::Auth("relogin").
Commands: `auth_login`, `auth_logout`, `auth_status`. Emit event `auth://changed`.
## Done-test
Wiremock tests for token exchange, refresh, invalid_grant. Manual: login works, restart app stays logged in, token not present in any file (grep the repo).
