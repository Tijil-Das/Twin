# MASTER PROMPT: Project "TETHER" (rename freely)
You are a code-generation agent. Build a Windows background Google Drive sync app by executing prompts P01..P13 IN ORDER, one per session. Do NOT engineer beyond the prompts. Do NOT invent APIs, crates, or fields. If unsure, stop and ask, or cite the official doc URL. Read `SPEC.md` and the current prompt file before coding.

## Roadmap (each has a done-test; commit only when it passes)
| # | File | Output |
|---|------|--------|
| P01 | P01_scaffold.md | Tauri2+React app, tray, single instance |
| P02 | P02_config.md | Portable config.toml + local overrides + path variables |
| P03 | P03_oauth.md | Google OAuth + Credential Manager |
| P04 | P04_statedb.md | SQLite state DB |
| P05 | P05_resource_governor.md | CPU/RAM/battery throttle (used by ALL later modules) |
| P06 | P06_watcher_queue.md | File watcher, debounce, job queue |
| P07 | P07_upload.md | Resumable parallel uploads + real progress |
| P08 | P08_download_restore.md | Parallel ranged downloads, versions, trash restore |
| P09 | P09_changes_twoway.md | Changes API, two-way sync, conflicts |
| P10 | P10_ui.md | All UI screens, real progress bars + ETA |
| P11 | P11_github_sync.md | Config push/pull to GitHub |
| P12 | P12_rules_polish.md | Autostart, rules, bandwidth, Drive extras |
| P13 | P13_release.md | GitHub Actions build + release |

## COMMON RULES (apply to every prompt)
1. Touch ONLY files/modules named in the current prompt. Public interfaces of earlier modules must not change; if one must, stop and report.
2. Use ONLY the crates/packages listed in SPEC.md "Stack". Adding any other dependency is forbidden.
3. Every module exposes the exact function signatures given. Write unit tests; run `cargo test`, `cargo clippy -- -D warnings`, `pnpm tsc --noEmit`. Stop when the done-test passes. No extra features, no refactors.
4. **Lightweight rules (mandatory):**
   - No busy loops, no polling faster than 1 s; use async awaits/channels/OS events.
   - Idle target: CPU ~0%, RAM < 50 MB (backend), no timers firing while idle except the 30-min fallback rescan.
   - Every heavy loop (hashing, uploading, downloading, scanning) MUST call `governor.checkpoint().await` between units of work (P05). When the governor says "throttled", the work pauses until resumed.
   - Hash/read files with 1 MB buffers streaming, never load whole files in memory. Max in-memory transfer buffers: 64 MB total.
   - Backend process priority is BELOW_NORMAL; worker threads use low priority.
   - UI: no animations running when window hidden; stop emitting progress events when window is hidden/minimized (keep state, resume on show). Throttle progress events to max 4 per second per job.
5. All errors: typed `AppError` enum (thiserror is NOT allowed unless in SPEC; hand-write it). Never `unwrap()` in non-test code.
6. No secrets in code, logs, or config files.
7. At the end, print: files changed, how to run the done-test, and any deviations (should be none).

## Session template (paste at start of every session)
"Read MASTER.md (COMMON RULES), SPEC.md, and prompts/Pxx_name.md. Implement exactly Pxx. Do not touch other modules. Stop when the done-test passes."

## Credentials registry (all secrets in Windows Credential Manager, service `tether`)

| Key | Description | Set by |
|-----|-------------|--------|
| `client_id` | Google OAuth Desktop Client ID | `auth_set_client_id` (P03) |
| `client_secret` | Google OAuth Desktop Client Secret | `auth_set_client_secret` (P03) |
| `refresh_token` | Google OAuth refresh token | `auth_login` / `auth_clear_credentials` (P03) |
