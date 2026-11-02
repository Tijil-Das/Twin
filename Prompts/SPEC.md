# SPEC: Tether
Windows 10/11 tray app that syncs local folders with Google Drive. Simple UI, powerful features, very light.

## Stack (ONLY these)
Frontend: React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Zustand, lucide-react, framer-motion (minimal use), pnpm.
Backend (Rust, Tauri 2): tauri, tauri-plugin-single-instance, tauri-plugin-autostart, tauri-plugin-notification, tokio, reqwest (rustls, http2, stream, json), futures, serde, serde_json, toml, rusqlite (bundled), notify, notify-debouncer-full, globset, md-5, blake3, keyring, base64, sysinfo, windows-sys (priority + power status), flate2, chrono, uuid, tracing, tracing-subscriber, tempfile (dev), wiremock (dev).
OAuth is hand-written (loopback + PKCE) with reqwest; do NOT use yup-oauth2 or Google SDK crates.

## Repo layout
```
/src-tauri/src/{main.rs,config/,auth/,db/,governor/,watcher/,queue/,drive/,transfer/,sync/,github/,rules/,commands.rs,error.rs}
/src/ (React)   /config/config.toml   /config/config.local.toml (gitignored)
/config/sync-state.json (committed, small)   /data/state.db (gitignored)
/prompts/*.md   SPEC.md   MASTER.md
```
## Features
- Multiple folder pairs: local path <-> Drive folder ID. Modes per pair: `upload` (local->Drive), `mirror` (Drive matches local, deletes included), `two_way`.
- Real-time watch + startup catch-up scan + 30-min fallback rescan.
- Debounce 3 s. Queue with priorities, retry with exponential backoff (1,2,4,8,16,... max 5 min, 8 tries).
- Fast transfers: 4-8 parallel (configurable), resumable chunked upload (chunk = 16 MiB, multiple of 256 KiB), parallel ranged download (4 ranges for files > 32 MB), skip unchanged via md5Checksum + mtime + size, small files (<5 MB) use multipart upload.
- Real progress bars: bytes done / bytes total per file and per batch; ETA from a smoothed (EMA alpha 0.2) speed. Never fake progress.
- Restore from Drive: browse a folder, pick file/folder, pick revision, restore to original or chosen path; restore from trash.
- Drive extras: revisions (list, restore, keepForever), trash recovery, shared drives, shortcuts, share link copy, Google Docs/Sheets/Slides export (docx/xlsx/pptx/pdf), storage quota, starred/description metadata, Changes API.
- Conflict policy: `newer_wins` | `keep_both` | `ask`.
- Deletion policy: `ignore` | `drive_trash` | `delete`.
- Rules: include/exclude globs, max file size, hidden/system file skip.
- Bandwidth limit (KB/s up/down), active-hours schedule.
- Resource governor: pause all work when system CPU > 70% for 5 s; resume when < 50% for 5 s; pause on battery < 20% unless plugged; optional pause on metered network (manual toggle). Max CPU use of app itself capped by concurrency reduction (see P05).
- Portable config: config files live NEXT TO the app (repo), never %APPDATA%. Tokens only in Windows Credential Manager. state.db is machine-local and gitignored.
- GitHub auto-push of `config/sync-state.json` (<500 KB, gzip fallback) every N min if changed.
- UI: tray (idle/syncing/paused/error colors), main window (pairs list, Add folder, Pause/Resume, Sync now), Activity (recent + failed + Retry), Restore, Settings (Advanced collapsed), error-only toasts.
## Non-goals
Explorer context menu, mobile, multi-account, LAN sync, encryption.
