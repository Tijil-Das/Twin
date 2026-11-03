/**
 * Activity screen — recent sync events, retry on failure.
 */
import { useState, useEffect, useCallback } from "react";
import { useStore } from "@/store";
import { getActivity, retryJob } from "@/lib/tauri";
import type { Activity } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { formatTime, formatRelTime } from "@/lib/format";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

type Filter = "all" | "failed";

export function ActivityScreen() {
  const [filter, setFilter] = useState<Filter>("all");
  const setActivity = useStore((s) => s.setActivity);
  const rows = useStore((s) => s.activity) ?? [];
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getActivity(200);
      setActivity(data);
    } catch (e) {
      toast.error(`Failed to load activity: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [setActivity]);

  useEffect(() => { void refresh(); }, [refresh]);

  const visible = filter === "failed" ? rows.filter((r) => r.result === "error") : rows;

  async function handleRetry(id: number | null) {
    if (id === null) return;
    try {
      await retryJob(id);
      await refresh();
    } catch (e) {
      toast.error(`Retry failed: ${String(e)}`);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 880, width: "100%" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Activity</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {(["all", "failed"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                fontSize: 13,
                padding: "2px 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: filter === f ? "var(--surface-2)" : "var(--surface)",
                color: filter === f ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontWeight: filter === f ? 500 : 400,
              }}
            >
              {f === "all" ? "All" : "Failed"}
            </button>
          ))}
          <Button variant="secondary" size="icon" onClick={refresh} disabled={loading} aria-label="Refresh activity">
            <RefreshCw size={14} strokeWidth={1.5} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
          </Button>
        </div>
      </div>

      {/* Table */}
      {visible.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>No activity yet.</p>
      ) : (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
            background: "var(--surface)",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "120px 80px 1fr 80px 80px",
              padding: "8px 16px",
              borderBottom: "1px solid var(--border)",
              fontSize: 12,
              fontWeight: 500,
              color: "var(--text-muted)",
            }}
          >
            <span>Time</span>
            <span>Action</span>
            <span>File</span>
            <span>Result</span>
            <span></span>
          </div>

          {/* Rows */}
          {visible.map((row, i) => (
            <ActivityRow key={row.id ?? i} row={row} onRetry={handleRetry} last={i === visible.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({
  row,
  onRetry,
  last,
}: {
  row: Activity;
  onRetry: (id: number | null) => void;
  last: boolean;
}) {
  const isFailed = row.result === "error";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 80px 1fr 80px 80px",
        padding: "8px 16px",
        borderBottom: last ? "none" : "1px solid var(--border)",
        alignItems: "center",
        fontSize: 13,
        background: "var(--surface)",
        minHeight: 36,
      }}
      className="hover:bg-[var(--surface-2)]"
    >
      <span
        style={{ fontSize: 12, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}
        title={formatTime(row.ts_ms)}
      >
        {formatRelTime(row.ts_ms)}
      </span>
      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{row.kind}</span>
      <span
        title={row.rel_path}
        style={{
          fontFamily: '"Cascadia Mono", Consolas, monospace',
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.rel_path}
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: isFailed
            ? "var(--danger)"
            : row.result === "dry-run"
            ? "var(--text-muted)"
            : "var(--success)",
        }}
      >
        {isFailed ? "Error" : row.result === "dry-run" ? "Dry run" : "OK"}
      </span>
      <span style={{ textAlign: "right" }}>
        {isFailed && (
          <Button variant="ghost" size="sm" onClick={() => onRetry(row.id)}>
            Retry
          </Button>
        )}
      </span>
    </div>
  );
}

