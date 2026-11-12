//! Phase T13: adversarial real-filesystem integration matrix.
//!
//! Unlike unit-only checks, this suite creates actual temporary directory
//! trees, performs byte-for-byte upload/download round trips through the
//! stateful FakeDrive HTTP server, and checks that failure boundaries never
//! escape a pair's selected root. The matrices are generated deterministically
//! so a failing case is repeatable from its case index.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use support::{FakeDrive, TestRng};
use tempfile::TempDir;
use tokio::sync::mpsc;
use twin_lib::auth;
use twin_lib::config::{AppSection, Config, PairEntry, PairMode};
use twin_lib::db::{Db, FileRow, Job};
use twin_lib::drive::client::DriveClient;
use twin_lib::governor::Governor;
use twin_lib::queue::{JobRunner, ProgressUpdate};
use twin_lib::rules::Rules;
use twin_lib::transfer::download::DownloadRunner;
use twin_lib::transfer::limiter::Limiter;
use twin_lib::transfer::upload::UploadRunner;
use twin_lib::transfer::resolve_under_root;
use twin_lib::watcher;

const PAIR_ID: &str = "adversarial-pair";

struct Harness {
    _dir: TempDir,
    root: PathBuf,
    db: Arc<Db>,
    cfg: Config,
    drive: FakeDrive,
    client: DriveClient,
    limiter: Arc<Limiter>,
    governor: Governor,
}

impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp directory");
        let root = dir.path().join("selected-root");
        fs::create_dir_all(&root).expect("create selected root");
        let db = Arc::new(Db::open(&dir.path().join("state.db")).expect("open db"));
        let mut cfg = Config::default();
        cfg.app = AppSection {
            parallel_transfers: 8,
            chunk_mib: 8,
            debounce_secs: 1,
            fallback_rescan_mins: 60,
            github_push_mins: 60,
            start_hidden: true,
            dry_run: false,
            color_drive_folders: false,
        };
        cfg.pairs.push(PairEntry {
            id: PAIR_ID.into(),
            local: root.to_string_lossy().into_owned(),
            drive_folder_id: "root".into(),
            mode: PairMode::TwoWay,
            enabled: true,
            ..Default::default()
        });
        let drive = FakeDrive::start().await;
        auth::set_token_for_test("t13-test-token").await;
        let client = DriveClient::new_with_client(reqwest::Client::new(), drive.url());
        let governor = Governor::new((&cfg.governor).into());
        Self {
            _dir: dir,
            root,
            db,
            cfg,
            drive,
            client,
            limiter: Arc::new(Limiter::new(0)),
            governor,
        }
    }

    fn pair(&self) -> &PairEntry {
        &self.cfg.pairs[0]
    }

    fn uploader(&self) -> UploadRunner {
        UploadRunner {
            db: Arc::clone(&self.db),
            cfg: self.cfg.clone(),
            gov: self.governor.clone(),
            drive: self.client.clone(),
            limiter: Arc::clone(&self.limiter),
        }
    }

    fn downloader(&self) -> DownloadRunner {
        DownloadRunner {
            db: Arc::clone(&self.db),
            cfg: self.cfg.clone(),
            gov: self.governor.clone(),
            drive: self.client.clone(),
            limiter: Arc::clone(&self.limiter),
        }
    }
}

fn job(id: i64, kind: &str, rel: impl Into<String>) -> Job {
    Job {
        id,
        pair_id: PAIR_ID.into(),
        kind: kind.into(),
        rel_path: rel.into(),
        priority: 10,
        attempts: 0,
        next_try_ms: 0,
        status: "queued".into(),
        last_error: None,
        created_ms: 1,
    }
}

fn generated_bytes(case: usize, size: usize) -> Vec<u8> {
    let rng = TestRng::new(0xC0DE_A11C_0000_0000_u64.wrapping_add(case as u64));
    let mut data = vec![0_u8; size];
    rng.fill_bytes(&mut data);
    if !data.is_empty() {
        data[0] = case as u8;
        let last = data.len() - 1;
        data[last] = (case >> 8) as u8;
    }
    data
}

async fn run_upload(h: &Harness, id: i64, rel: &str) {
    let (tx, mut rx) = mpsc::unbounded_channel::<ProgressUpdate>();
    h.uploader().run(job(id, "upload", rel), tx).await.expect("upload");
    while rx.try_recv().is_ok() {}
}

async fn run_download(h: &Harness, id: i64, rel: &str) {
    let (tx, mut rx) = mpsc::unbounded_channel::<ProgressUpdate>();
    h.downloader().run(job(id, "download", rel), tx).await.expect("download");
    while rx.try_recv().is_ok() {}
}

fn seed_download_row(h: &Harness, rel: &str, source: &FileRow) {
    h.db.upsert_file(FileRow {
        pair_id: PAIR_ID.into(),
        rel_path: rel.into(),
        size: source.size,
        mtime_ms: source.mtime_ms,
        md5: source.md5.clone(),
        drive_id: source.drive_id.clone(),
        drive_md5: source.drive_md5.clone(),
        drive_mtime_ms: source.drive_mtime_ms,
        drive_rev: source.drive_rev.clone(),
        state: "dirty".into(),
        os_file_id: None,
    }).expect("seed download row");
}

#[test]
fn generated_path_boundary_matrix_rejects_every_escape_shape() {
    let root = Path::new(r"C:\\TwinRoot");
    let safe_components = ["notes.txt", "nested/report.pdf", "नमूना/🌱.txt", "a_b-c.123"];
    for safe in safe_components {
        let target = resolve_under_root(root, safe).expect("safe path");
        assert!(target.starts_with(root));
    }

    let attack_prefixes = ["../", "..\\", "/", "\\", "//server/share/", "C:\\", "D:/"];
    let attack_names = [
        "escape.txt", "NUL", "CON.txt", "LPT9", "file.txt:stream",
        "trailing.", "trailing ", ".", "..", "a//b",
    ];
    let mut cases = 0;
    for prefix in attack_prefixes {
        for name in attack_names {
            cases += 1;
            assert!(
                resolve_under_root(root, &format!("{prefix}{name}")).is_err(),
                "unsafe case {prefix:?} + {name:?} escaped validation"
            );
        }
    }
    for depth in 1..=64 {
        let traversal = std::iter::repeat("..").take(depth).collect::<Vec<_>>().join("/");
        assert!(resolve_under_root(root, &format!("{traversal}/outside.bin")).is_err());
        cases += 1;
    }
    assert!(cases >= 134);
}

#[tokio::test]
async fn folder_cache_is_scoped_to_the_active_drive_client() {
    let first = Harness::new().await;
    let second = Harness::new().await;

    first.client.ensure_path(PAIR_ID, "root", "a/b").await.expect("first folders");
    assert_eq!(first.drive.state().read().await.files.len(), 2);

    // This used to return a folder id cached from `first`, even though the
    // second endpoint had never created it. The second Drive must receive its
    // own two create operations.
    second.client.ensure_path(PAIR_ID, "root", "a/b").await.expect("second folders");
    assert_eq!(second.drive.state().read().await.files.len(), 2);
}

#[tokio::test]
async fn generated_small_file_roundtrip_matrix_128_real_files() {
    let h = Harness::new().await;
    let sizes = [0, 1, 2, 3, 7, 31, 255, 256, 257, 511, 1023, 4095, 8191, 16_383];
    let names = ["plain", "space name", "unicode-नमूना", "emoji-🌱"];
    let mut case = 0_i64;

    for depth in 0..=2 {
        for stem in names {
            for size in sizes {
                let prefix = (0..depth).map(|d| format!("level-{d}")).collect::<Vec<_>>().join("/");
                let source_rel = if prefix.is_empty() {
                    format!("source/{stem}-{case}.bin")
                } else {
                    format!("source/{prefix}/{stem}-{case}.bin")
                };
                let source_path = resolve_under_root(&h.root, &source_rel).expect("safe source path");
                fs::create_dir_all(source_path.parent().unwrap()).expect("source parent");
                let bytes = generated_bytes(case as usize, size);
                fs::write(&source_path, &bytes).expect("write generated source");

                run_upload(&h, case + 1, &source_rel).await;
                let uploaded = h.db.get_file(PAIR_ID, &source_rel).expect("uploaded row").expect("row exists");
                assert_eq!(uploaded.state, "synced");
                let id = uploaded.drive_id.clone().expect("drive id");
                let state = h.drive.state();
                assert_eq!(state.read().await.files.get(&id).expect("remote file").data, bytes);

                let destination_rel = source_rel.replacen("source/", "restored/", 1);
                seed_download_row(&h, &destination_rel, &uploaded);
                run_download(&h, 50_000 + case, &destination_rel).await;
                assert_eq!(
                    fs::read(resolve_under_root(&h.root, &destination_rel).unwrap()).expect("read restored"),
                    bytes,
                    "case={case} rel={source_rel}"
                );
                case += 1;
            }
        }
    }
    assert_eq!(case, 168);
    assert!(h.db.check_integrity().expect("integrity"));
}

#[tokio::test]
async fn generated_scanner_matrix_tracks_create_modify_delete_over_300_files() {
    let h = Harness::new().await;
    let rules = Rules::for_pair(&h.cfg.rules, h.pair());
    let mut expected = Vec::new();

    for idx in 0..360 {
        let rel = format!("scan/branch-{}/file-{idx:04}.dat", idx % 12);
        let path = resolve_under_root(&h.root, &rel).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, generated_bytes(idx, (idx * 37) % 2048)).unwrap();
        expected.push(rel);
    }
    watcher::scan_pair(h.pair(), Arc::clone(&h.db), &rules, &h.governor).await.expect("initial scan");
    assert_eq!(h.db.list_all_files(PAIR_ID).unwrap().len(), 360);
    assert_eq!(h.db.count_jobs_by_status("queued").unwrap(), 360);

    for (idx, rel) in expected.iter().enumerate() {
        if idx % 5 == 0 {
            fs::remove_file(resolve_under_root(&h.root, rel).unwrap()).unwrap();
        } else if idx % 5 == 1 {
            fs::write(resolve_under_root(&h.root, rel).unwrap(), generated_bytes(idx + 1000, 1024)).unwrap();
        }
    }
    watcher::scan_pair(h.pair(), Arc::clone(&h.db), &rules, &h.governor).await.expect("second scan");

    let rows = h.db.list_all_files(PAIR_ID).unwrap();
    let deleted = rows.iter().filter(|row| row.state == "deleted" || row.state == "deleted_local").count();
    assert_eq!(deleted, 72);
    assert!(h.db.check_integrity().unwrap());
}

#[tokio::test]
async fn generated_concurrent_real_file_upload_matrix_preserves_every_byte() {
    let h = Harness::new().await;
    let mut pending = Vec::new();
    for idx in 0..48_i64 {
        let rel = format!("concurrent/group-{}/payload-{idx}.bin", idx % 8);
        let path = resolve_under_root(&h.root, &rel).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let data = generated_bytes(idx as usize, 1024 + (idx as usize * 97));
        fs::write(path, &data).unwrap();
        pending.push((idx, rel, data));
    }

    let uploader = h.uploader();
    let mut handles = Vec::new();
    for (idx, rel, _) in &pending {
        let runner = UploadRunner {
            db: Arc::clone(&uploader.db), cfg: uploader.cfg.clone(), gov: uploader.gov.clone(),
            drive: uploader.drive.clone(), limiter: Arc::clone(&uploader.limiter),
        };
        let work = job(70_000 + idx, "upload", rel.clone());
        handles.push(tokio::spawn(async move {
            let (tx, _rx) = mpsc::unbounded_channel();
            runner.run(work, tx).await
        }));
    }
    for handle in handles {
        handle.await.expect("join").expect("parallel upload");
    }

    let remote = h.drive.state();
    let remote = remote.read().await;
    for (_, rel, expected) in pending {
        let row = h.db.get_file(PAIR_ID, &rel).unwrap().unwrap();
        let id = row.drive_id.unwrap();
        assert_eq!(remote.files.get(&id).unwrap().data, expected, "{rel}");
    }
    assert_eq!(
        remote.files.values().filter(|file| file.mime_type != "application/vnd.google-apps.folder").count(),
        48,
        "exactly one content object must exist for every concurrent upload"
    );
    assert!(h.db.check_integrity().unwrap());
}

#[tokio::test]
async fn unsafe_persisted_and_remote_paths_are_rejected_without_writing_outside_root() {
    let h = Harness::new().await;
    let sentinel = h.root.parent().unwrap().join("outside-sentinel.txt");
    fs::write(&sentinel, b"must survive").unwrap();

    for (idx, rel) in [
        "../outside-sentinel.txt", r"..\outside-sentinel.txt", "/outside-sentinel.txt",
        r"C:\outside-sentinel.txt", "file.txt:ads", "NUL", "folder/../escape.txt",
    ].iter().enumerate() {
        h.db.upsert_file(FileRow {
            pair_id: PAIR_ID.into(), rel_path: (*rel).into(), size: Some(1), mtime_ms: Some(1),
            md5: Some("x".into()), drive_id: Some(format!("malicious-{idx}")), drive_md5: Some("x".into()),
            drive_mtime_ms: Some(1), drive_rev: None, state: "dirty".into(), os_file_id: None,
        }).unwrap();
        let (tx, _rx) = mpsc::unbounded_channel();
        assert!(h.downloader().run(job(90_000 + idx as i64, "download", *rel), tx).await.is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"must survive");
    }
    assert!(h.db.check_integrity().unwrap());
}
