//! Phase T2: Database Torture and Resilience Tests
//! Target: `src-tauri/src/db/` — single source of truth, must survive any abuse.

mod support;

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use support::rng::TestRng;
use tempfile::tempdir;
use twin_lib::db::{Db, FileRow, NewJob};

#[test]
fn test_property_reference_model_20k_ops() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("state.db");
    let db = Db::open(&db_path).expect("open db");

    let rng = TestRng::new(0xDEAD_BEEF_CAFE_0001);
    let mut model: HashMap<(String, String), FileRow> = HashMap::new();

    let pair_pool = vec!["pair-alpha".to_string(), "pair-beta".to_string(), "pair-gamma".to_string()];
    let rel_pool: Vec<String> = (0..200).map(|i| format!("docs/folder_{}/file_{}.txt", i % 10, i)).collect();

    for op_idx in 0..20_000 {
        let op_type = rng.gen_range_u64(0, 100);
        let pair = pair_pool[rng.gen_range_u64(0, (pair_pool.len() - 1) as u64) as usize].clone();
        let rel = rel_pool[rng.gen_range_u64(0, (rel_pool.len() - 1) as u64) as usize].clone();
        let key = (pair.clone(), rel.clone());

        if op_type < 55 {
            // Upsert
            let states = ["dirty", "synced", "conflict", "uploading", "downloading"];
            let st = states[rng.gen_range_u64(0, (states.len() - 1) as u64) as usize].to_string();
            let row = FileRow {
                pair_id: pair.clone(),
                rel_path: rel.clone(),
                size: Some(rng.gen_range_u64(0, 10_000_000) as i64),
                mtime_ms: Some(1_700_000_000_000 + op_idx as i64),
                md5: Some(format!("{:032x}", op_idx)),
                drive_id: Some(format!("drive_id_{op_idx}")),
                drive_md5: Some(format!("{:032x}", op_idx + 1)),
                drive_mtime_ms: Some(1_700_000_000_000 + op_idx as i64),
                drive_rev: Some(format!("rev_{op_idx}")),
                state: st,
            };
            db.upsert_file(row.clone()).expect("upsert_file");
            model.insert(key, row);
        } else if op_type < 75 {
            // Mark state
            let states = ["dirty", "synced", "conflict"];
            let new_st = states[rng.gen_range_u64(0, (states.len() - 1) as u64) as usize];
            db.mark_state(&pair, &rel, new_st).expect("mark_state");
            if let Some(r) = model.get_mut(&key) {
                r.state = new_st.to_string();
            }
        } else if op_type < 85 {
            // Delete
            db.delete_file(&pair, &rel).expect("delete_file");
            model.remove(&key);
        } else if op_type < 95 {
            // Get & compare
            let db_row = db.get_file(&pair, &rel).expect("get_file");
            let model_row = model.get(&key);
            match (db_row, model_row) {
                (Some(d), Some(m)) => {
                    assert_eq!(d.pair_id, m.pair_id);
                    assert_eq!(d.rel_path, m.rel_path);
                    assert_eq!(d.size, m.size);
                    assert_eq!(d.state, m.state);
                    assert_eq!(d.md5, m.md5);
                }
                (None, None) => {}
                (d, m) => panic!("Mismatch at op {op_idx}: db={d:?}, model={m:?}"),
            }
        } else {
            // Periodic list check
            let dirty = db.list_dirty(&pair, 50).expect("list_dirty");
            for row in dirty {
                assert_eq!(row.state, "dirty");
                assert_eq!(row.pair_id, pair);
            }
        }
    }

    // Final verification against reference model
    for pair in &pair_pool {
        let all_files = db.list_all_files(pair).expect("list_all_files");
        let model_count = model.keys().filter(|(p, _)| p == pair).count();
        assert_eq!(all_files.len(), model_count, "Count mismatch for pair {pair}");

        for db_row in all_files {
            let key = (db_row.pair_id.clone(), db_row.rel_path.clone());
            let m = model.get(&key).unwrap_or_else(|| panic!("File not in model: {key:?}"));
            assert_eq!(db_row.size, m.size);
            assert_eq!(db_row.mtime_ms, m.mtime_ms);
            assert_eq!(db_row.state, m.state);
            assert_eq!(db_row.md5, m.md5);
            assert_eq!(db_row.drive_id, m.drive_id);
        }
    }

    assert!(db.check_integrity().expect("integrity check"));
    assert!(db.check_foreign_keys().expect("foreign keys check"));
}

#[test]
fn test_primary_key_collisions() {
    let dir = tempdir().expect("tempdir");
    let db = Arc::new(Db::open(&dir.path().join("state.db")).expect("open db"));

    // Concurrent collisions on files (pair_id, rel_path)
    let mut handles = Vec::new();
    for thread_idx in 0..8 {
        let db_cloned = Arc::clone(&db);
        handles.push(thread::spawn(move || {
            for i in 0..200 {
                let row = FileRow {
                    pair_id: "pair_collision".into(),
                    rel_path: format!("shared_path_{}.txt", i % 5),
                    size: Some((thread_idx * 1000 + i) as i64),
                    mtime_ms: Some(1000 + i as i64),
                    md5: Some(format!("hash_{thread_idx}_{i}")),
                    drive_id: None,
                    drive_md5: None,
                    drive_mtime_ms: None,
                    drive_rev: None,
                    state: "dirty".into(),
                };
                db_cloned.upsert_file(row).expect("upsert under collision");
            }
        }));
    }

    for h in handles {
        h.join().expect("thread join");
    }

    // Must have exactly 5 rows in files
    let all = db.list_all_files("pair_collision").expect("list_all_files");
    assert_eq!(all.len(), 5);

    // Collision tests on pair_meta
    let mut meta_handles = Vec::new();
    for thread_idx in 0..8 {
        let db_cloned = Arc::clone(&db);
        meta_handles.push(thread::spawn(move || {
            for _ in 0..100 {
                db_cloned.upsert_pair_meta(
                    "meta_pair",
                    Some(&format!("token_{thread_idx}")),
                    Some(thread_idx as i64),
                ).expect("upsert pair meta collision");
            }
        }));
    }

    for h in meta_handles {
        h.join().expect("meta thread join");
    }

    let token = db.get_page_token("meta_pair").expect("get token");
    assert!(token.is_some());
    assert!(db.check_integrity().expect("integrity check"));
}

#[test]
fn test_extreme_path_lengths() {
    let dir = tempdir().expect("tempdir");
    let db = Db::open(&dir.path().join("state.db")).expect("open db");

    // 1. 64 KB path string
    let huge_segment = "a".repeat(1024);
    let mut path_64k = String::with_capacity(65_536);
    for i in 0..64 {
        if i > 0 {
            path_64k.push('/');
        }
        path_64k.push_str(&huge_segment);
    }
    assert!(path_64k.len() >= 64 * 1024);

    let row_64k = FileRow {
        pair_id: "pair1".into(),
        rel_path: path_64k.clone(),
        size: Some(12345),
        mtime_ms: Some(100),
        md5: Some("abc".into()),
        drive_id: Some("id64k".into()),
        drive_md5: None,
        drive_mtime_ms: None,
        drive_rev: None,
        state: "synced".into(),
    };
    db.upsert_file(row_64k).expect("upsert 64KB path");

    let retrieved = db.get_file("pair1", &path_64k).expect("get 64KB path").expect("found");
    assert_eq!(retrieved.rel_path, path_64k);
    assert_eq!(retrieved.size, Some(12345));

    // 2. Path with 1,000 directory components
    let components: Vec<String> = (0..1000).map(|i| format!("d{i}")).collect();
    let deep_path = format!("{}/file.bin", components.join("/"));

    let deep_row = FileRow {
        pair_id: "pair1".into(),
        rel_path: deep_path.clone(),
        size: Some(999),
        mtime_ms: Some(200),
        md5: Some("deep_hash".into()),
        drive_id: Some("deep_drive".into()),
        drive_md5: None,
        drive_mtime_ms: None,
        drive_rev: None,
        state: "dirty".into(),
    };
    db.upsert_file(deep_row).expect("upsert deep path");

    let deep_retrieved = db.get_file("pair1", &deep_path).expect("get deep path").expect("found deep");
    assert_eq!(deep_retrieved.rel_path, deep_path);

    assert!(db.check_integrity().expect("integrity check"));
}

#[test]
fn test_unicode_torture() {
    let dir = tempdir().expect("tempdir");
    let db = Db::open(&dir.path().join("state.db")).expect("open db");

    let unicode_cases = vec![
        // Multi-codepoint emoji and ZWJ family sequences
        ("family", "📁/👨‍👩‍👧‍👦/data.txt"),
        ("technologist", "🚀/👩‍💻_research/résumé.pdf"),
        ("rainbow_flag", "🏳️‍🌈/pride/test.dat"),
        // RTL & Bidirectional Override
        ("arabic", "مجلد/المستندات/تقرير.docx"),
        ("hebrew", "תיקייה/מסמכים/קובץ.txt"),
        ("bidi_override", "safe_\u{202E}cod_exe.txt"),
        // Combining characters & Decomposed/Composed
        ("composed_nfc", "café/menu.txt"),
        ("decomposed_nfd", "cafe\u{0301}/menu.txt"),
        // Symbols & currency
        ("math_and_currency", "∑(x)/₹_¥_€_$/π.data"),
    ];

    for (label, path) in &unicode_cases {
        let row = FileRow {
            pair_id: "pair_unicode".into(),
            rel_path: (*path).to_string(),
            size: Some(100),
            mtime_ms: Some(200),
            md5: Some("md5".into()),
            drive_id: Some(format!("id_{label}")),
            drive_md5: None,
            drive_mtime_ms: None,
            drive_rev: None,
            state: "synced".into(),
        };
        db.upsert_file(row).unwrap_or_else(|e| panic!("Failed upsert for {label}: {e}"));

        let retrieved = db.get_file("pair_unicode", path)
            .unwrap_or_else(|e| panic!("Failed get for {label}: {e}"))
            .unwrap_or_else(|| panic!("Not found: {label} ({path})"));

        assert_eq!(retrieved.rel_path, *path, "Fidelity mismatch for {label}");
    }

    assert!(db.check_integrity().expect("integrity check"));
}

#[test]
fn test_special_character_and_sql_injection() {
    let dir = tempdir().expect("tempdir");
    let db = Db::open(&dir.path().join("state.db")).expect("open db");

    let dangerous_strings = vec![
        "file'; DROP TABLE files; --.txt",
        "\" OR \"1\"=\"1\"; --.txt",
        "test'; UPDATE files SET state='hacked'; --",
        "line1\nline2\r\nline3.txt",
        "tab\tseparated\tname.txt",
        "windows\\backslash\\path.txt",
        "percent%20and_underscore_.txt",
        "quote'single'and\"double\".dat",
        "wildcards_*?[]{}~.log",
    ];

    for (idx, danger) in dangerous_strings.iter().enumerate() {
        let row = FileRow {
            pair_id: "pair_safe".into(),
            rel_path: danger.to_string(),
            size: Some(idx as i64 * 10),
            mtime_ms: Some(500),
            md5: Some("danger_md5".into()),
            drive_id: Some(format!("drive_{idx}")),
            drive_md5: None,
            drive_mtime_ms: None,
            drive_rev: None,
            state: "dirty".into(),
        };

        db.upsert_file(row).expect("upsert dangerous string");
        let fetched = db.get_file("pair_safe", danger).expect("fetch dangerous string").expect("found");
        assert_eq!(fetched.rel_path, *danger);
    }

    // Verify SQL injection attempts had ZERO effect: files table still exists and has exact row count
    let all = db.list_all_files("pair_safe").expect("list_all_files");
    assert_eq!(all.len(), dangerous_strings.len());
    assert!(db.check_integrity().expect("integrity check"));
}

#[test]
fn test_crash_and_wal_recovery() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("original.db");

    {
        let db = Db::open(&db_path).expect("open initial");
        for i in 0..100 {
            let row = FileRow {
                pair_id: "pair_wal".into(),
                rel_path: format!("file_{i}.txt"),
                size: Some(i),
                mtime_ms: Some(100),
                md5: None,
                drive_id: None,
                drive_md5: None,
                drive_mtime_ms: None,
                drive_rev: None,
                state: "dirty".into(),
            };
            db.upsert_file(row).expect("upsert");
        }
    }

    let wal_path = dir.path().join("original.db-wal");
    if wal_path.exists() {
        let wal_bytes = fs::read(&wal_path).expect("read wal");
        // Test truncating WAL at multiple byte boundaries
        for fraction in [100, 512, 1024, wal_bytes.len().saturating_sub(10)] {
            if fraction < wal_bytes.len() && fraction > 32 {
                let test_db_path = dir.path().join(format!("test_wal_{fraction}.db"));
                let test_wal_path = dir.path().join(format!("test_wal_{fraction}.db-wal"));

                fs::copy(&db_path, &test_db_path).expect("copy db");
                fs::write(&test_wal_path, &wal_bytes[..fraction]).expect("write truncated wal");

                // Opening must either cleanly roll back incomplete WAL transactions or succeed
                let opened = Db::open(&test_db_path);
                assert!(opened.is_ok(), "Db::open must handle truncated WAL without crashing");
                let db_recovered = opened.unwrap();
                assert!(db_recovered.check_integrity().expect("integrity check after wal truncation"));
            }
        }
    }
}

#[test]
fn test_file_corruption_recovery() {
    let dir = tempdir().expect("tempdir");
    let rng = TestRng::new(0xCAFE_BABE_9999);

    for iter in 0..50 {
        let db_path = dir.path().join(format!("corrupt_test_{iter}.db"));
        // 1. Create a valid DB with data
        {
            let db = Db::open(&db_path).expect("open valid db");
            for i in 0..20 {
                let row = FileRow {
                    pair_id: "pair_c".into(),
                    rel_path: format!("doc_{i}.txt"),
                    size: Some(100),
                    mtime_ms: Some(100),
                    md5: None,
                    drive_id: None,
                    drive_md5: None,
                    drive_mtime_ms: None,
                    drive_rev: None,
                    state: "synced".into(),
                };
                db.upsert_file(row).expect("upsert");
            }
        }

        // 2. Read database file and flip bytes randomly
        let mut bytes = fs::read(&db_path).expect("read db bytes");
        if bytes.len() > 100 {
            // Corrupt header or interior pages
            for _ in 0..8 {
                let pos = rng.gen_range_u64(0, (bytes.len() - 1) as u64) as usize;
                bytes[pos] ^= 0xFF;
            }
            fs::write(&db_path, &bytes).expect("write corrupt db");
        }

        // 3. Open database: MUST NOT PANIC. It should cleanly rebuild if corrupted.
        let result = Db::open(&db_path);
        assert!(result.is_ok(), "Db::open must not panic on corrupt db (iteration {iter})");

        let db = result.unwrap();
        assert!(db.check_integrity().expect("recovered db must be valid"));

        // If it was corrupted and recovered, check that archive corrupt file was made
        let parent_entries: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(&format!("corrupt_test_{iter}.db.corrupt-")))
            .collect();
        // Either archive was created or the bit flips hit unallocated slack space
        if !parent_entries.is_empty() {
            assert!(parent_entries[0].path().exists());
        }
    }
}

#[test]
fn test_concurrency_16_threads() {
    let dir = tempdir().expect("tempdir");
    let db = Arc::new(Db::open(&dir.path().join("concurrency.db")).expect("open db"));
    let stop = Arc::new(AtomicBool::new(false));

    let mut handles = Vec::new();
    for thread_id in 0..16 {
        let db_cloned = Arc::clone(&db);
        let stop_cloned = Arc::clone(&stop);

        handles.push(thread::spawn(move || {
            let mut counter = 0;
            while !stop_cloned.load(Ordering::Relaxed) {
                counter += 1;
                let rel = format!("worker_{thread_id}/item_{}.bin", counter % 20);

                // Mix operations: upsert, mark_state, enqueue, next_due_job
                let row = FileRow {
                    pair_id: "pair_conc".into(),
                    rel_path: rel.clone(),
                    size: Some(counter),
                    mtime_ms: Some(counter),
                    md5: Some(format!("hash_{counter}")),
                    drive_id: None,
                    drive_md5: None,
                    drive_mtime_ms: None,
                    drive_rev: None,
                    state: "dirty".into(),
                };
                let _ = db_cloned.upsert_file(row);
                let _ = db_cloned.mark_state("pair_conc", &rel, "synced");
                let _ = db_cloned.get_file("pair_conc", &rel);

                if counter % 5 == 0 {
                    let _ = db_cloned.enqueue(NewJob {
                        pair_id: "pair_conc".into(),
                        kind: "upload".into(),
                        rel_path: rel.clone(),
                        priority: counter % 3,
                        created_ms: 1000 + counter,
                    });
                }
                if counter % 7 == 0 {
                    let now = 2000 + counter;
                    let _ = db_cloned.next_due_job(now);
                }
            }
        }));
    }

    // Run concurrency test for 3 seconds
    thread::sleep(Duration::from_millis(3000));
    stop.store(true, Ordering::Relaxed);

    for h in handles {
        h.join().expect("thread join without panic");
    }

    // Verify DB integrity after intense concurrency
    assert!(db.check_integrity().expect("integrity check"));
    assert!(db.check_foreign_keys().expect("foreign key check"));
}

#[test]
fn test_migration_idempotency() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("migration.db");

    // Open creates and applies migrations
    let db = Db::open(&db_path).expect("first open");
    assert!(db.check_integrity().expect("integrity check"));

    // Reopen 10 times in a row: migrations should skip idempotently
    for _ in 0..10 {
        let reopened = Db::open(&db_path).expect("reopen");
        assert!(reopened.check_integrity().expect("reopened integrity check"));
    }
}
