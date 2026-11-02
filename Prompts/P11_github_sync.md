# P11 GitHub Config Sync
Read MASTER.md COMMON RULES and SPEC.md. Module `src-tauri/src/github/`. API docs: https://docs.github.com/en/rest/repos/contents
## Token
Stored in Credential Manager (service `tether`, key `github_token`). Fine-grained PAT, repo-only, `Contents: Read and write`. Commands `gh_set_token`, `gh_clear_token`. Never log it.
## What gets pushed: `config/sync-state.json` (and ONLY this file + `config/config.toml` if changed)
```json
{"version":1,"updated":"ISO","machine":"HOSTNAME",
 "pairs":[{"id":"docs","drive_folder_id":"...","mode":"two_way","last_sync_ms":0,"changes_page_token":"..."}],
 "manifest":{"docs":{"count":1234,"bytes":987654321,"root_hash":"blake3-of-sorted(rel_path|md5)"}}}
```
Do NOT include logs, activity, tokens, local absolute paths, per-file lists (hash only). Build from Db. Pretty-print off. If serialized > 500 KB, gzip and push as `sync-state.json.gz` and delete the plain one; if gzip > 500 KB refuse with AppError::Other("state too large").
## Push
Every `github_push_mins` minutes (single timer, only if token+repo set, governor Running): compute JSON, compare blake3 against last pushed hash (kept in memory + `data/gh_last.txt`); unchanged -> skip. Else `GET /repos/{repo}/contents/{path}?ref={branch}` -> sha (404 = create). `PUT` with `message:"tether state <machine> <time>"`, `content` base64, `sha`, `branch`. On 409/422 sha conflict: re-GET and re-PUT once.
Headers: `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: tether`.
## Pull
`pull_now()`: GET file; if remote `updated` is newer than local manifest and machine differs, merge: take pairs missing locally (add with empty local path flagged `needs_local_path` for the user to map via `config.local.toml`), update drive_folder_id/mode if absent locally; set `changes_page_token` ONLY if the local pair has none. Last-write-wins by `updated` timestamp for conflicting scalar fields. Also fetch `config/config.toml` if newer (compare git blob sha stored in `data/gh_cfg_sha.txt`) and write atomically.
Run `pull_now` once at startup (if token set) before the first scan.
Commands: `gh_push_now`, `gh_pull_now`, `gh_status`.
## Done-test
Wiremock tests: create vs update path, sha conflict retry, unchanged skip, >500 KB gzip path, refuse oversize, pull merge rules, token never in logs (test log capture). Manual: push from machine A, clone repo on machine B, pull, pairs appear.
