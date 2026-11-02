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

