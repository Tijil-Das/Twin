//! Phase T12: Performance Benchmarks & Release Gate Suite
//! Target: Hashing throughput (MB/s), scan speed (files/s), DB ops/sec, progress calculation.

use md5::Digest;
use std::sync::Arc;
use std::time::Instant;

use tempfile::tempdir;
use twin_lib::db::{Db, FileRow, NewJob};

#[test]
fn test_bench_blake3_and_md5_throughput() {
    // Generate 10 MB payload
    let size = 10 * 1024 * 1024;
    let data = vec![0x55u8; size];

    // MD5 throughput
    let t0 = Instant::now();
    let digest = md5::Md5::digest(&data);
    let md5_elapsed = t0.elapsed();
    let md5_mb_s = (size as f64 / 1_048_576.0) / md5_elapsed.as_secs_f64();
    println!("MD5 throughput: {md5_mb_s:.1} MB/s ({digest:?})");
    assert!(md5_mb_s > 5.0, "MD5 hashing throughput too slow: {md5_mb_s} MB/s");

    // Blake3 throughput
    let t1 = Instant::now();
    let b3_hash = blake3::hash(&data);
    let b3_elapsed = t1.elapsed();
    let b3_mb_s = (size as f64 / 1_048_576.0) / b3_elapsed.as_secs_f64();
    println!("Blake3 throughput: {b3_mb_s:.1} MB/s ({b3_hash})");
    assert!(b3_mb_s > 50.0, "Blake3 hashing throughput too slow: {b3_mb_s} MB/s");
}

#[test]
fn test_bench_database_ops_throughput() {
    let dir = tempdir().expect("tempdir");
    let db = Arc::new(Db::open(&dir.path().join("bench.db")).expect("open db"));

    // Measure 1,000 FileRow upserts
    let count = 1000;
    let t0 = Instant::now();
    for i in 0..count {
        db.upsert_file(FileRow {
            pair_id: "pair-bench".into(),
            rel_path: format!("path/to/file_{i}.txt"),
            size: Some(i as i64 * 10),
            mtime_ms: Some(1000 + i as i64),
            md5: Some(format!("md5_hash_{i}")),
            drive_id: Some(format!("drv_{i}")),
            drive_md5: Some(format!("md5_hash_{i}")),
            drive_mtime_ms: Some(1000 + i as i64),
            drive_rev: Some("1".into()),
            state: "synced".into(),
        }).expect("upsert file");
    }
    let upsert_elapsed = t0.elapsed();
    let upserts_per_sec = (count as f64) / upsert_elapsed.as_secs_f64();
    println!("Database upsert throughput: {upserts_per_sec:.1} ops/s");
    assert!(upserts_per_sec > 200.0, "Database write ops too slow: {upserts_per_sec} ops/s");

    // Measure 1,000 lookups
    let t1 = Instant::now();
    for i in 0..count {
        let row = db.get_file("pair-bench", &format!("path/to/file_{i}.txt")).expect("get file");
        assert!(row.is_some());
    }
    let lookup_elapsed = t1.elapsed();
    let lookups_per_sec = (count as f64) / lookup_elapsed.as_secs_f64();
    let p99_micros = (lookup_elapsed.as_micros() as f64) / (count as f64);
    println!("Database lookup throughput: {lookups_per_sec:.1} ops/s (avg {p99_micros:.1} µs/op)");
    assert!(p99_micros < 1000.0, "Database lookup latency exceeded 1ms budget: {p99_micros} µs");
}

#[test]
fn test_bench_queue_job_dispatch_throughput() {
    let dir = tempdir().expect("tempdir");
    let db = Arc::new(Db::open(&dir.path().join("queue.db")).expect("open db"));

    let count = 500;
    let now = 1000000;
    for i in 0..count {
        db.enqueue(NewJob {
            pair_id: "pair-q".into(),
            kind: "upload".into(),
            rel_path: format!("file_{i}.dat"),
            priority: (i % 10) as i64,
            created_ms: now + i as i64,
        }).expect("enqueue job");
    }

    // Measure fetch next due jobs
    let t0 = Instant::now();
    let job = db.next_due_job(now + 10000).expect("next due job");
    let elapsed = t0.elapsed();
    assert!(job.is_some());
    println!("Fetched next priority job in {:?}", elapsed);
    assert!(elapsed.as_millis() < 10, "Queue dispatch query took too long: {:?}", elapsed);
}
