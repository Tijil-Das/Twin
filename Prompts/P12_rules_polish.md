# P12 Autostart, Rules Wiring, Bandwidth, Drive Extras, Polish
Read MASTER.md COMMON RULES and SPEC.md. Touch only: `commands.rs`, `main.rs` wiring, `drive/extras.rs`, `src/screens/Settings*`, `src/screens/Restore*`.
## Do (each item independent; implement exactly)
1. **Autostart**: `tauri-plugin-autostart` with args `--hidden`; commands `get_autostart`, `set_autostart(bool)`. Reflect in Settings toggle. No Task Scheduler.
2. **Rules wiring**: ensure P06 Rules is built from config and rebuilt on config change; changing rules enqueues a rescan.
3. **Bandwidth/active hours**: wire config changes live into limiter and governor (no restart).
4. **Share link**: `drive_share_link(file_id, role: reader|writer, anyone:bool)` -> POST `/files/{id}/permissions` then GET `webViewLink`; copy to clipboard from UI via `navigator.clipboard`.
5. **Storage quota**: `GET /about?fields=storageQuota` -> `{limit,usage,usageInDrive,usageInDriveTrash}`; Settings shows a true bar (usage/limit); cache 10 min.
6. **Shared drives**: `list_shared_drives` (`drives.list`), Drive browser shows "My Drive" and shared drives roots; all Drive calls pass `supportsAllDrives=true&includeItemsFromAllDrives=true`.
7. **Metadata**: `set_description(file_id,text)`, `set_starred(file_id,bool)` via files.update; show star and description in Restore browser.
8. **Search**: `drive_search(query, mime?, after?)` builds q safely (escape `'` and `\`), shown in Restore tab search box.
9. **Dry-run mode**: config `[app] dry_run=false`; when true, JobRunners log what they WOULD do into activity (result="dry-run") and perform no writes anywhere.
10. **Error toasts only**: tauri-plugin-notification for persistent failures (job gave up after 8 tries), max 1 notification per 10 min.
11. Log file: `data/tether.log`, rotate at 2 MB keep 2 files, hand-written (no new crates).
## Done-test
Each command callable from the UI and returns valid data against wiremock; dry-run produces zero filesystem/network writes (assert with a recording fake); autostart toggle creates/removes the Run registry value; clippy + tsc clean.
