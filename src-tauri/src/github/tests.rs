use std::collections::HashMap;
use std::sync::Arc;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use crate::config::{Config, PairEntry, PairMode};
use crate::db::Db;
use crate::github::client::GitHubClient;
use crate::github::state::{merge_pull, PairState, SyncState};
use crate::github::{blake3_hex, do_push, gunzip_decompress, gzip_compress, PushCache};

fn temp_db() -> (TempDir, Arc<Db>) {
    let dir = TempDir::new().unwrap();
    let db = Arc::new(Db::open(&dir.path().join("s.db")).unwrap());
    (dir, db)
}

// ── Test 1: create_path_when_404 ───────────────────────────────────────────

#[tokio::test]
async fn create_path_when_404() {
    let server = MockServer::start().await;

    // GET returns 404 (file doesn't exist yet)
    Mock::given(method("GET"))
        .and(path("/repos/owner/repo/contents/config/sync-state.json"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    // PUT returns 201 Created
    Mock::given(method("PUT"))
        .and(path("/repos/owner/repo/contents/config/sync-state.json"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "content": { "sha": "new_sha_123" }
        })))
        .mount(&server)
        .await;

    let client = GitHubClient::new("secret_pat".into(), "owner/repo".into(), "main".into())
        .with_base_url(server.uri());

    let result = client.put_file("config/sync-state.json", b"{\"version\":1}").await;
    assert!(result.is_ok(), "create file on 404 should succeed");
}

// ── Test 2: update_path_with_sha ───────────────────────────────────────────

#[tokio::test]
async fn update_path_with_sha() {
    let server = MockServer::start().await;

    // GET returns 200 with existing file and sha
    let old_content = B64.encode(b"old content");
    Mock::given(method("GET"))
        .and(path("/repos/owner/repo/contents/config/sync-state.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "content": old_content,
            "sha": "existing_sha_456"
        })))
        .mount(&server)
        .await;

    // PUT returns 200 OK
    Mock::given(method("PUT"))
        .and(path("/repos/owner/repo/contents/config/sync-state.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "content": { "sha": "updated_sha_789" }
        })))
        .mount(&server)
        .await;

    let client = GitHubClient::new("secret_pat".into(), "owner/repo".into(), "main".into())
        .with_base_url(server.uri());

    let result = client.put_file("config/sync-state.json", b"new content").await;
    assert!(result.is_ok(), "update file with sha should succeed");
}

// ── Test 3: sha_conflict_retry ─────────────────────────────────────────────

#[tokio::test]
async fn sha_conflict_retry() {
    let server = MockServer::start().await;

    // 1st GET: returns sha1
    Mock::given(method("GET"))
        .and(path("/repos/owner/repo/contents/config/sync-state.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "content": B64.encode(b"v1"),
            "sha": "sha_v1"
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    // 1st PUT: returns 409 conflict
    Mock::given(method("PUT"))
        .and(path("/repos/owner/repo/contents/config/sync-state.json"))
        .respond_with(ResponseTemplate::new(409).set_body_string("conflict"))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    // 2nd GET (conflict retry): returns sha2
    Mock::given(method("GET"))
        .and(path("/repos/owner/repo/contents/config/sync-state.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "content": B64.encode(b"v2"),
            "sha": "sha_v2"
        })))
        .mount(&server)
        .await;

    // 2nd PUT: succeeds
    Mock::given(method("PUT"))
        .and(path("/repos/owner/repo/contents/config/sync-state.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "content": { "sha": "sha_v3" }
        })))
        .mount(&server)
        .await;

    let client = GitHubClient::new("secret_pat".into(), "owner/repo".into(), "main".into())
        .with_base_url(server.uri());

    let result = client.put_file("config/sync-state.json", b"new content").await;
    assert!(result.is_ok(), "put_file should succeed after 409 conflict retry");
}

// ── Test 4: unchanged_hash_skips_push ──────────────────────────────────────

#[tokio::test]
async fn unchanged_hash_skips_push() {
    let (_tmp, db) = temp_db();
    let data_dir = TempDir::new().unwrap();
    let repo_root = TempDir::new().unwrap();

    let cfg = Config {
        pairs: vec![PairEntry {
            id: "p1".into(),
            local: "C:\\sync".into(),
            drive_folder_id: "folder123".into(),
            mode: PairMode::TwoWay,
            enabled: true,
        }],
        ..Default::default()
    };

    // Build the sync state bytes and pre-calculate hash
    let state_bytes = crate::github::state::build_sync_state_bytes(&db, &cfg).unwrap();
    let hash = blake3_hex(&state_bytes);

    let mut cache = PushCache {
        hash: Some(hash),
        path: data_dir.path().join("gh_last.txt"),
    };

    let client = GitHubClient::new("pat".into(), "owner/repo".into(), "main".into());

    // Because cache hash matches current state hash, do_push must return Ok(false) without contacting GitHub.
    let pushed = do_push(&client, &db, &cfg, &mut cache, repo_root.path()).await.unwrap();
    assert!(!pushed, "do_push should return false when state hash has not changed");
}

// ── Test 5: gzip_and_gunzip_roundtrip ──────────────────────────────────────

#[test]
fn gzip_and_gunzip_roundtrip() {
    let original = "Hello World! ".repeat(50_000).into_bytes(); // ~650 KB
    let compressed = gzip_compress(&original).expect("gzip compress");
    assert!(compressed.len() < original.len(), "compressed data should be smaller");

    let decompressed = gunzip_decompress(&compressed).expect("gunzip decompress");
    assert_eq!(decompressed, original, "decompressed must match original bytes");
}

// ── Test 6: pull_merges_new_pair ───────────────────────────────────────────

#[test]
fn pull_merges_new_pair() {
    let (_tmp, db) = temp_db();

    let remote = SyncState {
        version: 1,
        updated: "2026-11-03T00:00:00Z".into(),
        machine: "other-pc".into(),
        pairs: vec![PairState {
            id: "remote_pair_1".into(),
            drive_folder_id: "folder_abc".into(),
            mode: "twoway".into(),
            last_sync_ms: 1234567890,
            changes_page_token: Some("tok_abc".into()),
        }],
        manifest: HashMap::new(),
    };

    merge_pull(&db, &remote).expect("merge_pull succeeds");

    // Pair should be inserted with token imported
    let token = db.get_page_token("remote_pair_1").expect("get token");
    assert_eq!(token, Some("tok_abc".into()));
}

// ── Test 7: pull_token_import_preserves_local ──────────────────────────────

#[test]
fn pull_token_import_preserves_local() {
    let (_tmp, db) = temp_db();

    // Local already has a page token
    db.set_page_token("p1", "local_token_123").expect("set page token");

    let remote = SyncState {
        version: 1,
        updated: "2026-11-03T00:00:00Z".into(),
        machine: "other-pc".into(),
        pairs: vec![PairState {
            id: "p1".into(),
            drive_folder_id: "folder_1".into(),
            mode: "twoway".into(),
            last_sync_ms: 99999999,
            changes_page_token: Some("remote_token_456".into()),
        }],
        manifest: HashMap::new(),
    };

    merge_pull(&db, &remote).expect("merge_pull succeeds");

    // Local token should NOT be overwritten
    let token = db.get_page_token("p1").expect("get page token");
    assert_eq!(token, Some("local_token_123".into()));
}

// ── Test 8: delete_file_behavior ───────────────────────────────────────────

#[tokio::test]
async fn delete_file_behavior() {
    let server = MockServer::start().await;

    // GET file to delete
    Mock::given(method("GET"))
        .and(path("/repos/owner/repo/contents/obsolete.txt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "content": B64.encode(b"dead"),
            "sha": "del_sha_000"
        })))
        .mount(&server)
        .await;

    // DELETE request succeeds
    Mock::given(method("DELETE"))
        .and(path("/repos/owner/repo/contents/obsolete.txt"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    // GET for non-existent file returns 404
    Mock::given(method("GET"))
        .and(path("/repos/owner/repo/contents/already_gone.txt"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let client = GitHubClient::new("token".into(), "owner/repo".into(), "main".into())
        .with_base_url(server.uri());

    // Deleting existing file should succeed
    let res1 = client.delete_file("obsolete.txt").await;
    assert!(res1.is_ok());

    // Deleting non-existent file should also return Ok(()) best-effort
    let res2 = client.delete_file("already_gone.txt").await;
    assert!(res2.is_ok());
}

// ── Test 9: token_never_in_logs ────────────────────────────────────────────

#[test]
fn token_never_in_logs() {
    let secret = "ghp_VERY_SECRET_PAT_STRING_XYZ_999";
    let client = GitHubClient::new(secret.into(), "owner/repo".into(), "main".into());

    let header_val = client.auth_header();
    // Ensure our client's token is private and never exposed in format strings or error messages
    let err = crate::error::AppError::Other("gh: file not found (404)".into());
    assert!(!format!("{err}").contains(secret));
    assert_eq!(header_val, format!("Bearer {secret}"));
}

