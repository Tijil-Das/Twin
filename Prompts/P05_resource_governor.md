# P05 Resource Governor (lightweight guarantee)
Read MASTER.md COMMON RULES and SPEC.md. Module `src-tauri/src/governor/`. Crates: sysinfo, windows-sys (Win32_System_Power), tokio.
## Behavior
- One background task sampling every 2 s (ONLY while there is active work or state is Throttled; otherwise sleep 10 s). Uses `sysinfo::System::refresh_cpu_usage` on a single reused `System` object (never recreate).
- Global system CPU (excluding nothing). State machine: `Running` -> `Throttled` when CPU > `cpu_pause_pct` for 5 consecutive seconds; `Throttled` -> `Running` when CPU < `cpu_resume_pct` for 5 consecutive seconds. (Hysteresis prevents flapping.)
- Battery: `GetSystemPowerStatus` (windows-sys). Throttled if on battery AND percent < `battery_pause_pct`.
- Active hours: if `limits.active_hours` set and now is outside, state `Scheduled`.
- Manual: `pause()`/`resume()`, state `UserPaused`.
- Metered: if `pause_on_metered` true, user toggles manually via command (no auto detection).
- Soft degrade: when CPU is between resume and pause thresholds, effective concurrency = max(1, configured/2); above pause = 0.
## API (exact)
```rust
pub enum GovState { Running, Throttled(Reason), Scheduled, UserPaused }
pub struct Governor; // Arc-cloneable
impl Governor {
 pub fn new(cfg: GovernorCfg)->Self;
 pub fn state(&self)->GovState;
 pub fn effective_concurrency(&self, configured:usize)->usize;
 pub async fn checkpoint(&self);        // returns immediately if Running; otherwise awaits (tokio::sync::watch) until Running. No polling.
 pub fn pause(&self); pub fn resume(&self);
 pub fn subscribe(&self)->watch::Receiver<GovState>;
}
```
Emit Tauri event `governor://state` on change and update tray (amber when not Running). Commands: `gov_state`, `gov_pause`, `gov_resume`.
## Done-test
Unit tests with a fake CPU source trait (inject samples): throttles after 5 s high, resumes after 5 s low, no flapping at 60%, battery rule, active-hours rule, `checkpoint` blocks and unblocks. Manual: run a CPU burner, app work pauses; stop burner, resumes. Governor's own CPU < 0.1% idle.
