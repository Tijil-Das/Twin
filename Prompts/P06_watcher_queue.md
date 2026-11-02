# P06 Watcher + Queue
Read MASTER.md COMMON RULES and SPEC.md. Modules `src-tauri/src/watcher/`, `src-tauri/src/queue/`. Uses Config (P02), Db (P04), Governor (P05), rules matcher (inline here, globset).
## Rules matcher (put in `rules/mod.rs`)
`pub struct Rules::new(include,exclude,max_file_mb)`; `pub fn allowed(&self, rel:&Path, size:u64)->bool`. Exclude wins over include; empty include = allow all. Match against forward-slash relative path. Skip hidden+system attribute files (GetFileAttributesW).
## Watcher
- For each enabled pair, `notify-debouncer-full` with timeout = `debounce_secs`, recursive. Map events to `LocalChange{pair_id, rel_path, kind: Modified|Deleted|Renamed{from}}`; ignore directories-only events except delete/rename of dirs (expand to child rows from Db).
- Ignore files still locked/being written: if open for read fails with sharing violation, re-queue after 5 s (max 5 times).
- Watcher errors (buffer overflow) trigger a full pair scan.
## Scanner
`pub async fn scan_pair(pair, db, rules, gov)`: walk dir with `std::fs::read_dir` iteratively (no recursion stack), compare size+mtime to Db; only if mtime/size differ compute md5 (streaming 1 MB buffer, `gov.checkpoint().await` every 8 MB). Enqueue `upload` jobs for new/changed; mark missing ones deleted_local and enqueue `delete` per policy. Runs at startup (low priority, 2 s after launch), and every `fallback_rescan_mins`.
## Queue
- `queue::Queue::new(db, gov, cfg)`; dispatcher is ONE task that awaits a `Notify` when empty (no polling), else pulls `next_due_job`, respects `gov.effective_concurrency(cfg.parallel_transfers)` via a `Semaphore` resized dynamically, and calls an injected `trait JobRunner{ async fn run(&self, job:Job, progress:ProgressTx)->Result<(),AppError> }` (implemented in P07/P08).
- If no job is due but some are scheduled, sleep until the earliest `next_try_ms` (tokio::time::sleep_until).
- Pause/resume integrates with `gov.checkpoint()` before starting each job.
Commands: `sync_now(pair_id?)`, `queue_status`.
## Done-test
Tests: rules matching table; scanner detects add/modify/delete in tempdir; watcher debounce collapses 20 rapid writes into 1 job; queue obeys concurrency changes; no CPU use when idle (assert dispatcher awaiting on Notify, no timers).
