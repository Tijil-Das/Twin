//! Phase T11: Explorer Overlay Toggle — Real-World Simulation
mod support;
use std::collections::HashMap;
use twin_lib::config::{PairEntry, PairMode};
use twin_lib::db::PairSyncStatus;
use twin_lib::overlay::{calculate_folder_statuses, normalize_folder_path, STATUS_SYNCED, STATUS_SYNCING};
use twin_lib::sync::{any_pair_syncing, is_pair_syncing, mark_pair_sync_end, mark_pair_sync_start};

fn make_pair(id: &str, local: &str) -> PairEntry {
    PairEntry { id: id.into(), local: local.into(), drive_folder_id: "root".into(), mode: PairMode::TwoWay, enabled: true, deletion: None, ..Default::default() }
}
fn make_status(pid: &str, q: i64, r: i64, d: i64, synced: bool) -> PairSyncStatus {
    PairSyncStatus { pair_id: pid.into(), queued: q, running: r, failed: 0, dirty: d, conflict: 0, synced: 100, total: 100, is_synced: synced, is_syncing: q > 0 || r > 0 || d > 0, deleted: 0, active_jobs: Vec::new(), last_activity: None, last_sync_ms: None }
}
fn clear_guards() { let _ = twin_lib::sync::ACTIVE_SYNC_PAIRS.lock(); }

#[test]
fn test_idle_green() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\Synced");
    let ps = vec![p.clone()];
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 0, 0, true));
    let ap: Vec<(String, String)> = Vec::new();
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    let n = normalize_folder_path("C:\\Users\\Test\\Synced");
    assert_eq!(res.get(&n), Some(&STATUS_SYNCED), "Idle synced should be green");
}
#[test]
fn test_queued_yellow() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\Syncing");
    let ps = vec![p.clone()];
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 3, 0, 0, false));
    let ap: Vec<(String, String)> = Vec::new();
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    let n = normalize_folder_path("C:\\Users\\Test\\Syncing");
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Queued should be yellow");
}
#[test]
fn test_running_yellow() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\Syncing");
    let ps = vec![p.clone()];
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 2, 0, false));
    let ap: Vec<(String, String)> = Vec::new();
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    let n = normalize_folder_path("C:\\Users\\Test\\Syncing");
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Running should be yellow");
}
#[test]
fn test_dirty_yellow() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\Dirty");
    let ps = vec![p.clone()];
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 0, 5, true));
    let ap: Vec<(String, String)> = Vec::new();
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    let n = normalize_folder_path("C:\\Users\\Test\\Dirty");
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Dirty should be yellow");
}
#[test]
fn test_guard_yellow() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\Guarded");
    let ps = vec![p.clone()];
    mark_pair_sync_start("p1");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 0, 0, true));
    let ap: Vec<(String, String)> = Vec::new();
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    let n = normalize_folder_path("C:\\Users\\Test\\Guarded");
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Active guard should be yellow even if DB says synced");
    mark_pair_sync_end("p1");
}
#[test]
fn test_active_paths_yellow() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\ActivePath");
    let ps = vec![p.clone()];
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 0, 0, true));
    let ap = vec![("p1".into(), "file.txt".into())];
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    let n = normalize_folder_path("C:\\Users\\Test\\ActivePath");
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Active paths should be yellow");
}
#[test]
fn test_toggle_yellow_to_green() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\Toggle");
    let ps = vec![p.clone()];
    let ap: Vec<(String, String)> = Vec::new();
    let n = normalize_folder_path("C:\\Users\\Test\\Toggle");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 1, 0, 0, false));
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Phase 1: syncing = yellow");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 0, 0, true));
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    assert_eq!(res.get(&n), Some(&STATUS_SYNCED), "Phase 2: complete = green");
}
#[test]
fn test_multi_pair_yellow() {
    clear_guards();
    let pa = make_pair("pa", "C:\\Users\\Test\\Shared");
    let pb = make_pair("pb", "C:\\Users\\Test\\Shared");
    let ps_vec = vec![pa.clone(), pb.clone()];
    let mut st = HashMap::new();
    st.insert("pa".into(), make_status("pa", 0, 0, 0, true));
    st.insert("pb".into(), make_status("pb", 0, 1, 0, false));
    let ap: Vec<(String, String)> = Vec::new();
    let res = calculate_folder_statuses(&ps_vec, &st, &ap, false);
    let n = normalize_folder_path("C:\\Users\\Test\\Shared");
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Shared folder, one syncing = yellow");
}
#[test]
fn test_disabled_ignored() {
    clear_guards();
    let dp = PairEntry { id: "p-dis".into(), local: "C:\\Users\\Test\\Disabled".into(), enabled: false, ..Default::default() };
    let ps_vec = vec![dp];
    let mut st = HashMap::new(); st.insert("p-dis".into(), make_status("p-dis", 5, 0, 0, false));
    let ap: Vec<(String, String)> = Vec::new();
    let res = calculate_folder_statuses(&ps_vec, &st, &ap, false);
    assert!(res.is_empty(), "Disabled pair should produce no entries");
}
#[test]
fn test_cooldown_yellow() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\Cooldown");
    let ps = vec![p.clone()];
    let ap: Vec<(String, String)> = Vec::new();
    let n = normalize_folder_path("C:\\Users\\Test\\Cooldown");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 1, 0, 0, false));
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Phase 1: syncing = yellow");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 0, 0, true));
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "Phase 2: cooldown keeps yellow");
}
#[test]
fn test_no_db_entry_guard_yellow() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\NoDb");
    let ps = vec![p.clone()];
    mark_pair_sync_start("p1");
    let st: HashMap<String, PairSyncStatus> = HashMap::new();
    let ap: Vec<(String, String)> = Vec::new();
    let res = calculate_folder_statuses(&ps, &st, &ap, false);
    let n = normalize_folder_path("C:\\Users\\Test\\NoDb");
    assert_eq!(res.get(&n), Some(&STATUS_SYNCING), "No DB entry + active guard = yellow");
    mark_pair_sync_end("p1");
}
#[test]
fn test_upload_lifecycle() {
    clear_guards();
    let p = make_pair("p1", "C:\\Users\\Test\\Upload");
    let ps = vec![p.clone()];
    let ap: Vec<(String, String)> = Vec::new();
    let n = normalize_folder_path("C:\\Users\\Test\\Upload");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 0, 0, true));
    assert_eq!(calculate_folder_statuses(&ps, &st, &ap, false).get(&n), Some(&STATUS_SYNCED), "Step1 green");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 1, 0, 0, false));
    assert_eq!(calculate_folder_statuses(&ps, &st, &ap, false).get(&n), Some(&STATUS_SYNCING), "Step2 queued yellow");
    mark_pair_sync_start("p1");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 1, 0, false));
    assert_eq!(calculate_folder_statuses(&ps, &st, &ap, false).get(&n), Some(&STATUS_SYNCING), "Step3 running+guard yellow");
    mark_pair_sync_end("p1");
    let mut st = HashMap::new(); st.insert("p1".into(), make_status("p1", 0, 0, 0, true));
    assert_eq!(calculate_folder_statuses(&ps, &st, &ap, false).get(&n), Some(&STATUS_SYNCED), "Step4 complete green");
}
#[test]
fn test_is_pair_syncing_state() {
    clear_guards();
    assert!(!is_pair_syncing("p-none"));
    mark_pair_sync_start("p-t"); assert!(is_pair_syncing("p-t"));
    mark_pair_sync_start("p-t"); assert!(is_pair_syncing("p-t"));
    mark_pair_sync_end("p-t"); assert!(is_pair_syncing("p-t"));
    mark_pair_sync_end("p-t"); assert!(!is_pair_syncing("p-t"));
}
#[test]
fn test_any_pair_syncing_state() {
    clear_guards();
    assert!(!any_pair_syncing());
    mark_pair_sync_start("pa"); assert!(any_pair_syncing());
    mark_pair_sync_start("pb"); assert!(any_pair_syncing());
    mark_pair_sync_end("pa"); assert!(any_pair_syncing());
    mark_pair_sync_end("pb"); assert!(!any_pair_syncing());
}
