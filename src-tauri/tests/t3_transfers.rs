//! Phase T3: Transfer Engine Matrix and Resilience Tests
//! Target: `src-tauri/src/transfer/` (upload, download, chunks, resumability, limiter, faults)

mod support;

use std::fs;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use support::rng::TestRng;
use support::{FakeDrive, FaultAction};
use tempfile::tempdir;
use tokio::sync::mpsc;
use twin_lib::auth;
use twin_lib::config::{AppSection, Config, PairEntry, PairMode};
use twin_lib::db::{Db, FileRow, Job};
use twin_lib::drive::client::DriveClient;
use twin_lib::governor::Governor;
use twin_lib::queue::{JobRunner, ProgressUpdate};
use twin_lib::transfer::download::DownloadRunner;
use twin_lib::transfer::limiter::Limiter;
use twin_lib::transfer::upload::UploadRunner;

/// Helper to configure a test environment with local dir, fake drive, and db.
async fn setup_transfer_env() -> (tempfile::TempDir, Arc<Db>, Config, FakeDrive, DriveClient) {
    let dir = tempdir().expect("tempdir");
    let local_dir = dir.path().join("local");
    fs::create_dir_all(&local_dir).expect("create local dir");

    let db_path = dir.path().join("state.db");
    let db = Arc::new(Db::open(&db_path).expect("open db"));

    let fake_drive = FakeDrive::start().await;
    let http = Client::builder().build().expect("build reqwest");
    let drive_client = DriveClient::new_with_client(http, fake_drive.url());

    auth::set_token_for_test("test-bearer-token").await;

    let mut cfg = Config {
        app: AppSection {
            parallel_transfers: 4,
            chunk_mib: 8, // 8 MiB chunks for testing
            debounce_secs: 1,
            fallback_rescan_mins: 60,
            github_push_mins: 60,
            start_hidden: false,
            dry_run: false,
        },
        ..Default::default()
    };
    cfg.pairs.push(PairEntry {
        id: "pair-1".into(),
        local: local_dir.to_string_lossy().into(),
        drive_folder_id: "root".into(),
        mode: PairMode::TwoWay,
        enabled: true,
    });

    (dir, db, cfg, fake_drive, drive_client)
}

#[tokio::test]
async fn test_size_tier_matrix() {
    let (_dir, db, cfg, fake_drive, drive_client) = setup_transfer_env().await;
    let local_root = std::path::PathBuf::from(&cfg.pairs[0].local);

    let limiter = Arc::new(Limiter::new(0));
    let gov = Governor::new((&cfg.governor).into());

    let upload_runner = UploadRunner {
        db: Arc::clone(&db),
        cfg: cfg.clone(),
        gov: gov.clone(),
        drive: drive_client.clone(),
        limiter: Arc::clone(&limiter),
    };

    let download_runner = DownloadRunner {
        db: Arc::clone(&db),
        cfg: cfg.clone(),
        gov: gov.clone(),
        drive: drive_client.clone(),
        limiter: Arc::clone(&limiter),
    };

    // Test tiers: 0 B, 1 B, 256 KB, 5 MB, 8 MB, 8 MB + 1 B
    let tiers: Vec<(&str, usize)> = vec![
        ("zero.bin", 0),
        ("one.bin", 1),
        ("256k.bin", 256 * 1024),
        ("5m.bin", 5 * 1024 * 1024),
        ("8m.bin", 8 * 1024 * 1024),
        ("8m_plus_1.bin", 8 * 1024 * 1024 + 1),
    ];

    let rng = TestRng::new(0x1234_5678_0001);

    for (name, size) in tiers {
        let file_path = local_root.join(name);
        let mut data = vec![0u8; size];
        if size > 0 {
            rng.fill_bytes(&mut data);
        }
        fs::write(&file_path, &data).expect("write file");

        let job = Job {
            id: 1,
            pair_id: "pair-1".into(),
            kind: "upload".into(),
            rel_path: name.to_string(),
            priority: 0,
            attempts: 0,
            next_try_ms: 0,
            status: "queued".into(),
            last_error: None,
            created_ms: 1000,
        };

        let (tx, _rx) = mpsc::unbounded_channel::<ProgressUpdate>();
        upload_runner.run(job, tx).await.unwrap_or_else(|e| panic!("Upload failed for {name} ({size} B): {e}"));

        // Verify DB row exists and state is synced
        let row = db.get_file("pair-1", name).expect("get_file").expect("row exists");
        assert_eq!(row.state, "synced");
        assert_eq!(row.size, Some(size as i64));
        let drive_id = row.drive_id.expect("drive_id exists");

        // Verify FakeDrive has the exact file
        let drive_st = fake_drive.state();
        let st = drive_st.read().await;
        let drive_file = st.files.get(&drive_id).expect("file in fake drive");
        assert_eq!(drive_file.data.len(), size);
        assert_eq!(drive_file.data, data);
        drop(st);

        // Download to a new destination to verify roundtrip
        let dl_name = format!("dl_{name}");
        let dl_path = local_root.join(&dl_name);
        let dl_job = Job {
            id: 2,
            pair_id: "pair-1".into(),
            kind: "download".into(),
            rel_path: dl_name.clone(),
            priority: 0,
            attempts: 0,
            next_try_ms: 0,
            status: "queued".into(),
            last_error: None,
            created_ms: 2000,
        };

        // Seed file in db under dl_name pointing to same drive_id
        db.upsert_file(FileRow {
            pair_id: "pair-1".into(),
            rel_path: dl_name.clone(),
            size: Some(size as i64),
            mtime_ms: Some(100),
            md5: row.md5.clone(),
            drive_id: Some(drive_id),
            drive_md5: row.drive_md5.clone(),
            drive_mtime_ms: Some(100),
            drive_rev: Some("1".into()),
            state: "dirty".into(),
        }).expect("upsert dl row");

        let (tx2, _rx2) = mpsc::unbounded_channel::<ProgressUpdate>();
        download_runner.run(dl_job, tx2).await.unwrap_or_else(|e| panic!("Download failed for {name}: {e}"));

        let downloaded_data = fs::read(&dl_path).expect("read downloaded file");
        assert_eq!(downloaded_data.len(), size);
        assert_eq!(downloaded_data, data);
    }
}

#[tokio::test]
async fn test_upload_resumability() {
    let (_dir, db, cfg, fake_drive, drive_client) = setup_transfer_env().await;
    let local_root = std::path::PathBuf::from(&cfg.pairs[0].local);

    let limiter = Arc::new(Limiter::new(0));
    let gov = Governor::new((&cfg.governor).into());

    let upload_runner = UploadRunner {
        db: Arc::clone(&db),
        cfg: cfg.clone(),
        gov: gov.clone(),
        drive: drive_client.clone(),
        limiter: Arc::clone(&limiter),
    };

    // 16 MB file = 2 chunks of 8 MB
    let size = 16 * 1024 * 1024;
    let mut data = vec![0u8; size];
    let rng = TestRng::new(0xDEAD_CAFE);
    rng.fill_bytes(&mut data);

    let name = "resumable.bin";
    fs::write(local_root.join(name), &data).expect("write file");

    // Inject an error starting from the second chunk PUT request
    fake_drive.fault_injector().set_route("PUT", "/upload/session/", FaultAction::FailFromNth {
        n: 2,
        fault: Box::new(FaultAction::Http {
            status: 500,
            retry_after: None,
            body: Some("Transient error on chunk 2".into()),
        }),
    });

    let job = Job {
        id: 10,
        pair_id: "pair-1".into(),
        kind: "upload".into(),
        rel_path: name.into(),
        priority: 0,
        attempts: 0,
        next_try_ms: 0,
        status: "queued".into(),
        last_error: None,
        created_ms: 1000,
    };

    let (tx, _rx) = mpsc::unbounded_channel::<ProgressUpdate>();
    // First run fails after chunk 1 due to fault injection
    let res = upload_runner.run(job.clone(), tx).await;
    assert!(res.is_err(), "First run should fail on injected fault");

    // Verify session URI is stored in database
    let session = db.get_upload_session("pair-1", name).expect("get_upload_session");
    assert!(session.is_some(), "Upload session must be persisted in db for resume");

    // Clear fault injection and resume upload
    fake_drive.fault_injector().reset();
    let (tx2, _rx2) = mpsc::unbounded_channel::<ProgressUpdate>();
    upload_runner.run(job, tx2).await.expect("Resumed upload must succeed");

    // Verify upload session was cleaned up after success
    let session_after = db.get_upload_session("pair-1", name).expect("get_upload_session");
    assert!(session_after.is_none(), "Upload session must be cleared after successful transfer");

    // Verify content on FakeDrive matches byte-for-byte
    let row = db.get_file("pair-1", name).expect("get_file").unwrap();
    let drive_st = fake_drive.state();
    let st = drive_st.read().await;
    let drive_file = st.files.get(&row.drive_id.unwrap()).expect("file in fake drive");
    assert_eq!(drive_file.data.len(), size);
    assert_eq!(drive_file.data, data);
}

#[tokio::test]
async fn test_content_torture() {
    let (_dir, db, cfg, fake_drive, drive_client) = setup_transfer_env().await;
    let local_root = std::path::PathBuf::from(&cfg.pairs[0].local);

    let limiter = Arc::new(Limiter::new(0));
    let gov = Governor::new((&cfg.governor).into());

    let upload_runner = UploadRunner {
        db: Arc::clone(&db),
        cfg: cfg.clone(),
        gov: gov.clone(),
        drive: drive_client.clone(),
        limiter: Arc::clone(&limiter),
    };

    let mut patterns: Vec<(&str, Vec<u8>)> = Vec::new();

    // 1. All zeros
    patterns.push(("zeros.bin", vec![0u8; 100_000]));
    // 2. All 0xFF
    patterns.push(("ones.bin", vec![0xFFu8; 100_000]));
    // 3. Alternating 0xAA, 0x55
    let alt: Vec<u8> = (0..100_000).map(|i| if i % 2 == 0 { 0xAA } else { 0x55 }).collect();
    patterns.push(("alternating.bin", alt));
    // 4. Mixed line endings
    let text = "Line 1\r\nLine 2\nLine 3\rLine 4\r\n\nbare newline in between\r\n";
    patterns.push(("line_endings.txt", text.as_bytes().to_vec()));

    for (name, data) in patterns {
        fs::write(local_root.join(name), &data).expect("write file");
        let job = Job {
            id: 100,
            pair_id: "pair-1".into(),
            kind: "upload".into(),
            rel_path: name.into(),
            priority: 0,
            attempts: 0,
            next_try_ms: 0,
            status: "queued".into(),
            last_error: None,
            created_ms: 1000,
        };

        let (tx, _rx) = mpsc::unbounded_channel::<ProgressUpdate>();
        upload_runner.run(job, tx).await.unwrap_or_else(|e| panic!("Upload failed for {name}: {e}"));

        let row = db.get_file("pair-1", name).expect("get_file").unwrap();
        let drive_st = fake_drive.state();
        let st = drive_st.read().await;
        let drive_file = st.files.get(&row.drive_id.unwrap()).unwrap();
        assert_eq!(drive_file.data, data, "Data corrupted for {name}");
    }
}

#[tokio::test]
async fn test_fault_injection_retries() {
    let (_dir, db, cfg, fake_drive, drive_client) = setup_transfer_env().await;
    let local_root = std::path::PathBuf::from(&cfg.pairs[0].local);

    let limiter = Arc::new(Limiter::new(0));
    let gov = Governor::new((&cfg.governor).into());

    let upload_runner = UploadRunner {
        db: Arc::clone(&db),
        cfg: cfg.clone(),
        gov: gov.clone(),
        drive: drive_client.clone(),
        limiter: Arc::clone(&limiter),
    };

    // Write test file
    let name = "fault_retry.dat";
    let data = b"Resilient upload data under network faults";
    fs::write(local_root.join(name), data).expect("write file");

    // 1. HTTP 429 Rate Limit (transient, with Retry-After 1)
    fake_drive.fault_injector().set_route("POST", "/files", FaultAction::Http {
        status: 429,
        retry_after: Some(1),
        body: Some("Rate limit exceeded".into()),
    });

    let job = Job {
        id: 200,
        pair_id: "pair-1".into(),
        kind: "upload".into(),
        rel_path: name.into(),
        priority: 0,
        attempts: 0,
        next_try_ms: 0,
        status: "queued".into(),
        last_error: None,
        created_ms: 1000,
    };

    // Client retry loop will automatically back off and succeed on subsequent attempts
    // Remove fault rule after 1 failure simulation
    tokio::spawn({
        let fi = fake_drive.fault_injector().clone();
        async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            fi.reset();
        }
    });

    let (tx, _rx) = mpsc::unbounded_channel::<ProgressUpdate>();
    upload_runner.run(job, tx).await.expect("Upload must succeed after 429 retry");

    let row = db.get_file("pair-1", name).expect("get_file").unwrap();
    assert_eq!(row.state, "synced");
}

#[tokio::test]
async fn test_bandwidth_throttle_compliance() {
    // 100 KB/s limit
    let limiter = Arc::new(Limiter::new(100));

    // Acquire 200 KB in 4 chunks of 50 KB
    let start = Instant::now();
    for _ in 0..4 {
        limiter.acquire(50 * 1024).await;
    }

    let elapsed = start.elapsed();
    // 200 KB at 100 KB/s: first burst may be fast, subsequent chunks throttled to ~1.5 - 2.5s
    assert!(
        elapsed >= Duration::from_millis(900),
        "Elapsed time was too fast: {elapsed:?}, limiter did not throttle"
    );
}

#[tokio::test]
async fn test_concurrent_transfers_stress() {
    let (_dir, db, cfg, _fake_drive, drive_client) = setup_transfer_env().await;
    let local_root = std::path::PathBuf::from(&cfg.pairs[0].local);

    let limiter = Arc::new(Limiter::new(0));
    let gov = Governor::new((&cfg.governor).into());

    let upload_runner = Arc::new(UploadRunner {
        db: Arc::clone(&db),
        cfg: cfg.clone(),
        gov: gov.clone(),
        drive: drive_client.clone(),
        limiter: Arc::clone(&limiter),
    });

    // 10 concurrent uploads
    let mut handles = Vec::new();
    for i in 0..10 {
        let runner = Arc::clone(&upload_runner);
        let path = local_root.clone();
        handles.push(tokio::spawn(async move {
            let name = format!("concurrent_up_{i}.bin");
            let data = vec![(i as u8) * 11; 64 * 1024];
            fs::write(path.join(&name), &data).expect("write file");

            let job = Job {
                id: 1000 + i as i64,
                pair_id: "pair-1".into(),
                kind: "upload".into(),
                rel_path: name.clone(),
                priority: 0,
                attempts: 0,
                next_try_ms: 0,
                status: "queued".into(),
                last_error: None,
                created_ms: 1000,
            };

            let (tx, _rx) = mpsc::unbounded_channel::<ProgressUpdate>();
            runner.run(job, tx).await.unwrap_or_else(|e| panic!("Concurrent upload {i} failed: {e}"));
        }));
    }

    for h in handles {
        h.await.expect("join task");
    }

    // Verify all 10 are synced
    for i in 0..10 {
        let name = format!("concurrent_up_{i}.bin");
        let row = db.get_file("pair-1", &name).expect("get_file").expect("exists");
        assert_eq!(row.state, "synced");
    }
}
