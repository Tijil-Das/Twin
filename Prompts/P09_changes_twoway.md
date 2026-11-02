# P09 Changes API + Two-way Sync + Conflicts
Read MASTER.md COMMON RULES and SPEC.md. Module `src-tauri/src/sync/`. Docs: https://developers.google.com/drive/api/guides/manage-changes
## Remote change feed
- First run per pair: `changes.getStartPageToken` (supportsAllDrives=true) store in pair_meta BEFORE the initial full listing, then do the initial listing of the Drive folder tree (pageSize=1000, fields `nextPageToken,files(id,name,parents,md5Checksum,modifiedTime,size,mimeType,trashed)`) and reconcile with Db.
- Afterwards: `changes.list?pageToken=...&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,parents,md5Checksum,modifiedTime,size,mimeType,trashed))&pageSize=1000`. Poll with a single task every 60 s ONLY while the app has at least one two_way/mirror pair AND governor is Running (await `checkpoint`). Persist `newStartPageToken` only after all changes were applied.
- Filter changes to files whose ancestor chain contains the pair's Drive folder (cache parent lookups in a HashMap, resolve unknown parents with files.get fields `id,parents`).
## Decision table (per file; L=local changed since last sync, R=remote changed since last sync, based on Db md5/mtime vs current)
| L | R | Action |
|---|---|--------|
| no | no | nothing |
| yes | no | upload |
| no | yes | download |
| yes | yes | if md5 equal: mark synced; else apply `policy.conflict` |
| deleted L | no R | per `policy.deletion` (upload mode ignore; two_way -> trash remote) |
| no L | deleted R | move local file to Recycle Bin? NOT available: move it to `<pair>/.tether-trash/yyyy-mm-dd/` |
Mode `upload`: only L actions. Mode `mirror`: remote forced to match local (R changes are reverted by re-upload; extra remote files trashed). Mode `two_way`: full table.
## Conflict policies
- `newer_wins`: compare mtime (remote modifiedTime vs local mtime), loser goes to revision (remote) or `.tether-trash` (local).
- `keep_both`: rename local to `name (conflict <machine> yyyy-mm-dd hhmmss).ext`, download remote to original name, upload the renamed one.
- `ask`: set state `conflict`, emit `sync://conflict {pair,rel_path}`; UI resolves via command `resolve_conflict(pair,rel,choice: local|remote|both)`.
Echo suppression: when we write a local file from a download, record it in an in-memory "self-written" set (path+mtime) for 10 s so the watcher ignores it; likewise remote changes caused by our own upload are skipped by comparing md5 to Db.
Renames/moves: local rename detected by same md5+size delete+create within debounce window -> Drive `files.update addParents/removeParents/name` instead of reupload.
## API
`pub async fn run_pair_cycle(pair:&Pair, ctx:&Ctx)->Result<CycleReport,AppError>`
## Done-test
Table-driven unit tests covering every row of the decision table and each conflict policy using in-memory fakes for Drive and filesystem; echo suppression test; rename detection test; token persisted only after success (crash-simulation test).
