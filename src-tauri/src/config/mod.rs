use std::path::{Path, PathBuf};
use std::fs;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

// ── Path variable expansion ────────────────────────────────────────────────

pub type Vars = std::collections::HashMap<String, String>;

/// Built-in path variables resolved at runtime.
fn builtin_vars() -> Vars {
    let mut m = Vars::new();
    if let Ok(v) = std::env::var("USERPROFILE") {
        m.insert("USERPROFILE".into(), v);
    }
    if let Some(docs) = dirs_from_env("DOCS").or_else(known_docs) {
        m.insert("DOCS".into(), docs);
    }
    if let Some(desk) = dirs_from_env("DESKTOP").or_else(known_desktop) {
        m.insert("DESKTOP".into(), desk);
    }
    if let Some(dl) = dirs_from_env("DOWNLOADS").or_else(known_downloads) {
        m.insert("DOWNLOADS".into(), dl);
    }
    // %APPDIR% = directory of the executable (or manifest dir in dev)
    let app_dir = exe_dir();
    m.insert("APPDIR".into(), app_dir.to_string_lossy().into_owned());
    m
}

fn dirs_from_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn known_docs() -> Option<String> {
    let up = std::env::var("USERPROFILE").ok()?;
    Some(format!("{up}\\Documents"))
}

fn known_desktop() -> Option<String> {
    let up = std::env::var("USERPROFILE").ok()?;
    Some(format!("{up}\\Desktop"))
}

fn known_downloads() -> Option<String> {
    let up = std::env::var("USERPROFILE").ok()?;
    Some(format!("{up}\\Downloads"))
}

/// Expand `%VAR%` placeholders in `path` using `vars`.
pub fn expand(path: &str, vars: &Vars) -> PathBuf {
    let mut result = path.to_owned();
    for (k, v) in vars {
        result = result.replace(&format!("%{k}%"), v);
    }
    PathBuf::from(result)
}

// ── Schema ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppSection {
    pub parallel_transfers: u8,
    pub chunk_mib: u32,
    pub debounce_secs: u64,
    pub fallback_rescan_mins: u64,
    pub github_push_mins: u64,
    pub start_hidden: bool,
}

impl Default for AppSection {
    fn default() -> Self {
        Self {
            parallel_transfers: 4,
            chunk_mib: 16,
            debounce_secs: 3,
            fallback_rescan_mins: 30,
            github_push_mins: 30,
            start_hidden: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct LimitsSection {
    pub upload_kbps: u64,
    pub download_kbps: u64,
    pub active_hours: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GovernorSection {
    pub cpu_pause_pct: u8,
    pub cpu_resume_pct: u8,
    pub battery_pause_pct: u8,
    pub pause_on_metered: bool,
}

impl Default for GovernorSection {
    fn default() -> Self {
        Self {
            cpu_pause_pct: 70,
            cpu_resume_pct: 50,
            battery_pause_pct: 20,
            pause_on_metered: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RulesSection {
    pub exclude: Vec<String>,
    pub include: Vec<String>,
    pub max_file_mb: u64,
}

impl Default for RulesSection {
    fn default() -> Self {
        Self {
            exclude: vec![
                "*.tmp".into(),
                "node_modules/**".into(),
                ".git/**".into(),
                "~$*".into(),
                "Thumbs.db".into(),
            ],
            include: vec![],
            max_file_mb: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    #[default]
    NewerWins,
    KeepBoth,
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeletionPolicy {
    Ignore,
    #[default]
    DriveTrash,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct PolicySection {
    pub conflict: ConflictPolicy,
    pub deletion: DeletionPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PairEntry {
    pub id: String,
    pub local: String,
    pub drive_folder_id: String,
    pub mode: PairMode,
    pub enabled: bool,
}

impl Default for PairEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            local: String::new(),
            drive_folder_id: String::new(),
            mode: PairMode::TwoWay,
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairMode {
    Upload,
    Mirror,
    #[default]
    TwoWay,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GitHubSection {
    pub repo: String,
    pub branch: String,
    pub path: String,
}

impl Default for GitHubSection {
    fn default() -> Self {
        Self {
            repo: "owner/name".into(),
            branch: "main".into(),
            path: "config/sync-state.json".into(),
        }
    }
}

/// User-defined path variable table from config.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct VarsSection(pub std::collections::HashMap<String, String>);

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Config {
    pub app: AppSection,
    pub limits: LimitsSection,
    pub governor: GovernorSection,
    pub rules: RulesSection,
    pub policy: PolicySection,
    #[serde(rename = "pair", default)]
    pub pairs: Vec<PairEntry>,
    pub github: GitHubSection,
    pub vars: VarsSection,
}

impl Config {
    /// Build the full variable map (builtins + user [vars]).
    pub fn vars_map(&self) -> Vars {
        let mut m = builtin_vars();
        for (k, v) in &self.vars.0 {
            m.insert(k.clone(), v.clone());
        }
        m
    }

    /// Validate numeric ranges; return Err with field name on failure.
    pub fn validate(&self) -> Result<(), AppError> {
        let app = &self.app;
        if !(1..=8).contains(&app.parallel_transfers) {
            return Err(AppError::Config(
                "app.parallel_transfers must be 1..8".into(),
            ));
        }
        if app.chunk_mib == 0 {
            return Err(AppError::Config("app.chunk_mib must be > 0".into()));
        }
        let gov = &self.governor;
        if gov.cpu_resume_pct >= gov.cpu_pause_pct {
            return Err(AppError::Config(
                "governor.cpu_resume_pct must be < cpu_pause_pct".into(),
            ));
        }
        if gov.cpu_pause_pct > 100 || gov.cpu_resume_pct > 100 || gov.battery_pause_pct > 100 {
            return Err(AppError::Config(
                "governor percentage values must be 0..100".into(),
            ));
        }
        Ok(())
    }
}

/// Local overrides file — any subset of Config fields, plus [vars].
/// We deserialise into a raw toml Table and merge key-by-key.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LocalOverrides {
    #[serde(flatten)]
    pub values: toml::Table,
}

// ── File locations ─────────────────────────────────────────────────────────

/// Directory of the executable; in dev (`CARGO_MANIFEST_DIR` set) use
/// `CARGO_MANIFEST_DIR/..` so both `cargo run` and the installed binary
/// resolve `config/` next to the repo root / app root.
pub fn exe_dir() -> PathBuf {
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        // src-tauri/ -> parent = repo root
        PathBuf::from(manifest.clone())
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(manifest))
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

fn config_dir() -> PathBuf {
    exe_dir().join("config")
}

fn shared_path() -> PathBuf {
    config_dir().join("config.toml")
}

fn local_path() -> PathBuf {
    config_dir().join("config.local.toml")
}

// ── Load / save ────────────────────────────────────────────────────────────

/// Load config: parse shared toml, then deep-merge local overrides.
pub fn load() -> Result<Config, AppError> {
    let dir = config_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::Config(format!("cannot create config dir: {e}")))?;
    }

    let shared_p = shared_path();
    if !shared_p.exists() {
        let default_str = toml::to_string_pretty(&Config::default())
            .map_err(|e| AppError::Config(format!("serialize default config: {e}")))?;
        fs::write(&shared_p, default_str)
            .map_err(|e| AppError::Config(format!("write default config.toml: {e}")))?;
    }

    let shared_str = fs::read_to_string(&shared_p)
        .map_err(|e| AppError::Config(format!("read config.toml: {e}")))?;
    let mut base: toml::Value = toml::from_str(&shared_str)
        .map_err(|e| AppError::Config(format!("parse config.toml: {e}")))?;

    // Merge local overrides if present
    let local_p = local_path();
    if local_p.exists() {
        let local_str = fs::read_to_string(&local_p)
            .map_err(|e| AppError::Config(format!("read config.local.toml: {e}")))?;
        if !local_str.trim().is_empty() && !local_str.trim_start().starts_with('#') {
            let local_val: toml::Value = toml::from_str(&local_str)
                .map_err(|e| AppError::Config(format!("parse config.local.toml: {e}")))?;
            merge_toml(&mut base, local_val);
        }
    }

    let cfg: Config = base
        .try_into()
        .map_err(|e| AppError::Config(format!("deserialize config: {e}")))?;

    cfg.validate()?;
    Ok(cfg)
}

/// Deep-merge `patch` into `base`. For `[[pair]]` arrays, merge by `id`.
fn merge_toml(base: &mut toml::Value, patch: toml::Value) {
    use toml::Value;
    match (base, patch) {
        (Value::Table(b), Value::Table(p)) => {
            for (k, v) in p {
                if k == "pair" {
                    // Merge [[pair]] arrays by id
                    merge_pair_array(b.entry(k).or_insert(Value::Array(vec![])), v);
                } else {
                    let entry = b.entry(k).or_insert(Value::Table(Default::default()));
                    merge_toml(entry, v);
                }
            }
        }
        (base, patch) => *base = patch,
    }
}

fn merge_pair_array(base: &mut toml::Value, patch: toml::Value) {
    use toml::Value;
    let patch_arr = match patch {
        Value::Array(a) => a,
        _ => return,
    };
    let base_arr = match base {
        Value::Array(a) => a,
        _ => return,
    };
    for patch_item in patch_arr {
        let patch_id = patch_item
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        if let Some(id) = patch_id {
            if let Some(existing) = base_arr
                .iter_mut()
                .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            {
                merge_toml(existing, patch_item);
            } else {
                base_arr.push(patch_item);
            }
        } else {
            base_arr.push(patch_item);
        }
    }
}

/// Write `config.toml` atomically via a temp file + rename.
pub fn save_shared(cfg: &Config) -> Result<(), AppError> {
    let text = toml::to_string_pretty(cfg)
        .map_err(|e| AppError::Config(format!("serialize config: {e}")))?;
    atomic_write(&shared_path(), text.as_bytes())
}

/// Write `config.local.toml` atomically.
pub fn save_local(cfg: &LocalOverrides) -> Result<(), AppError> {
    let text = toml::to_string_pretty(cfg)
        .map_err(|e| AppError::Config(format!("serialize local config: {e}")))?;
    atomic_write(&local_path(), text.as_bytes())
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), AppError> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Config("no parent dir for config file".into()))?;
    fs::create_dir_all(dir)
        .map_err(|e| AppError::Config(format!("create config dir: {e}")))?;

    // Write to a temp file in the same directory, then rename (atomic on same FS).
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, data).map_err(|e| AppError::Config(format!("write tmp config: {e}")))?;
    fs::rename(&tmp, path).map_err(|e| AppError::Config(format!("rename tmp config: {e}")))?;
    Ok(())
}

// ── Config watcher ─────────────────────────────────────────────────────────

/// Watch the config directory; call `cb` with a freshly loaded `Config`
/// whenever `config.toml` or `config.local.toml` changes.
/// Debounce: 500 ms. Runs on a background thread; never blocks the caller.
pub fn watch_config(cb: impl Fn(Config) + Send + Sync + 'static) {
    use notify_debouncer_full::{new_debouncer, notify::{RecursiveMode, Watcher}};
    use std::time::Duration;

    let dir = config_dir();
    std::thread::spawn(move || {
        let mut debouncer = match new_debouncer(
            Duration::from_millis(500),
            None,
            move |res: notify_debouncer_full::DebounceEventResult| match res {
                Ok(_events) => match load() {
                    Ok(cfg) => cb(cfg),
                    Err(e) => tracing::warn!("Config reload error: {e}"),
                },
                Err(e) => tracing::warn!("Config watcher error: {e:?}"),
            },
        ) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("Cannot create config watcher: {e}");
                return;
            }
        };

        if let Err(e) = debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive) {
            tracing::error!("Cannot watch config dir {dir:?}: {e}");
            return;
        }

        tracing::info!("Config watcher active on {dir:?}");
        // Keep thread alive — debouncer lives as long as this scope.
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_config() -> Result<Config, AppError> {
    load()
}

#[tauri::command]
pub fn update_config(patch: toml::Value) -> Result<Config, AppError> {
    let mut current = load()?;
    let mut base = toml::Value::try_from(&current)
        .map_err(|e| AppError::Config(format!("serialize current config: {e}")))?;
    merge_toml(&mut base, patch);
    current = base
        .try_into()
        .map_err(|e| AppError::Config(format!("deserialize patched config: {e}")))?;
    current.validate()?;
    save_shared(&current)?;
    Ok(current)
}

#[tauri::command]
pub fn add_pair(pair: PairEntry) -> Result<Config, AppError> {
    let mut cfg = load()?;
    if cfg.pairs.iter().any(|p| p.id == pair.id) {
        return Err(AppError::Config(format!(
            "pair id '{}' already exists",
            pair.id
        )));
    }
    cfg.pairs.push(pair);
    save_shared(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub fn remove_pair(id: String) -> Result<Config, AppError> {
    let mut cfg = load()?;
    let before = cfg.pairs.len();
    cfg.pairs.retain(|p| p.id != id);
    if cfg.pairs.len() == before {
        return Err(AppError::Config(format!("pair id '{id}' not found")));
    }
    save_shared(&cfg)?;
    Ok(cfg)
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Override CARGO_MANIFEST_DIR so exe_dir() points to a temp dir.
    fn with_config_dir<F: FnOnce(&Path)>(f: F) {
        let tmp = tempfile::tempdir().unwrap();
        // exe_dir() reads CARGO_MANIFEST_DIR and goes to its parent;
        // so we create a fake src-tauri subdir and set the var to it.
        let fake_src = tmp.path().join("src-tauri");
        fs::create_dir_all(&fake_src).unwrap();
        fs::create_dir_all(tmp.path().join("config")).unwrap();

        // We call load() / save_shared() directly with a path arg to
        // avoid the env-var threading issues in tests. Instead test the
        // primitives directly.
        f(tmp.path());
    }

    #[test]
    fn defaults_load_and_validate() {
        let cfg = Config::default();
        cfg.validate().unwrap();
        assert_eq!(cfg.app.parallel_transfers, 4);
        assert_eq!(cfg.governor.cpu_pause_pct, 70);
        assert_eq!(cfg.policy.conflict, ConflictPolicy::NewerWins);
    }

    #[test]
    fn invalid_parallel_transfers_rejected() {
        let mut cfg = Config::default();
        cfg.app.parallel_transfers = 0;
        assert!(cfg.validate().is_err());
        cfg.app.parallel_transfers = 9;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn invalid_governor_rejected() {
        let mut cfg = Config::default();
        cfg.governor.cpu_resume_pct = 80;
        cfg.governor.cpu_pause_pct = 70;
        assert!(cfg.validate().is_err()); // resume >= pause
    }

    #[test]
    fn variable_expansion() {
        let mut vars = Vars::new();
        vars.insert("DOCS".into(), "C:\\Users\\Test\\Documents".into());
        vars.insert("D".into(), "D:\\".into());
        let result = expand("%DOCS%/Work", &vars);
        assert_eq!(result, PathBuf::from("C:\\Users\\Test\\Documents/Work"));
        let result2 = expand("%D%Projects", &vars);
        assert_eq!(result2, PathBuf::from("D:\\Projects"));
    }

    #[test]
    fn merge_pair_by_id() {
        let base_toml = r#"
[app]
parallel_transfers = 4

[[pair]]
id = "docs"
local = "C:\\Old"
drive_folder_id = "abc"
mode = "two_way"
enabled = true
"#;
        let local_toml = r#"
[[pair]]
id = "docs"
local = "C:\\New"
drive_folder_id = "abc"
mode = "two_way"
enabled = true

[[pair]]
id = "photos"
local = "C:\\Photos"
drive_folder_id = "def"
mode = "upload"
enabled = true
"#;
        let mut base: toml::Value = toml::from_str(base_toml).unwrap();
        let patch: toml::Value = toml::from_str(local_toml).unwrap();
        merge_toml(&mut base, patch);
        let cfg: Config = base.try_into().unwrap();
        assert_eq!(cfg.pairs.len(), 2);
        let docs = cfg.pairs.iter().find(|p| p.id == "docs").unwrap();
        assert_eq!(docs.local, "C:\\New"); // overridden
        assert!(cfg.pairs.iter().any(|p| p.id == "photos")); // added
    }

    #[test]
    fn atomic_save_roundtrip() {
        with_config_dir(|dir| {
            let cfg_path = dir.join("config").join("config.toml");
            let mut cfg = Config::default();
            cfg.app.parallel_transfers = 6;
            atomic_write(&cfg_path, toml::to_string_pretty(&cfg).unwrap().as_bytes())
                .unwrap();
            let text = fs::read_to_string(&cfg_path).unwrap();
            let loaded: Config = toml::from_str(&text).unwrap();
            assert_eq!(loaded.app.parallel_transfers, 6);
        });
    }
}

