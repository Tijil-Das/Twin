/**
 * Dev helper — mock event emitter.
 * Import and call `startMockEvents()` in development to simulate
 * progress events so you can verify bars advance correctly.
 */
import type { ProgressEvent } from "@/store";

export function startMockEvents(onProgress?: (e: ProgressEvent) => void) {
  const jobs: ProgressEvent[] = [
    { job_id: 1, pair_id: "p1", rel_path: "docs/report.pdf",   bytes_done: 0, bytes_total: 10 * 1024 * 1024, start_ms: Date.now() },
    { job_id: 2, pair_id: "p1", rel_path: "photos/sunset.jpg", bytes_done: 0, bytes_total:  2 * 1024 * 1024, start_ms: Date.now() },
    { job_id: 3, pair_id: "p2", rel_path: "archive/data.zip",  bytes_done: 0, bytes_total: 50 * 1024 * 1024, start_ms: Date.now() },
  ];

  // Advance bytes at different speeds (bytes per tick at 10 ticks/s)
  const speeds = [512 * 1024, 256 * 1024, 1024 * 1024];

  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      if (j.bytes_done >= j.bytes_total) continue;
      j.bytes_done = Math.min(j.bytes_done + speeds[i] / 10, j.bytes_total);
      onProgress?.(j);
      window.dispatchEvent(new CustomEvent("mock:progress", { detail: { ...j } }));
    }

    if (jobs.every((j) => j.bytes_done >= j.bytes_total)) {
      stopped = true;
      clearInterval(interval);
    }
  }, 100);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/**
 * Returns a checker object that validates progress invariants.
 * Call `.check(event)` on each progress event and read `.issues` at the end.
 */
export function makeProgressVerifier() {
  const issues: string[] = [];
  const start = Date.now();
  let lastPct = 0;

  return {
    check(e: ProgressEvent) {
      const pct = e.bytes_total > 0 ? (e.bytes_done / e.bytes_total) * 100 : 0;
      if (pct < lastPct - 1) {
        issues.push(`Progress regressed for job ${e.job_id}: ${lastPct.toFixed(1)}% → ${pct.toFixed(1)}%`);
      }
      lastPct = pct;
      const elapsed = (Date.now() - start) / 1000;
      const speed = elapsed > 0 ? e.bytes_done / elapsed : 0;
      const eta = speed > 0 ? (e.bytes_total - e.bytes_done) / speed : 0;
      if (pct > 10 && eta > e.bytes_total / 1024) {
        issues.push(`ETA suspiciously large for job ${e.job_id}: ${eta.toFixed(0)}s`);
      }
    },
    get issues() { return issues; },
  };
}
