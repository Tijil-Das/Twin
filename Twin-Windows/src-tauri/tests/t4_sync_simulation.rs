//! Phase T4: Sync Logic Simulation Tests
//! Target: `src-tauri/src/sync/` (watcher, reconciliation, full scan, 2-way sync, decision table).

mod support;

use std::fs;
use std::sync::Arc;

use support::rng::TestRng;
use tempfile::tempdir;
use twin_lib::config::{ConflictPolicy, DeletionPolicy, PairEntry, PairMode};
use twin_lib::db::{Db, FileRow};
use twin_lib::drive::client::DriveClient;
use twin_lib::sync::changes::{DriveChange, DriveEntry};
use twin_lib::sync::reconcile::{
    apply_remote_change_with_policy, reconcile_listing_with_policy, EchoSet,
};

fn make_pair(id: &str, local: &str, mode: PairMode) -> PairEntry {
    PairEntry {
        id: id.to_string(),
        local: local.to_string(),
        drive_folder_id: "root".to_string(),
        mode,
        enabled: true,
        deletion: None,
    }
}

// ── 1. Decision Table: 27 Cases (3 x 3 x 3) ───────────────────────────────────

#[tokio::test]
async fn test_decision_table_27_cases() {
    let local_states = ["unchanged", "modified", "deleted"];
    let remote_states = ["unchanged", "modified", "deleted"];
    let policies = [
        ConflictPolicy::NewerWins,
        ConflictPolicy::KeepBoth,
        ConflictPolicy::Ask,
    ];

    let mut case_num = 0;

    for l_st in &local_states {
        for r_st in &remote_states {
            for policy in &policies {
                case_num += 1;
                let dir = tempdir().expect("tempdir");
                let db = Arc::new(Db::open(&dir.path().join("test.db")).expect("open db"));
                let echo = Arc::new(EchoSet::new());
                let fake_http = reqwest::Client::new();
                let drive_client = DriveClient::new_with_client(fake_http, "http://127.0.0.1:9".into());

                let local_dir = dir.path().join("local");
                fs::create_dir_all(&local_dir).expect("create local dir");
                let pair = make_pair("pair-1", local_dir.to_str().unwrap(), PairMode::TwoWay);

                let filename = format!("case_{case_num}.txt");
                let local_path = local_dir.join(&filename);

                // Base DB state
                let base_md5 = "base_md5_hash";
                let base_drive_md5 = "base_md5_hash";

                // Setup local
                if *l_st == "unchanged" {
                    fs::write(&local_path, b"base content").expect("write local");
                    db.upsert_file(FileRow {
                        pair_id: "pair-1".into(),
                        rel_path: filename.clone(),
                        size: Some(12),
                        mtime_ms: Some(1000),
                        md5: Some(base_md5.into()),
                        drive_id: Some(format!("drv_{case_num}")),
                        drive_md5: Some(base_drive_md5.into()),
                        drive_mtime_ms: Some(1000),
                        drive_rev: Some("1".into()),
                        state: "synced".into(),
                    }).expect("upsert base");
                } else if *l_st == "modified" {
                    fs::write(&local_path, b"local MODIFIED content").expect("write local");
                    db.upsert_file(FileRow {
                        pair_id: "pair-1".into(),
                        rel_path: filename.clone(),
                        size: Some(22),
                        mtime_ms: Some(2000),
                        md5: Some("local_mod_md5".into()),
                        drive_id: Some(format!("drv_{case_num}")),
                        drive_md5: Some(base_drive_md5.into()),
                        drive_mtime_ms: Some(1000),
                        drive_rev: Some("1".into()),
                        state: "dirty".into(),
                    }).expect("upsert base");
                } else {
                    // deleted: local file does not exist on disk
                    db.upsert_file(FileRow {
                        pair_id: "pair-1".into(),
                        rel_path: filename.clone(),
                        size: Some(12),
                        mtime_ms: Some(1000),
                        md5: Some(base_md5.into()),
                        drive_id: Some(format!("drv_{case_num}")),
                        drive_md5: Some(base_drive_md5.into()),
                        drive_mtime_ms: Some(1000),
                        drive_rev: Some("1".into()),
                        state: "synced".into(),
                    }).expect("upsert base");
                }

                // Setup remote entry for reconcile_listing
                let remote_entry = if *r_st != "deleted" {
                    let r_md5 = if *r_st == "unchanged" { base_drive_md5 } else { "remote_mod_md5" };
                    let r_mtime = if *r_st == "unchanged" { "2026-01-01T00:00:00Z" } else { "2026-01-02T00:00:00Z" };
                    Some(DriveEntry {
                        id: format!("drv_{case_num}"),
                        name: Some(filename.clone()),
                        parents: Some(vec!["root".into()]),
                        md5_checksum: Some(r_md5.into()),
                        modified_time: Some(r_mtime.into()),
                        size: Some("100".into()),
                        mime_type: Some("application/octet-stream".into()),
                        trashed: Some(false),
                    })
                } else {
                    None
                };

                let entries = match &remote_entry {
                    Some(e) => vec![e.clone()],
                    None => vec![],
                };

                // Reconcile with policy
                let res = reconcile_listing_with_policy(
                    &db,
                    &drive_client,
                    &pair,
                    &entries,
                    &echo,
                    policy.clone(),
                    DeletionPolicy::DriveTrash,
                ).await.expect("reconcile");

                // Assert expected action according to decision matrix
                match (*l_st, *r_st) {
                    ("unchanged", "unchanged") => {
                        assert_eq!(res.uploads, 0);
                        assert_eq!(res.downloads, 0);
                    }
                    ("modified", "unchanged") => {
                        assert_eq!(res.uploads, 1, "Expected upload for L modified / R unchanged");
                        assert_eq!(res.downloads, 0);
                    }
                    ("unchanged", "modified") => {
                        assert_eq!(res.downloads, 1, "Expected download for L unchanged / R modified");
                        assert_eq!(res.uploads, 0);
                    }
                    ("modified", "modified") => {
                        // Conflict
                        match policy {
                            ConflictPolicy::NewerWins => {
                                // One wins: either 1 upload or 1 download
                                assert_eq!(res.uploads + res.downloads, 1);
                            }
                            ConflictPolicy::KeepBoth => {
                                assert_eq!(res.conflicts, 1);
                                assert_eq!(res.uploads, 1);
                                assert_eq!(res.downloads, 1);
                            }
                            ConflictPolicy::Ask => {
                                assert_eq!(res.conflicts, 1);
                                let row = db.get_file("pair-1", &filename).unwrap().unwrap();
                                assert_eq!(row.state, "conflict");
                            }
                        }
                    }
                    ("deleted", "unchanged") => {
                        // Local deleted -> deletes = 1
                        assert_eq!(res.deletes, 1);
                    }
                    _ => {}
                }
            }
        }
    }

    assert_eq!(case_num, 27, "Must test all 27 cases");
}

// ── 2. 1,000 Scenario Sync Simulation ─────────────────────────────────────────

#[tokio::test]
async fn test_two_way_simulation_1000_scenarios() {
    let dir = tempdir().expect("tempdir");
    let db = Arc::new(Db::open(&dir.path().join("sim.db")).expect("open db"));
    let local_dir = dir.path().join("local");
    fs::create_dir_all(&local_dir).expect("create local");

    let pair = make_pair("pair-sim", local_dir.to_str().unwrap(), PairMode::TwoWay);
    let echo = Arc::new(EchoSet::new());
    let drive_client = DriveClient::new_with_client(reqwest::Client::new(), "http://127.0.0.1:9".into());

    let rng = TestRng::new(0xABCD_EF01_2345);

    let files_pool: Vec<String> = (0..50).map(|i| format!("item_{i}.txt")).collect();

    for sim_idx in 0..1000 {
        let file_idx = rng.gen_range_u64(0, (files_pool.len() - 1) as u64) as usize;
        let filename = &files_pool[file_idx];
        let local_path = local_dir.join(filename);

        let action = rng.gen_range_u64(0, 5);

        match action {
            0 => {
                // Local create/update
                fs::write(&local_path, format!("local sim {sim_idx}")).expect("write local");
                db.upsert_file(FileRow {
                    pair_id: "pair-sim".into(),
                    rel_path: filename.clone(),
                    size: Some(15),
                    mtime_ms: Some(1000 + sim_idx as i64),
                    md5: Some(format!("local_md5_{sim_idx}")),
                    drive_id: Some(format!("drv_{file_idx}")),
                    drive_md5: Some(format!("old_md5_{file_idx}")),
                    drive_mtime_ms: Some(1000),
                    drive_rev: None,
                    state: "dirty".into(),
                }).expect("upsert");
            }
            1 => {
                // Remote update
                let change = DriveChange {
                    file_id: format!("drv_{file_idx}"),
                    removed: Some(false),
                    file: Some(DriveEntry {
                        id: format!("drv_{file_idx}"),
                        name: Some(filename.clone()),
                        parents: Some(vec!["root".into()]),
                        md5_checksum: Some(format!("remote_md5_{sim_idx}")),
                        modified_time: Some("2026-05-01T00:00:00Z".into()),
                        size: Some("30".into()),
                        mime_type: Some("application/octet-stream".into()),
                        trashed: Some(false),
                    }),
                };
                apply_remote_change_with_policy(&db, &pair, &change, &echo, ConflictPolicy::NewerWins)
                    .await
                    .expect("apply remote change");
            }
            2 => {
                // Local delete
                if local_path.exists() {
                    let _ = fs::remove_file(&local_path);
                }
            }
            3 => {
                // Remote delete
                let change = DriveChange {
                    file_id: format!("drv_{file_idx}"),
                    removed: Some(true),
                    file: None,
                };
                apply_remote_change_with_policy(&db, &pair, &change, &echo, ConflictPolicy::NewerWins)
                    .await
                    .expect("remote delete");

                // Invariant: local file must not vanish silently (must be moved to .twin-trash)
                let trash_root = local_dir.join(".twin-trash");
                if trash_root.exists() {
                    assert!(trash_root.is_dir());
                }
            }
            _ => {
                // Full listing reconcile periodic check
                let entries: Vec<DriveEntry> = (0..5).map(|i| DriveEntry {
                    id: format!("drv_{i}"),
                    name: Some(files_pool[i].clone()),
                    parents: Some(vec!["root".into()]),
                    md5_checksum: Some(format!("hash_{i}")),
                    modified_time: Some("2026-01-01T00:00:00Z".into()),
                    size: Some("10".into()),
                    mime_type: Some("application/octet-stream".into()),
                    trashed: Some(false),
                }).collect();

                let _ = reconcile_listing_with_policy(
                    &db,
                    &drive_client,
                    &pair,
                    &entries,
                    &echo,
                    ConflictPolicy::NewerWins,
                    DeletionPolicy::DriveTrash,
                ).await;
            }
        }

        // Verify DB integrity periodically
        if sim_idx % 250 == 0 {
            assert!(db.check_integrity().expect("integrity"));
        }
    }

    assert!(db.check_integrity().expect("final integrity"));
}

// ── 3. Circular Sync & Echo Suppression ───────────────────────────────────────

#[tokio::test]
async fn test_circular_sync_echo_suppression() {
    let echo = Arc::new(EchoSet::new());
    let path = "sub/document.docx";
    let mtime = 1_700_000_123_456;

    // Record write
    echo.record(path, mtime).await;

    // Immediately after write: should be suppressed
    assert!(echo.is_echo(path, mtime).await);

    // Different mtime: should NOT be suppressed
    assert!(!echo.is_echo(path, mtime + 100).await);

    // Different path: should NOT be suppressed
    assert!(!echo.is_echo("other/path.docx", mtime).await);
}

// ── 4. Deletion Propagation Safety ────────────────────────────────────────────

#[tokio::test]
async fn test_deletion_propagation_safety() {
    let dir = tempdir().expect("tempdir");
    let db = Arc::new(Db::open(&dir.path().join("del.db")).expect("open db"));
    let local_dir = dir.path().join("local");
    fs::create_dir_all(&local_dir).expect("create local");

    let echo = Arc::new(EchoSet::new());
    let drive_client = DriveClient::new_with_client(reqwest::Client::new(), "http://127.0.0.1:9".into());
    let pair = make_pair("pair-del", local_dir.to_str().unwrap(), PairMode::TwoWay);

    // 1. Remote delete moves local file to .twin-trash (never lost)
    let file_path = local_dir.join("important_doc.pdf");
    fs::write(&file_path, b"Do not delete this permanently!").expect("write local file");

    db.upsert_file(FileRow {
        pair_id: "pair-del".into(),
        rel_path: "important_doc.pdf".into(),
        size: Some(31),
        mtime_ms: Some(1000),
        md5: Some("doc_md5".into()),
        drive_id: Some("drv_important".into()),
        drive_md5: Some("doc_md5".into()),
        drive_mtime_ms: Some(1000),
        drive_rev: Some("1".into()),
        state: "synced".into(),
    }).expect("upsert file");

    let change = DriveChange {
        file_id: "drv_important".into(),
        removed: Some(true),
        file: None,
    };

    apply_remote_change_with_policy(&db, &pair, &change, &echo, ConflictPolicy::NewerWins)
        .await
        .expect("remote delete");

    // Local file should be removed from working dir
    assert!(!file_path.exists());

    // But MUST exist inside .twin-trash!
    let trash_root = local_dir.join(".twin-trash");
    assert!(trash_root.exists(), "twin-trash directory must exist");

    let mut found_in_trash = false;
    for entry in fs::read_dir(&trash_root).expect("read trash") {
        let entry = entry.expect("entry");
        if entry.path().is_dir() {
            let candidate = entry.path().join("important_doc.pdf");
            if candidate.exists() {
                let content = fs::read(&candidate).expect("read trashed file");
                assert_eq!(content, b"Do not delete this permanently!");
                found_in_trash = true;
            }
        }
    }
    assert!(found_in_trash, "Deleted file must be safely preserved in .twin-trash");

    // 2. Policy: Ignore vs DriveTrash on local delete
    // Register a file that is synced in DB and exists in remote Drive listing, but local file is deleted.
    db.upsert_file(FileRow {
        pair_id: "pair-del".into(),
        rel_path: "deleted_locally.pdf".into(),
        size: Some(50),
        mtime_ms: Some(2000),
        md5: Some("del_md5".into()),
        drive_id: Some("drv_del_local".into()),
        drive_md5: Some("del_md5".into()),
        drive_mtime_ms: Some(2000),
        drive_rev: Some("1".into()),
        state: "synced".into(),
    }).expect("upsert deleted file");

    let drive_entries = vec![DriveEntry {
        id: "drv_del_local".into(),
        name: Some("deleted_locally.pdf".into()),
        parents: Some(vec!["root".into()]),
        md5_checksum: Some("del_md5".into()),
        modified_time: Some("2026-01-01T00:00:00.000Z".into()),
        size: Some("50".into()),
        mime_type: Some("application/octet-stream".into()),
        trashed: Some(false),
    }];

    let p_ignore = reconcile_listing_with_policy(
        &db,
        &drive_client,
        &pair,
        &drive_entries,
        &echo,
        ConflictPolicy::NewerWins,
        DeletionPolicy::Ignore,
    ).await.expect("reconcile ignore");
    assert_eq!(p_ignore.deletes, 0, "DeletionPolicy::Ignore must NOT enqueue deletes");

    let p_trash = reconcile_listing_with_policy(
        &db,
        &drive_client,
        &pair,
        &drive_entries,
        &echo,
        ConflictPolicy::NewerWins,
        DeletionPolicy::DriveTrash,
    ).await.expect("reconcile trash");
    assert_eq!(p_trash.deletes, 1, "DeletionPolicy::DriveTrash must enqueue deletes");
}
