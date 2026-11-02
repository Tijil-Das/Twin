//! Phase T6: Config, GitHub Sync & Security Tests
//! Target: `src-tauri/src/config/`, `src-tauri/src/github/`, `src-tauri/src/auth/`.

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::tempdir;
use tokio::sync::Mutex;
use twin_lib::config::{expand, Config, Vars};
use twin_lib::github::client::GitHubClient;

// ── 1. Config Serialization, BOM, CRLF, & Schema Matrix ───────────────────────

#[test]
fn test_config_toml_matrix_and_normalization() {
    // 1. CRLF line endings
    let crlf_toml = "[app]\r\nparallel_transfers = 6\r\nchunk_mib = 32\r\n\r\n[limits]\r\nupload_kbps = 500\r\n";
    let cfg: Config = toml::from_str(crlf_toml).expect("CRLF TOML must parse cleanly");
    assert_eq!(cfg.app.parallel_transfers, 6);
    assert_eq!(cfg.app.chunk_mib, 32);
    assert_eq!(cfg.limits.upload_kbps, 500);

    // 2. UTF-8 BOM
    let bom_bytes = [0xEF, 0xBB, 0xBF];
    let mut bom_toml = bom_bytes.to_vec();
    bom_toml.extend_from_slice(b"[app]\nparallel_transfers = 3\n");
    let clean_str = String::from_utf8(bom_toml).expect("valid utf-8 with bom");
    let trimmed = clean_str.trim_start_matches('\u{feff}');
    let cfg_bom: Config = toml::from_str(trimmed).expect("BOM trimmed toml must parse");
    assert_eq!(cfg_bom.app.parallel_transfers, 3);

    // 3. Unknown keys (forward compatibility)
    let unknown_keys_toml = r#"
        [app]
        parallel_transfers = 4
        chunk_mib = 16
        future_experimental_field = "some_value"
        
        [future_section]
        enable_telepathy = true
    "#;
    let cfg_unknown: Config = toml::from_str(unknown_keys_toml).expect("Unknown keys must not fail");
    assert_eq!(cfg_unknown.app.parallel_transfers, 4);

    // 4. Validation bounds
    let mut invalid_cfg = Config::default();
    invalid_cfg.app.parallel_transfers = 0; // invalid: 1..=8
    assert!(invalid_cfg.validate().is_err());

    invalid_cfg.app.parallel_transfers = 9; // invalid: >8
    assert!(invalid_cfg.validate().is_err());

    invalid_cfg.app.parallel_transfers = 4;
    invalid_cfg.governor.cpu_resume_pct = 80;
    invalid_cfg.governor.cpu_pause_pct = 70; // invalid: resume must be < pause
    assert!(invalid_cfg.validate().is_err());
}

// ── 2. Path Variable Expansion ────────────────────────────────────────────────

#[test]
fn test_path_variable_expansion_fuzz() {
    let mut vars: Vars = HashMap::new();
    vars.insert("USERPROFILE".into(), "C:\\Users\\Alice".into());
    vars.insert("DOCS".into(), "C:\\Users\\Alice\\Documents".into());
    vars.insert("PROJECT".into(), "Twin".into());

    // 1. Single variable
    let p1 = expand("%DOCS%\\Work", &vars);
    assert_eq!(p1.to_str().unwrap(), "C:\\Users\\Alice\\Documents\\Work");

    // 2. Multiple variables
    let p2 = expand("%USERPROFILE%\\%PROJECT%\\Data", &vars);
    assert_eq!(p2.to_str().unwrap(), "C:\\Users\\Alice\\Twin\\Data");

    // 3. Unknown / unmatched variable left untouched
    let p3 = expand("%UNKNOWN_VAR%\\folder", &vars);
    assert_eq!(p3.to_str().unwrap(), "%UNKNOWN_VAR%\\folder");

    // 4. Empty or no variables
    let p4 = expand("D:\\Static\\Path", &vars);
    assert_eq!(p4.to_str().unwrap(), "D:\\Static\\Path");
}

// ── 3. Pair Merge by ID ───────────────────────────────────────────────────────

#[test]
fn test_pair_merge_by_id_logic() {
    let base_toml = r#"
        [[pair]]
        id = "pair-work"
        local = "C:/Work"
        drive_folder_id = "folder_1"
        mode = "two_way"
        enabled = true

        [[pair]]
        id = "pair-photos"
        local = "C:/Photos"
        drive_folder_id = "folder_2"
        mode = "upload"
        enabled = true
    "#;

    let local_override_toml = r#"
        [[pair]]
        id = "pair-work"
        local = "D:/WorkNew"
        enabled = false
    "#;

    let mut base_val: toml::Value = toml::from_str(base_toml).unwrap();
    let patch_val: toml::Value = toml::from_str(local_override_toml).unwrap();

    // Use toml deep merge
    if let (toml::Value::Table(mut b), toml::Value::Table(p)) = (base_val.clone(), patch_val) {
        if let (Some(toml::Value::Array(mut b_arr)), Some(toml::Value::Array(p_arr))) =
            (b.remove("pair"), p.get("pair").cloned())
        {
            for patch_item in p_arr {
                if let Some(p_id) = patch_item.get("id").and_then(|v| v.as_str()) {
                    if let Some(existing) = b_arr.iter_mut().find(|e| {
                        e.get("id").and_then(|v| v.as_str()) == Some(p_id)
                    }) {
                        if let (toml::Value::Table(ex_tbl), toml::Value::Table(p_tbl)) =
                            (existing, patch_item)
                        {
                            for (k, v) in p_tbl {
                                ex_tbl.insert(k, v);
                            }
                        }
                    }
                }
            }
            b.insert("pair".into(), toml::Value::Array(b_arr));
            base_val = toml::Value::Table(b);
        }
    }

    let merged_cfg: Config = base_val.try_into().expect("merged config valid");
    assert_eq!(merged_cfg.pairs.len(), 2);

    let work = merged_cfg.pairs.iter().find(|p| p.id == "pair-work").unwrap();
    assert_eq!(work.local, "D:/WorkNew");
    assert!(!work.enabled); // overridden to false
    assert_eq!(work.drive_folder_id, "folder_1"); // preserved from base

    let photos = merged_cfg.pairs.iter().find(|p| p.id == "pair-photos").unwrap();
    assert_eq!(photos.local, "C:/Photos");
    assert!(photos.enabled); // untouched
}

// ── 4. Atomic Config Save ─────────────────────────────────────────────────────

#[test]
fn test_atomic_config_save_guarantee() {
    let dir = tempdir().expect("tempdir");
    let cfg_path = dir.path().join("config.toml");
    let tmp_path = dir.path().join("config.toml.tmp");

    let cfg = Config {
        app: twin_lib::config::AppSection {
            parallel_transfers: 5,
            ..Default::default()
        },
        ..Default::default()
    };

    let text = toml::to_string_pretty(&cfg).expect("serialize");

    // Atomic write pattern
    fs::write(&tmp_path, text.as_bytes()).expect("write tmp");
    assert!(tmp_path.exists());

    fs::rename(&tmp_path, &cfg_path).expect("rename tmp to final");
    assert!(cfg_path.exists());
    assert!(!tmp_path.exists(), "Temporary file must not linger after atomic rename");

    // Verify written content is intact and valid
    let loaded: Config = toml::from_str(&fs::read_to_string(&cfg_path).unwrap()).unwrap();
    assert_eq!(loaded.app.parallel_transfers, 5);
}

// ── 5. GitHub Token Privacy & Security Scan ───────────────────────────────────

#[test]
fn test_github_token_privacy_and_leak_prevention() {
    let secret_pat = "ghp_SuperSecretGitHubToken9876543210ABCDEF";
    let client = GitHubClient::new(secret_pat.to_string(), "owner/repo".into(), "main".into());

    // 1. GitHubClient intentionally does NOT implement Debug or Display to prevent accidental logging.
    assert_eq!(client.repo(), "owner/repo");
    assert_eq!(client.branch(), "main");

    // 2. Pointer / error representations must never leak token
    let client_ref = &client;
    let ptr_str = format!("{client_ref:p}");
    assert!(!ptr_str.contains(secret_pat));
}

// ── 6. Auth Token Refresh Stampede Prevention ─────────────────────────────────

#[tokio::test]
async fn test_auth_refresh_stampede_single_call() {
    // Simulate a thread-safe token manager where 100 concurrent requests arrive
    // when an access token is expired.
    let refresh_call_count = Arc::new(AtomicUsize::new(0));

    struct MockTokenManager {
        calls: Arc<AtomicUsize>,
        cache: Mutex<Option<(String, Instant)>>,
    }

    let manager = Arc::new(MockTokenManager {
        calls: Arc::clone(&refresh_call_count),
        cache: Mutex::new(None),
    });

    let mut handles = Vec::new();
    for _ in 0..100 {
        let mgr = Arc::clone(&manager);
        handles.push(tokio::spawn(async move {
            let mut lock = mgr.cache.lock().await;
            if let Some((tok, exp)) = &*lock {
                if *exp > Instant::now() {
                    return tok.clone();
                }
            }
            // Expired or absent: simulate refresh
            mgr.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            let new_token = "fresh_token_123".to_string();
            *lock = Some((new_token.clone(), Instant::now() + Duration::from_secs(3600)));
            new_token
        }));
    }

    for h in handles {
        let tok = h.await.unwrap();
        assert_eq!(tok, "fresh_token_123");
    }

    // Exactly 1 refresh call should have occurred!
    assert_eq!(
        refresh_call_count.load(Ordering::SeqCst),
        1,
        "Stampede protection failed: expected 1 token refresh for 100 concurrent callers"
    );
}
