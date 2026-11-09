/** Formatting utilities for bytes, speeds, ETA, timestamps. */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export function formatBytes(b: number): string {
  if (b >= GB) return `${(b / GB).toFixed(1)} GB`;
  if (b >= MB) return `${(b / MB).toFixed(1)} MB`;
  if (b >= KB) return `${(b / KB).toFixed(0)} KB`;
  return `${b} B`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

/** Format seconds into mm:ss or h:mm:ss */
export function formatEta(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Pro-software ETA formatting and gating heuristics.
 * Researched from tools like curl, rsync, Google Drive, and Steam:
 * - Does not force ETA on tiny files (< 512 KB) or fleeting transfers (< 3s).
 * - Filters out early warm-up phase and detects stalled speed.
 * - Caps extreme estimates (> 24h).
 * - Formats with clean human units (~45s left, ~2m 10s left, ~1h 15m left).
 */
export function formatSmartEta(
  secs?: number | null,
  bytesTotal?: number,
  bytesDone?: number,
  speedBps?: number
): string | null {
  if (secs === null || secs === undefined || !isFinite(secs) || secs <= 0) {
    return null;
  }

  // Heuristic 1: If file size is tiny (< 512 KB), transfer finishes in milliseconds;
  // forcing an ETA causes jittery visual clutter.
  if (bytesTotal && bytesTotal > 0 && bytesTotal < 512 * 1024) {
    return null;
  }

  // Heuristic 2: If remaining time is under 3 seconds, don't show fleeting countdown.
  if (secs < 3) {
    return null;
  }

  // Heuristic 3: If transfer just began (< 1% complete on large files), let speed stabilize
  if (bytesTotal && bytesDone !== undefined && bytesTotal > 10 * 1024 * 1024) {
    const pct = (bytesDone / bytesTotal) * 100;
    if (pct < 1.0) {
      return "Estimating…";
    }
  }

  // Heuristic 4: If speed is essentially zero, indicate stalled rather than infinite.
  if (speedBps !== undefined && speedBps > 0 && speedBps < 50) {
    return "Stalled";
  }

  // Heuristic 5: Cap runaway estimates over 24 hours.
  if (secs > 86400) {
    return "> 1 day left";
  }

  const s = Math.round(secs);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const remainingSeconds = s % 60;

  if (hours > 0) {
    return minutes > 0 ? `~${hours}h ${minutes}m left` : `~${hours}h left`;
  }
  if (minutes > 0) {
    if (minutes >= 5) {
      return `~${minutes}m left`;
    }
    return remainingSeconds > 0 ? `~${minutes}m ${remainingSeconds}s left` : `~${minutes}m left`;
  }
  return `~${remainingSeconds}s left`;
}

/** Format ms timestamp to a relative string like "2 min ago" or absolute "14:32" */
export function formatRelTime(ms: number): string {
  const diff = Date.now() - ms;
  const secs = diff / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Given bytes_done, bytes_total, elapsed_ms → compute speed + ETA label string */
export function progressLabel(
  bytesDone: number,
  bytesTotal: number,
  startMs: number
): string {
  if (bytesTotal <= 0) return "Calculating...";
  const elapsed = (Date.now() - startMs) / 1000;
  const speed = elapsed > 0 ? bytesDone / elapsed : 0;
  const remaining = speed > 0 ? (bytesTotal - bytesDone) / speed : 0;
  const parts = [
    `${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}`,
    speed > 0 ? formatSpeed(speed) : null,
    remaining > 0 ? `ETA ${formatEta(remaining)}` : null,
  ].filter(Boolean);
  return parts.join("  ·  ");
}

