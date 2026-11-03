/**
 * Pro Activity Log Screen — Filterable sync ledger, error diagnostics,
 * one-click job retries, and high-contrast tabular layout.
 */
import { useState, useEffect, useCallback } from "react";
import { useStore } from "@/store";
import { getActivity, retryJob } from "@/lib/tauri";
import type { Activity } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { formatTime, formatRelTime } from "@/lib/format";
import { toast } from "sonner";
import {
  RefreshCw,
  ArrowUp,
  ArrowDown,
  Trash2,
  AlertCircle,
  CheckCircle2,
  FileText,
  Clock,
  Layers,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Filter = "all" | "failed" | "upload" | "download";

export function ActivityScreen() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = rows.filter((r) => {
    if (filter === "failed" && r.result !== "error") return false;
    if (filter === "upload" && !r.kind.toLowerCase().includes("upload")) return false;
    if (filter === "download" && !r.kind.toLowerCase().includes("download")) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        r.rel_path.toLowerCase().includes(q) ||
        r.kind.toLowerCase().includes(q) ||
        (r.detail && r.detail.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const failureCount = rows.filter((r) => r.result === "error").length;

  async function handleRetry(id: number | null) {
    if (id === null) return;
    try {
      await retryJob(id);
      toast.success("Job re-queued for sync");
      await refresh();
    } catch (e) {
      toast.error(`Retry failed: ${String(e)}`);
    }
  }

  return (
    <div className="p-6 max-w-4xl w-full mx-auto space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-[var(--text)] flex items-center gap-2">
            Activity Ledger
            {failureCount > 0 && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25">
                {failureCount} failed
              </span>
            )}
          </h1>
          <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
            Audit log of all background file synchronizations, deltas, and error states.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5"
          >
            <RefreshCw
              size={13}
              className={cn("text-blue-400", loading && "animate-spin")}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter Tabs & Search */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[var(--surface-2)]/80 border border-[var(--border)] w-full sm:w-auto">
          {[
            { id: "all", label: "All Events" },
            { id: "failed", label: `Failures (${failureCount})` },
            { id: "upload", label: "Uploads" },
            { id: "download", label: "Downloads" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id as Filter)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer",
                filter === tab.id
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm font-semibold border border-[var(--border)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search size={13} className="absolute left-2.5 top-2.5 text-[var(--text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by file or path..."
            className="w-full h-8 pl-8 pr-3 text-xs bg-[var(--surface-2)]/60 border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus:border-blue-500/60 transition-colors"
          />
        </div>
      </div>

      {/* Event Timeline / Table */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/50 p-12 text-center flex flex-col items-center justify-center space-y-2">
          <div className="w-10 h-10 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)]">
            <Clock size={18} />
          </div>
          <p className="text-[13px] font-medium text-[var(--text)]">No matching activity records</p>
          <p className="text-[11px] text-[var(--text-muted)]">
            File change events and sync operations will automatically appear here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-sm">
          {/* Table Header */}
          <div className="grid grid-cols-[100px_100px_1fr_90px_70px] gap-2 px-4 py-2.5 bg-[var(--surface-2)]/60 border-b border-[var(--border)] text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            <span>Timestamp</span>
            <span>Operation</span>
            <span>Relative File Path</span>
            <span>Status</span>
            <span className="text-right">Action</span>
          </div>

          {/* Rows */}
          <div className="divide-y divide-[var(--border-subtle)]">
            {filtered.map((row, i) => (
              <ActivityRow
                key={row.id ?? i}
                row={row}
                onRetry={handleRetry}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityRow({
  row,
  onRetry,
}: {
  row: Activity;
  onRetry: (id: number | null) => void;
}) {
  const isFailed = row.result === "error";
  const isUpload = row.kind.toLowerCase().includes("upload");
  const isDelete = row.kind.toLowerCase().includes("delete");

  // Extract file name from path
  const parts = row.rel_path.split(/[/\\]/);
  const fileName = parts.pop() || row.rel_path;
  const dirPath = parts.join("/");

  return (
    <div
      className={cn(
        "grid grid-cols-[100px_100px_1fr_90px_70px] gap-2 px-4 py-3 items-center text-[12px] hover:bg-[var(--surface-2)]/60 transition-colors",
        isFailed && "bg-red-500/5 hover:bg-red-500/10"
      )}
    >
      {/* Time */}
      <span
        className="text-[11px] text-[var(--text-muted)] font-mono truncate"
        title={formatTime(row.ts_ms)}
      >
        {formatRelTime(row.ts_ms)}
      </span>

      {/* Operation badge */}
      <div>
        <span
          className={cn(
            "inline-flex items-center gap-1 text-[10.5px] font-medium px-2 py-0.5 rounded-md border",
            isUpload
              ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
              : isDelete
              ? "bg-red-500/10 text-red-400 border-red-500/20"
              : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
          )}
        >
          {isUpload ? (
            <ArrowUp size={11} strokeWidth={2} />
          ) : isDelete ? (
            <Trash2 size={11} strokeWidth={2} />
          ) : (
            <ArrowDown size={11} strokeWidth={2} />
          )}
          {row.kind}
        </span>
      </div>

      {/* File Path */}
      <div className="min-w-0 pr-2">
        <div className="font-mono text-[12px] text-[var(--text)] truncate" title={row.rel_path}>
          {dirPath && <span className="text-[var(--text-muted)]">{dirPath}/</span>}
          <span className="font-semibold">{fileName}</span>
        </div>
        {row.detail && (
          <p className="text-[11px] text-red-400/90 truncate mt-0.5" title={row.detail}>
            {row.detail}
          </p>
        )}
      </div>

      {/* Status */}
      <div>
        {isFailed ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-400">
            <AlertCircle size={12} />
            Failed
          </span>
        ) : row.result === "dry-run" ? (
          <span className="text-[11px] font-medium text-[var(--text-muted)]">Dry run</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
            <CheckCircle2 size={12} />
            Synced
          </span>
        )}
      </div>

      {/* Retry */}
      <div className="text-right">
        {isFailed && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRetry(row.id)}
            className="h-6 px-2 text-[11px] text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
          >
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
