//! Phase T1: Test harness and fakes self-tests.
//!
//! Validates that FakeDrive, FaultInjector, FakeFs, FakeClock, FakeCpu,
//! and FakePower correctly implement all semantics and every fault actually triggers.

#![allow(clippy::needless_borrows_for_generic_args)]

mod support;

use std::io::ErrorKind;
use std::time::{Duration, Instant};

use reqwest::header;
use support::{
    FakeCpu, FakeDrive, FakeFile, FakePower, FaultAction, FileSystem, InjectedFs, TestRng,
};

// ── 1. FakeDrive CRUD & Queries ──────────────────────────────────────────────

#[tokio::test]
async fn test_fake_drive_crud_and_queries() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    // 1. Seed a file
    drive.seed_file("file-1", "root", "hello.txt", b"Hello World!").await;

    // 2. List files with query
    let list_url = format!("{base}/files?q='root'+in+parents+and+trashed=false");
    let resp: serde_json::Value = client.get(&list_url).send().await.unwrap().json().await.unwrap();
    let files = resp["files"].as_array().expect("files array");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["id"], "file-1");
    assert_eq!(files[0]["name"], "hello.txt");

    // 3. Download full content
    let get_url = format!("{base}/files/file-1?alt=media");
    let content = client.get(&get_url).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(&content[..], b"Hello World!");

    // 4. Download ranged content (bytes=0-4 -> "Hello")
    let ranged_resp = client
        .get(&get_url)
        .header(header::RANGE, "bytes=0-4")
        .send()
        .await
        .unwrap();
    assert_eq!(ranged_resp.status().as_u16(), 206);
    let ranged_bytes = ranged_resp.bytes().await.unwrap();
    assert_eq!(&ranged_bytes[..], b"Hello");

    // 5. Create folder
    let create_url = format!("{base}/files");
    let folder_body = serde_json::json!({
        "name": "Documents",
        "mimeType": "application/vnd.google-apps.folder",
        "parents": ["root"]
    });
    let folder_resp: serde_json::Value = client
        .post(&create_url)
        .json(&folder_body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let folder_id = folder_resp["id"].as_str().expect("id");

    // 6. Multipart upload
    let boundary = "boundary_123";
    let meta_part = format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{{\"name\":\"data.bin\",\"parents\":[\"{folder_id}\"]}}\r\n"
    );
    let data_part = format!(
        "--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n1234567890\r\n--{boundary}--"
    );
    let mut mp_body = Vec::new();
    mp_body.extend_from_slice(meta_part.as_bytes());
    mp_body.extend_from_slice(data_part.as_bytes());

    let mp_resp: serde_json::Value = client
        .post(&format!("{base}/files?uploadType=multipart"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/related; boundary={boundary}"),
        )
        .body(mp_body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let uploaded_id = mp_resp["id"].as_str().expect("id");
    assert!(mp_resp["md5Checksum"].is_string());

    // 7. Verify uploaded file download
    let up_content = client
        .get(&format!("{base}/files/{uploaded_id}?alt=media"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&up_content[..], b"1234567890");

    // 8. Delete file
    let del_resp = client
        .delete(&format!("{base}/files/{uploaded_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del_resp.status().as_u16(), 204);

    let check_del = client
        .get(&format!("{base}/files/{uploaded_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(check_del.status().as_u16(), 404);
}

// ── 2. FakeDrive Resumable Upload (308 semantics) ───────────────────────────

#[tokio::test]
async fn test_fake_drive_resumable_upload_session() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    // 1. Initiate session for 20-byte file
    let init_resp = client
        .post(&format!("{base}/files?uploadType=resumable"))
        .header("X-Upload-Content-Type", "text/plain")
        .header("X-Upload-Content-Length", "20")
        .json(&serde_json::json!({ "name": "resumable.txt", "parents": ["root"] }))
        .send()
        .await
        .unwrap();

    assert_eq!(init_resp.status().as_u16(), 200);
    let session_uri = init_resp
        .headers()
        .get("Location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(session_uri.contains("/upload/session/"));

    // 2. Upload Chunk 1: bytes 0-9 (10 bytes)
    let chunk1 = b"0123456789";
    let chunk1_resp = client
        .put(&session_uri)
        .header("Content-Range", "bytes 0-9/20")
        .body(chunk1.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(chunk1_resp.status().as_u16(), 308);
    let range_hdr = chunk1_resp
        .headers()
        .get("Range")
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(range_hdr, "bytes=0-9");

    // 3. Query offset
    let query_resp = client
        .put(&session_uri)
        .header("Content-Range", "bytes */20")
        .header("Content-Length", "0")
        .send()
        .await
        .unwrap();
    assert_eq!(query_resp.status().as_u16(), 308);
    assert_eq!(
        query_resp.headers().get("Range").unwrap().to_str().unwrap(),
        "bytes=0-9"
    );

    // 4. Upload Chunk 2: bytes 10-19 (10 bytes -> completes the 20 bytes)
    let chunk2 = b"abcdefghij";
    let chunk2_resp = client
        .put(&session_uri)
        .header("Content-Range", "bytes 10-19/20")
        .body(chunk2.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(chunk2_resp.status().as_u16(), 200);
    let meta: serde_json::Value = chunk2_resp.json().await.unwrap();
    let file_id = meta["id"].as_str().expect("file id");

    // 5. Verify finished file
    let final_bytes = client
        .get(&format!("{base}/files/{file_id}?alt=media"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&final_bytes[..], b"0123456789abcdefghij");
}

// ── 3. FakeDrive Revisions, Changes, Quota, Export ──────────────────────────

#[tokio::test]
async fn test_fake_drive_revisions_and_extras() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    let file = FakeFile {
        id: "doc-1".into(),
        name: "test.docx".into(),
        parents: vec!["root".into()],
        mime_type: "application/vnd.google-apps.document".into(),
        size: 15,
        md5_checksum: None,
        modified_time: "2026-01-01T00:00:00Z".into(),
        trashed: false,
        starred: false,
        description: Some("initial desc".into()),
        data: b"revision 2 data".to_vec(),
        revisions: vec![
            support::FakeRevision {
                id: "rev-1".into(),
                modified_time: "2026-01-01T00:00:00Z".into(),
                size: 15,
                keep_forever: false,
                data: b"revision 1 data".to_vec(),
            },
            support::FakeRevision {
                id: "rev-2".into(),
                modified_time: "2026-01-02T00:00:00Z".into(),
                size: 15,
                keep_forever: false,
                data: b"revision 2 data".to_vec(),
            },
        ],
    };
    drive.add_file(file).await;

    // 1. List revisions
    let rev_list: serde_json::Value = client
        .get(&format!("{base}/files/doc-1/revisions"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rev_list["revisions"].as_array().unwrap().len(), 2);

    // 2. Download specific revision
    let rev1_data = client
        .get(&format!("{base}/files/doc-1/revisions/rev-1?alt=media"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&rev1_data[..], b"revision 1 data");

    // 3. Patch keepForever
    let patch_rev: serde_json::Value = client
        .patch(&format!("{base}/files/doc-1/revisions/rev-1"))
        .json(&serde_json::json!({ "keepForever": true }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(patch_rev["keepForever"], true);

    // 4. About quota
    let about: serde_json::Value = client
        .get(&format!("{base}/about"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(about["storageQuota"]["limit"].is_string());

    // 5. Changes startPageToken
    let token_resp: serde_json::Value = client
        .get(&format!("{base}/changes/startPageToken"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(token_resp["startPageToken"], "1");

    // 6. Export document
    let export_bytes = client
        .get(&format!("{base}/files/doc-1/export?mimeType=application/pdf"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&export_bytes[..], b"revision 2 data");
}

// ── 4. Fault Injector: HTTP Statuses (429, 500, 503, 401, 404) ─────────────

#[tokio::test]
async fn test_fault_injector_http_statuses() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    // 1. Inject 429 with Retry-After: 3
    drive.fault_injector().set_route(
        "GET",
        "/files",
        FaultAction::http_with_retry_after(429, 3),
    );

    let resp_429 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(resp_429.status().as_u16(), 429);
    assert_eq!(
        resp_429.headers().get("Retry-After").unwrap().to_str().unwrap(),
        "3"
    );

    // 2. Inject 500 Server Error
    drive.fault_injector().set_route("GET", "/files", FaultAction::http(500));
    let resp_500 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(resp_500.status().as_u16(), 500);

    // 3. Inject 503 Service Unavailable
    drive.fault_injector().set_route("GET", "/files", FaultAction::http(503));
    let resp_503 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(resp_503.status().as_u16(), 503);

    // 4. Inject 401 Unauthorized
    drive.fault_injector().set_route("GET", "/files", FaultAction::http(401));
    let resp_401 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(resp_401.status().as_u16(), 401);

    // 5. Inject 404 Not Found
    drive.fault_injector().set_route("GET", "/files", FaultAction::http(404));
    let resp_404 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(resp_404.status().as_u16(), 404);

    // Clear and verify back to 200
    drive.fault_injector().reset();
    let resp_ok = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(resp_ok.status().as_u16(), 200);
}

// ── 5. Fault Injector: Delay ────────────────────────────────────────────────

#[tokio::test]
async fn test_fault_injector_delay() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    drive.fault_injector().set_global(FaultAction::Delay(Duration::from_millis(80)));

    let t0 = Instant::now();
    let resp = client.get(&format!("{base}/files")).send().await.unwrap();
    let elapsed = t0.elapsed();

    assert_eq!(resp.status().as_u16(), 200);
    assert!(
        elapsed >= Duration::from_millis(70),
        "Expected delay of ~80ms, but took {elapsed:?}"
    );
}

// ── 6. Fault Injector: Drop Connection Mid-Body ─────────────────────────────

#[tokio::test]
async fn test_fault_injector_drop_at_byte() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    // Drop after writing only 10 bytes (headers incomplete or severed body)
    drive.fault_injector().set_global(FaultAction::DropAtByte(10));

    let res = client.get(&format!("{base}/files")).send().await;
    // reqwest should report an error (connection reset or premature EOF)
    assert!(res.is_err(), "Expected connection drop error, but got {:?}", res);
}

// ── 7. Fault Injector: Corrupt Byte ─────────────────────────────────────────

#[tokio::test]
async fn test_fault_injector_corrupt_byte() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    drive.seed_file("cf-1", "root", "c.txt", b"ABCDEFGHIJ").await;

    // Offset 0 is 'H' in "HTTP/1.1 200 OK". Corrupting it makes it invalid HTTP.
    drive.fault_injector().set_global(FaultAction::CorruptByte {
        offset: 0,
        value: b'Z',
    });

    let res = client.get(&format!("{base}/files/cf-1?alt=media")).send().await;
    // Corrupted first byte invalidates HTTP framing -> reqwest error
    assert!(res.is_err(), "Corrupted response should fail parsing: {:?}", res);
}

// ── 8. Fault Injector: Fail the Nth Call ─────────────────────────────────────

#[tokio::test]
async fn test_fault_injector_fail_nth() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    drive.fault_injector().set_route(
        "GET",
        "/files",
        FaultAction::FailNth {
            n: 3,
            fault: Box::new(FaultAction::http(500)),
        },
    );

    // Call 1 -> 200
    let r1 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(r1.status().as_u16(), 200);

    // Call 2 -> 200
    let r2 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(r2.status().as_u16(), 200);

    // Call 3 -> 500 (Nth!)
    let r3 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(r3.status().as_u16(), 500);

    // Call 4 -> 200
    let r4 = client.get(&format!("{base}/files")).send().await.unwrap();
    assert_eq!(r4.status().as_u16(), 200);
}

// ── 9. Fault Injector: Fail with Probability p ──────────────────────────────

#[tokio::test]
async fn test_fault_injector_fail_probability() {
    let drive = FakeDrive::start().await;
    let client = reqwest::Client::new();
    let base = drive.url();

    // 50% probability of 503
    drive.fault_injector().set_route(
        "GET",
        "/files",
        FaultAction::FailProbability {
            p: 0.5,
            fault: Box::new(FaultAction::http(503)),
        },
    );

    let mut count_503 = 0;
    let mut count_200 = 0;

    for _ in 0..100 {
        let resp = client.get(&format!("{base}/files")).send().await.unwrap();
        if resp.status().as_u16() == 503 {
            count_503 += 1;
        } else if resp.status().as_u16() == 200 {
            count_200 += 1;
        }
    }

    assert!(count_503 > 0, "Expected some 503 failures with p=0.5");
    assert!(count_200 > 0, "Expected some 200 successes with p=0.5");
}

// ── 10. FakeFs Injected Faults ──────────────────────────────────────────────

#[test]
fn test_fake_fs_injected_faults() {
    let faults = support::FaultInjector::new(101);
    let fs = InjectedFs::new(faults.clone());

    let temp_dir = tempfile::tempdir().unwrap();
    let file_path = temp_dir.path().join("test.txt");

    // Normal write & read
    fs.write(&file_path, b"filesystem data").unwrap();
    let read_back = fs.read(&file_path).unwrap();
    assert_eq!(read_back, b"filesystem data");

    // Inject PermissionDenied on READ
    faults.set_route("READ", &file_path.to_string_lossy(), FaultAction::IoErr(ErrorKind::PermissionDenied));
    let err = fs.read(&file_path).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::PermissionDenied);

    // Clear fault
    faults.reset();
    assert!(fs.read(&file_path).is_ok());
}

// ── 11. FakeCpu & FakePower ─────────────────────────────────────────────────

#[test]
fn test_fake_cpu_and_fake_power() {
    // FakeCpu samples
    let cpu = FakeCpu::new(vec![15.0, 75.0, 95.0, 100.0], 5.0);
    assert_eq!(cpu.sample(), 15.0);
    assert_eq!(cpu.sample(), 75.0);
    assert_eq!(cpu.sample(), 95.0);
    assert_eq!(cpu.sample(), 100.0);
    // Exhausted samples returns default
    assert_eq!(cpu.sample(), 5.0);

    // FakePower
    let power = FakePower::new(false, 100);
    assert!(!power.is_on_battery());
    assert_eq!(power.battery_level(), 100);

    power.set_on_battery(true);
    power.set_battery_level(42);
    assert!(power.is_on_battery());
    assert_eq!(power.battery_level(), 42);
}

// ── 12. Seeded PRNG Reproducibility ─────────────────────────────────────────

#[test]
fn test_rng_seed_reproducibility() {
    let rng1 = TestRng::new(123456789);
    let rng2 = TestRng::new(123456789);

    let seq1: Vec<u64> = (0..50).map(|_| rng1.next_u64()).collect();
    let seq2: Vec<u64> = (0..50).map(|_| rng2.next_u64()).collect();

    assert_eq!(seq1, seq2, "Identical seeds must produce identical random sequences");
}

