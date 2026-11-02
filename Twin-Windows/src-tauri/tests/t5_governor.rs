//! Phase T5: Resource Governor & Lightweight Guarantees
//! Target: `src-tauri/src/governor/` (CPU, battery, hysteresis, concurrency scaling, checkpoint).

use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::timeout;
use twin_lib::governor::{GovState, Governor, GovernorCfg, Reason};

fn make_test_cfg() -> GovernorCfg {
    GovernorCfg {
        cpu_pause_pct: 70,
        cpu_resume_pct: 50,
        battery_pause_pct: 20,
        pause_on_metered: true,
        active_hours: String::new(),
    }
}

// ── 1. Scripted CPU Traces ────────────────────────────────────────────────────

#[test]
fn test_scripted_cpu_traces_hysteresis_and_transitions() {
    let gov = Governor::new(make_test_cfg());
    assert_eq!(gov.state(), GovState::Running);

    // 1. Spikes < 5 s (2 ticks at 90%, then drops to 40%) -> should NOT throttle
    assert_eq!(gov.step_tick(90.0), GovState::Running);
    assert_eq!(gov.step_tick(92.0), GovState::Running);
    assert_eq!(gov.step_tick(40.0), GovState::Running);
    assert_eq!(gov.state(), GovState::Running);

    // 2. Sustained high CPU (3 consecutive ticks >= 70%) -> throttles on 3rd tick
    assert_eq!(gov.step_tick(75.0), GovState::Running);
    assert_eq!(gov.step_tick(80.0), GovState::Running);
    assert_eq!(gov.step_tick(85.0), GovState::Throttled(Reason::HighCpu));
    assert_eq!(gov.state(), GovState::Throttled(Reason::HighCpu));

    // 3. Flapping between 55% and 65% while throttled -> remains throttled (hysteresis zone)
    for _ in 0..10 {
        assert_eq!(gov.step_tick(65.0), GovState::Throttled(Reason::HighCpu));
        assert_eq!(gov.step_tick(55.0), GovState::Throttled(Reason::HighCpu));
    }

    // 4. Recovery: requires 3 consecutive ticks below 50%
    assert_eq!(gov.step_tick(45.0), GovState::Throttled(Reason::HighCpu));
    assert_eq!(gov.step_tick(30.0), GovState::Throttled(Reason::HighCpu));
    assert_eq!(gov.step_tick(25.0), GovState::Running);
    assert_eq!(gov.state(), GovState::Running);

    // 5. Flapping between 65% and 75% -> does not enter throttle unless 3 consecutive > 70%
    assert_eq!(gov.step_tick(72.0), GovState::Running);
    assert_eq!(gov.step_tick(68.0), GovState::Running); // resets high_cpu_ticks counter
    assert_eq!(gov.step_tick(73.0), GovState::Running);
    assert_eq!(gov.step_tick(69.0), GovState::Running);
    assert_eq!(gov.state(), GovState::Running);
}

// ── 2. Battery & Power Matrix ─────────────────────────────────────────────────

#[test]
fn test_battery_and_power_state_matrix() {
    let gov = Governor::new(make_test_cfg());

    // AC power, battery at 10% (below 20%) -> Running (on AC, low battery is fine)
    gov.set_battery_override(Some((false, 10)));
    assert_eq!(gov.step_tick(20.0), GovState::Running);

    // Switch to battery, 10% -> Throttled(Battery)
    gov.set_battery_override(Some((true, 10)));
    assert_eq!(gov.step_tick(20.0), GovState::Throttled(Reason::Battery));

    // Battery charges to 25% (>= 20%) on battery -> Running
    gov.set_battery_override(Some((true, 25)));
    assert_eq!(gov.step_tick(20.0), GovState::Running);

    // Plug in AC charger -> Running
    gov.set_battery_override(Some((false, 15)));
    assert_eq!(gov.step_tick(20.0), GovState::Running);

    // Reset override
    gov.set_battery_override(None);
}

// ── 3. Active Hours & Metered Matrix ──────────────────────────────────────────

#[test]
fn test_active_hours_and_metered_matrix() {
    let gov = Governor::new(make_test_cfg());

    // Inside active hours -> Running
    gov.set_active_hours_override(Some(true));
    assert_eq!(gov.step_tick(20.0), GovState::Running);

    // Outside active hours -> Scheduled
    gov.set_active_hours_override(Some(false));
    assert_eq!(gov.step_tick(20.0), GovState::Scheduled);

    // Back to active
    gov.set_active_hours_override(Some(true));
    assert_eq!(gov.step_tick(20.0), GovState::Running);

    // User metered network enabled
    gov.set_metered(true);
    assert_eq!(gov.state(), GovState::Throttled(Reason::Metered));
    gov.set_metered(false);
    assert_eq!(gov.state(), GovState::Running);

    // User manual pause takes highest precedence
    gov.pause();
    assert_eq!(gov.state(), GovState::UserPaused);
    // Even high CPU or metered won't mask UserPaused
    gov.set_metered(true);
    assert_eq!(gov.state(), GovState::UserPaused);
    gov.resume();
    assert_eq!(gov.state(), GovState::Throttled(Reason::Metered));
    gov.set_metered(false);
    assert_eq!(gov.state(), GovState::Running);
}

// ── 4. Concurrency Scaling Matrix ─────────────────────────────────────────────

#[test]
fn test_concurrency_scaling_matrix() {
    let gov = Governor::new(make_test_cfg());

    // When Running at low CPU (< 50%): full concurrency
    gov.step_tick(30.0);
    for n in [16, 8, 4, 2, 1] {
        assert_eq!(gov.effective_concurrency(n), n);
    }

    // When Running in soft-degrade zone (50% <= CPU < 70%): concurrency halved
    gov.step_tick(60.0);
    assert_eq!(gov.effective_concurrency(16), 8);
    assert_eq!(gov.effective_concurrency(8), 4);
    assert_eq!(gov.effective_concurrency(4), 2);
    assert_eq!(gov.effective_concurrency(2), 1);
    assert_eq!(gov.effective_concurrency(1), 1); // min 1 worker while running

    // When Throttled by CPU: 0 workers
    gov.step_tick(80.0);
    gov.step_tick(80.0);
    gov.step_tick(80.0);
    assert_eq!(gov.effective_concurrency(16), 0);
    assert_eq!(gov.effective_concurrency(8), 0);

    // When UserPaused: 0 workers
    gov.resume();
    gov.step_tick(20.0);
    gov.step_tick(20.0);
    gov.step_tick(20.0);
    assert_eq!(gov.effective_concurrency(8), 8);
    gov.pause();
    assert_eq!(gov.effective_concurrency(8), 0);
}

// ── 5. Checkpoint & Non-Polling Latency ────────────────────────────────────────

#[tokio::test]
async fn test_checkpoint_latency_and_multi_worker_unblock() {
    let gov = Arc::new(Governor::new(make_test_cfg()));

    // Fast path: Running -> latency under 1ms
    let t0 = Instant::now();
    for _ in 0..100 {
        gov.checkpoint().await;
    }
    let elapsed = t0.elapsed();
    assert!(
        elapsed < Duration::from_millis(50),
        "100 Running checkpoints took {elapsed:?}, expected < 50ms"
    );

    // Pause governor
    gov.pause();
    assert_eq!(gov.state(), GovState::UserPaused);

    // Spawn 16 concurrent worker tasks waiting on checkpoint()
    let mut handles = Vec::new();
    for _ in 0..16 {
        let g = Arc::clone(&gov);
        handles.push(tokio::spawn(async move {
            g.checkpoint().await;
            true
        }));
    }

    // Give workers time to arrive and sleep on watch receiver
    tokio::time::sleep(Duration::from_millis(50)).await;
    for h in &handles {
        assert!(!h.is_finished(), "Worker should be blocked on checkpoint");
    }

    // Resume governor
    let resume_t0 = Instant::now();
    gov.resume();

    // All 16 workers must unblock promptly without polling
    for h in handles {
        let res = timeout(Duration::from_millis(300), h)
            .await
            .expect("worker failed to unblock within 300ms")
            .expect("worker task panicked");
        assert!(res);
    }
    let unblock_time = resume_t0.elapsed();
    assert!(
        unblock_time < Duration::from_millis(150),
        "16 workers unblocked in {unblock_time:?}"
    );
}
