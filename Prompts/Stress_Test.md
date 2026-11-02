# Stress_Test.md: Pre-release Hardcore Testing (SQLite-style)
Run AFTER P13 and BEFORE tagging any release. Read MASTER.md COMMON RULES first. This prompt overrides the "no new dependencies" rule ONLY for the **test-only** dev-dependencies listed below (never in `[dependencies]`). Do not change production code except to fix bugs the tests expose; every fix needs a regression test. Work in phases (T1..T12), one per session, commit after each. Stop and report after each phase.

## Philosophy
SQLite ships with roughly 500+ lines of test per line of code, using fault injection, fuzzing, crash simulation and 100% branch coverage. We copy the method, scaled to this app. A passing test is worthless unless it can fail: every suite must be proven by mutation testing (T9).

## Targets (hard gates, measured by tooling, not claimed)
| Metric | Gate | Stretch |
|---|---|---|
| Test-LOC : production-LOC (Rust, excluding generated code) | >= 8 : 1 | 20 : 1 |
| Line coverage (`cargo llvm-cov`) | >= 95% | 98% |
| Branch coverage on `db/`, `transfer/`, `sync/`, `queue/`, `governor/` | >= 90% | 95% |
| Mutation score (`cargo mutants`) on same modules | >= 85% | 92% |
| Frontend line coverage (vitest) | >= 85% | 92% |
| Fuzz time per target, no crashes | >= 10 min each | 60 min |
| Soak run (T10) with zero data loss/corruption | 24 h | 72 h |
Compute and print the ratio with a script `scripts/test_ratio.ps1` (counts non-blank, non-comment lines in `src-tauri/src` vs `src-tauri/tests` + `#[cfg(test)]` blocks + `src/**/*.test.ts(x)`). Gate is enforced in CI.
Test volume must come from **generated** cases (property tests, table-driven matrices, fuzz corpora), not copy-paste.

## Allowed test-only dev-dependencies
Rust: `proptest`, `wiremock`, `tempfile`, `serial_test`, `loom`, `criterion`, `arbitrary`, `libfuzzer-sys` (via `cargo-fuzz`), `insta` (snapshots), `fake`. Tools: `cargo-llvm-cov`, `cargo-mutants`, `cargo-fuzz`, `cargo-nextest`.
Frontend: `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@vitest/coverage-v8`, `playwright` (UI e2e only).
Anything else: stop and ask.

## T1. Test harness + fakes (build first, everything uses it)
Create `src-tauri/tests/support/`:
- `FakeDrive`: in-process HTTP server (wiremock or hyper-free tokio TcpListener) implementing the Drive endpoints we use (files list/get/create/update/delete, multipart + resumable upload with 308 semantics, ranged media download, revisions, trash, changes + page tokens, about, permissions, export). Stateful (an in-memory tree with ids, md5, revisions, modifiedTime).
- **Fault injector** on FakeDrive and on a `FakeFs` trait wrapper: configurable per call: `Ok`, `Err(io kind)`, `Delay(ms)`, `Drop connection mid-body at byte N`, `Http(429/500/503/401/403/404)`, `Truncate response`, `Corrupt byte`, `Slow trickle (X B/s)`, `Fail the Nth call` and `Fail with probability p (seeded)`.
- `FakeClock` (tokio `pause()`/`advance`), `FakeCpu` (scriptable CPU % samples), `FakePower` (battery state).
- Deterministic seeded RNG; every failing test prints its seed; `PROPTEST_CASES` default 2000 locally, 20000 in nightly.
Done-test: harness self-tests prove each fault actually triggers (a fault injector that silently does nothing is a bug).

## T2. Database torture (SQLite-level) for `db/`
1. **Property tests**: random sequences of (upsert, mark_state, enqueue, next_due_job, complete, fail, log_activity, prune) compared against a simple in-memory reference model; assert equality of observable state after every step. 20k cases.
2. **Constraint tests**: every PRIMARY KEY/dedupe rule, NULL/empty/very long (64 KB) paths, unicode (emoji, RTL, combining chars, NFC vs NFD), paths with `'`, `"`, `;`, `%`, `\0` (reject), SQL-injection strings (must be stored literally).
3. **Crash simulation**: spawn child process doing continuous writes; `kill -9`/`TerminateProcess` at random instants (>= 500 iterations); reopen and run `PRAGMA integrity_check` (must be `ok`), `PRAGMA foreign_key_check`, verify every committed job is present exactly once and no partial row exists.
4. **Power-loss emulation**: copy the DB + WAL file at random points mid-transaction (byte-level snapshots, including truncating the WAL at random offsets) and verify open + recovery succeeds or fails cleanly with `AppError::Db` (never panics, never silently drops committed data).
5. **Corruption handling**: flip random bytes in the DB file (1000 iterations, seeded); app must detect (integrity_check), move the file to `state.db.corrupt-<ts>`, rebuild from scratch via rescan, and show an error toast. Zero panics.
6. **Concurrency**: 16 threads mixing reads/writes for 60 s; no `SQLITE_BUSY` leaking to callers; verify against model. Run under `loom` for the writer-channel logic.
7. **Migrations**: from every historical `user_version` to latest, with populated data; migrating twice is a no-op; failed migration mid-way rolls back fully.
8. **Disk-full / read-only**: inject `SQLITE_FULL`, `SQLITE_READONLY`, `SQLITE_IOERR` (via a FakeVfs wrapper or tiny tmpfs/limited VHD in CI); app degrades to read-only mode, queues in memory up to a cap, reports error, recovers when space returns.
9. **Scale**: 5 million `files` rows, 1 million jobs; measure insert/lookup/prune p50/p99; budgets: lookup < 1 ms p99, prune < 50 ms, DB file growth within 2x of row bytes, RAM < 80 MB.

## T3. Transfer engine (`transfer/`, `drive/client.rs`)
- **Matrix tests** (table-driven, generated): file sizes {0, 1 B, 255 KiB, 256 KiB, 256 KiB+1, 4.99 MiB, 5 MiB, 5 MiB+1, chunk-1, chunk, chunk+1, 3*chunk+7, 2 GiB sparse, 5 GiB sparse} x fault {none, drop at 0%/50%/99%/exactly chunk boundary, 429, 500, 401 mid-upload, session expired 404, truncated 308 Range header, wrong md5 returned, slow trickle} x concurrency {1,4,8}. Every cell: final Drive content byte-identical (compare md5) OR a clean, retryable `AppError`; never a duplicate file, never a half file marked synced.
- **Resumability**: kill the process at 200 random points during upload and download (uploads at every chunk boundary +/- 1 byte); restart; transfer completes with total bytes sent <= size + 1 chunk.
- **Progress invariants (property tests)**: `bytes_done` monotonic non-decreasing, <= `bytes_total`, ends exactly equal at success; ETA never negative/NaN/inf; events <= 4/s/job; batch totals equal sum of parts.
- **Limiter**: measured throughput within +/-5% of limit over 30 s at 64 KB/s, 1 MB/s, 50 MB/s; limit changes apply within 2 s; `0` has overhead < 1%.
- **Download**: ranged reassembly byte-identical for random sizes and random range failures; `.tether-part` + sidecar crash-resume; atomic rename (kill between write and rename leaves original intact); mtime set; Google-native export size-limit path.
- **Memory**: transfer of 5 GiB with RSS sampled every 100 ms must stay < 120 MB peak (assert in test).
- **Windows path fuzz**: long paths (> 260, up to 32k with `\\?\`), reserved names (`CON`, `NUL`, `COM1`, trailing dot/space), case-only renames, unicode normalization collisions, alternate data streams `file.txt:ads`, symlinks/junctions (must not escape sync root), UNC paths, drive-letter changes, files locked by another process, files growing while hashed, files deleted mid-upload, mtime in the future / before 1980.

## T4. Sync logic (`sync/`, `queue/`, `watcher/`)
- **Exhaustive decision table**: generate all (L, R, deleted, mode, conflict policy, deletion policy) combinations programmatically (> 500 cases); each asserts the exact expected action and that no data is lost (the losing version always remains recoverable in revisions or `.tether-trash`).
- **Deterministic simulation testing** (the single most valuable test): a simulator with 2 clients + FakeDrive + FakeClock; a seeded random scheduler generates operations (create/edit/delete/rename/move on either side, offline periods, crashes/restarts, token expiry, network partitions, duplicate change events). After quiescence, invariant checks: (a) both sides converge, (b) no file lost unless deleted by policy, (c) no infinite sync loop (echo suppression: transfer count bounded), (d) no duplicate files. Run >= 100k seeds in nightly; any failure prints a reproducible seed and is added to `tests/regressions/seeds.txt` permanently.
- **Watcher**: 10k files created in 5 s, 20 rapid writes to one file, rename storms, `node_modules`-style deep trees (depth 100), watcher buffer overflow triggers rescan; event count after debounce equals expected; CPU while idle ~0.
- **Queue**: dedupe, priority, backoff schedule exact values, give-up at attempt 8, dynamic concurrency resize under load, no job lost or run twice across crash/restart (assert at-least-once with idempotent effects).

## T5. Resource governor and lightweight guarantees
- Scripted CPU traces (flapping 65-75%, sustained 100%, spikes < 5 s, slow ramps) -> exact state transitions; no flapping; checkpoint blocks and releases correctly; battery and active-hours matrices.
- **Real-machine tests** (`scripts/resource_test.ps1`): (a) idle 1 h: CPU average < 0.1%, RSS < 50 MB, zero handles/threads growth; (b) during a 100k-file scan: RSS < 80 MB; (c) run a CPU burner at 100% on all cores: app activity drops to ~0 within 10 s and resumes within 10 s after burner stops; (d) hidden window emits 0 UI events.
- **Leak test**: 24 h loop of 1000 create/modify/delete cycles; RSS, handle count and thread count slope must be ~0 (linear regression slope assertion).

## T6. Config + GitHub sync + Auth
- Config: property-test random TOML (valid/invalid/partial/huge/BOM/CRLF/duplicate keys/unknown keys); merge by pair id; atomic save (kill during save leaves old or new, never torn); edits while running; path variable expansion fuzz.
- GitHub: FakeGitHub with 409/422 sha conflicts, 401, 403 rate-limit, 5xx, timeouts, large body; unchanged skip; gzip path; oversize refusal; pull-merge matrix across two machines; **token never appears** in logs, errors, panics messages, state json or config (scan outputs for the token string in every test).
- Auth: token refresh race (100 concurrent `access_token()` calls cause exactly 1 refresh), `invalid_grant`, clock skew, state mismatch, listener timeout, port in use, browser never returns.

## T7. Fuzzing (`cargo fuzz`, 10+ min each locally, 1 h nightly)
Targets: (1) TOML config parser wrapper, (2) path expansion + rel-path normalizer, (3) glob rules matcher, (4) Drive JSON response parsers (files/changes/revisions/errors), (5) resumable-upload `Range`/`Content-Range` header parser, (6) GitHub JSON + sync-state merge, (7) DB row (de)serialization with random strings, (8) OAuth redirect request parser (HTTP request bytes). Commit corpora in `fuzz/corpus/`. Any crash becomes a permanent regression test. Zero panics, zero unbounded memory growth, zero hangs (> 1 s per input).

## T8. Security tests
Path traversal (`..\`, absolute paths, UNC, symlink escape) in restore destinations and Drive filenames: never write outside the chosen root. Drive filename containing path separators or reserved names is sanitized deterministically and collision-safe. Secrets: grep the repo, logs, crash dumps, `config/*`, `data/*` for token/secret patterns after a full test run (must find none). OAuth `state` verified. TLS: no cert-verification bypass in code (grep `danger_accept_invalid_certs`). Untrusted JSON size caps. Dependency audit: `cargo audit`, `cargo deny`, `pnpm audit` clean or explicitly waived in `SECURITY_WAIVERS.md`.

## T9. Test-quality proof
- `cargo llvm-cov nextest --branch` -> HTML + lcov; enforce gates in CI.
- `cargo mutants` on `db/ transfer/ sync/ queue/ governor/ rules/ config/`; list surviving mutants; for each, add a test that kills it or document why it is equivalent. Target score per table.
- Flaky detection: run the whole suite 20x with random order and random thread count; zero flakes allowed (quarantine = fail).
- Sanity "canary" test: intentionally break one line in a copy of each module and confirm the suite fails (script `scripts/canary.ps1`).

## T10. Soak and chaos (real machine, real Google account in a throwaway Drive folder)
72 h target, 24 h minimum. A script generates mixed workloads (many tiny files, a few multi-GB files, edits, renames, deletes, bursts, 10-min idle gaps) while a chaos monkey randomly: kills the app, disconnects Wi-Fi, sleeps/hibernates the PC, fills the disk to 100%, changes the clock +/- 1 h, revokes the token, pauses the process, locks files, runs a CPU burner, renames the sync root. At the end: full tree hash comparison local vs Drive (zero diffs), DB integrity ok, no orphan `.tether-part` files, no orphan resumable sessions, RSS/handles flat, log has no `panic`. Save a report `reports/soak-<date>.md`.

## T11. Frontend
- vitest + Testing Library for every component and store reducer (>= 85% lines); property test: random event streams into the store keep invariants (progress monotonic, no NaN, no stale jobs after complete).
- Playwright e2e against the Tauri dev build or a mocked Tauri IPC: add folder, pause/resume, retry failed, restore with revision, conflict dialog, settings credential fields (write-only, Saved/Not set, Clear), first-run checklist.
- Accessibility: axe checks on every screen, keyboard-only walkthrough, `prefers-reduced-motion`, contrast checks for both themes. Verify against `UI_GUIDE.md` (no gradients/glows, radius <= 8px, single accent).
- Event flood: 10k progress events/s must not exceed 5% CPU or freeze UI; hidden window drops events.

## T12. Performance regression + release gate
- `criterion` benchmarks: hashing (MB/s), scan (files/s), DB ops, queue dispatch, progress calc; store baselines in `benches/baseline/`; CI fails on > 10% regression.
- Real throughput: upload/download of 1 GB single file and 10k x 100 KB files; report MB/s and files/s versus plain `rclone`/Drive web as a reference (informational).
- **Release gate checklist** (agent must print this filled in, with evidence links/log paths):
[ ] Test:code ratio >= 8:1 (printed)  [ ] Line cov >= 95%  [ ] Branch cov >= 90% core  [ ] Mutation >= 85%
[ ] 100k+ simulation seeds pass  [ ] All fuzz targets clean  [ ] 0 flaky in 20 runs  [ ] 24 h soak clean
[ ] Idle CPU < 0.1%, RSS < 50 MB  [ ] CPU-burner throttle verified  [ ] No secrets found  [ ] Audit clean
[ ] Installer runs without admin, upgrades in place, uninstall leaves config/ and repo untouched
[ ] Clean-machine test: fresh Windows VM, clone repo, install, login, pull config, first sync OK
Any unchecked item blocks the release.

## Rules for the agent
1. Never weaken or delete a test to make it pass. Never mock the code under test. Never use `#[ignore]` without a written reason and an issue entry in `KNOWN_ISSUES.md`.
2. Every bug found: write the failing test first, then fix, commit as `fix(Tn): ...`.
3. Report per phase: tests added (count + LOC), ratio, coverage, bugs found/fixed, remaining risks. Then STOP and wait for "next".
4. Keep CI runtime sane: fast suite (< 10 min) on every PR; nightly job runs the large property/simulation/fuzz volumes; soak is manual.
