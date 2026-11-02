# P02 Config System
Read MASTER.md COMMON RULES and SPEC.md. Module: `src-tauri/src/config/`.
## Files (relative to the app/repo root, found via `exe_dir()`; in dev use CARGO_MANIFEST_DIR/..)
- `config/config.toml` (committed), `config/config.local.toml` (gitignored, overrides), `.gitignore` entries for local toml, `data/`.
## Schema (serde structs, all with defaults)
```toml
[app]
parallel_transfers = 4        # 1..8
chunk_mib = 16
debounce_secs = 3
fallback_rescan_mins = 30
github_push_mins = 30
start_hidden = true
[limits]
upload_kbps = 0               # 0 = unlimited
download_kbps = 0
active_hours = ""             # "" or "08:00-23:00"
[governor]
cpu_pause_pct = 70
cpu_resume_pct = 50
battery_pause_pct = 20
pause_on_metered = false
[rules]
exclude = ["*.tmp","node_modules/**",".git/**","~$*","Thumbs.db"]
include = []
max_file_mb = 0
[policy]
conflict = "newer_wins"       # newer_wins|keep_both|ask
deletion = "drive_trash"      # ignore|drive_trash|delete
[[pair]]
id = "docs"
local = "%DOCS%/Work"
drive_folder_id = ""
mode = "two_way"              # upload|mirror|two_way
enabled = true
[github]
repo = "owner/name"
branch = "main"
path = "config/sync-state.json"
```
## Path variables
`%USERPROFILE% %DOCS% %DESKTOP% %DOWNLOADS% %APPDIR%` plus any `[vars]` table (e.g. `D = "D:\\"`). `config.local.toml` may override `[vars]` and any key, merged per-key; `[[pair]]` merged by `id`.
## API (exact)
```rust
pub fn load() -> Result<Config, AppError>;
pub fn save_shared(cfg:&Config) -> Result<(), AppError>;   // writes config.toml atomically (tmp+rename)
pub fn save_local(cfg:&LocalOverrides) -> Result<(), AppError>;
pub fn expand(path:&str, vars:&Vars) -> PathBuf;
pub fn watch_config(cb: impl Fn(Config)+Send+'static); // notify on config dir, 500ms debounce
```
Tauri commands: `get_config`, `update_config(patch)`, `add_pair`, `remove_pair`.
Create default files if missing. Validate ranges, return AppError::Config with the field name.
## Done-test
Unit tests: defaults load; override merge by pair id; variable expansion; invalid value rejected; atomic save. Editing config.toml by hand while app runs triggers callback once.
