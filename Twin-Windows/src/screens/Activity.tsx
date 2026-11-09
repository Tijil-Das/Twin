/**
 * Activity Ledger Screen
 * High-precision desktop audit log for background transfers,
 * deltas, error diagnostics, and one-click retries.
 */
import { useState, useEffect, useCallback } from "react";
import { useStore } from "@/store";
import { getActivity, retryJob, retryAllFailed } from "@/lib/tauri";
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
  Search,
  RotateCcw,
  Clock,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Filter = "all" | "failed" | "upload" | "download";

export function ActivityScreen() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const setActivity = useStore((s) => s.setActivity);
  const rows = useStore((s) => s.activity) ?? [];
  const [loading, setLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getActivity(300);
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

  // Reset pagination when filter or search changes
  useEffect(() => {
    setVisibleCount(50);
  }, [filter, search]);

  const filtered = rows.filter((r) => {
    if (filter === "failed" && r.result !== "error") return false;
    if (filter === "upload" && !r.kind.toLowerCase().includes("upload")) return false;
    if (filter === "download" && !r.kind.toLowerCase().includes("download")) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        r.rel_path.toLowerCase().includes(q) ||
        r.kind.toLowerCase().includes(q) ||
        Boolean(r.detail && r.detail.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const failureCount = rows.filter((r) => r.result === "error").length;

  async function handleRetry(id: number | null) {
    if (id === null) return;
    setRetryingId(id);
    try {
      await retryJob(id);
      toast.success("Job re-queued for sync");
      await refresh();
    } catch (e) {
      toast.error(`Retry failed: ${String(e)}`);
    } finally {
      setRetryingId(null);
    }
  }

  async function handleRetryAll() {
    setRetryingAll(true);
    try {
      const count = await retryAllFailed();
      toast.success(`Re-queued ${count} failed transfer${count === 1 ? "" : "s"}`);
      await refresh();
    } catch (e) {
      toast.error(`Retry failed: ${String(e)}`);
    } finally {
      setRetryingAll(false);
    }
  }

  return (
    <div className="p-6 sm:p-8 w-full max-w-[980px] mx-auto space-y-6 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between pb-3.5 border-b border-[var(--border)]">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white">
              Activity Ledger
            </h1>
            {failureCount > 0 && (
              <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25">
                {failureCount} failed
              </span>
            )}
          </div>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-1">
            Audit log of background file synchronizations, deltas, and error states.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {failureCount > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleRetryAll}
              disabled={retryingAll || loading}
              className="flex items-center gap-1.5 text-xs bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 shadow-none"
            >
              <RotateCcw
                size={13}
                className={cn(retryingAll && "animate-spin")}
              />
              Retry All ({failureCount})
            </Button>
          )}

          <Button
            variant="secondary"
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-2"
          >
            <RefreshCw
              size={14}
              className={cn("text-[var(--text-muted)]", loading && "animate-spin text-blue-400")}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter Tabs & Search Controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3.5">
        <div className="flex items-center gap-1 p-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-full sm:w-auto">
          {[
            { id: "all", label: "All Events", count: rows.length },
            { id: "failed", label: "Failures", count: failureCount },
            { id: "upload", label: "Uploads" },
            { id: "download", label: "Downloads" },
          ].map((tab) => {
            const isActive = filter === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id as Filter)}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-2",
                  isActive
                    ? "bg-[var(--surface)] text-white shadow-sm border border-white/5"
                    : "text-[var(--text-muted)] hover:text-white"
                )}
              >
                <span>{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span
                    className={cn(
                      "text-xs code-text px-1.5 py-0.2 rounded-full",
                      tab.id === "failed"
                        ? "bg-red-500/20 text-red-400"
                        : "bg-white/10 text-[var(--text-muted)]"
                    )}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 top-2.5 text-[var(--text-subtle)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by filename or path…"
            className="w-full h-9 pl-9 pr-8 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-md text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus:border-blue-500/70 transition-colors"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-2.5 text-[var(--text-subtle)] hover:text-white p-0.5 cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Event Ledger */}
      {filtered.length === 0 ? (
        <div className="desktop-card p-14 text-center flex flex-col items-center justify-center space-y-3 border-dashed">
          <div className="w-12 h-12 rounded-md bg-white/[0.04] border border-white/5 flex items-center justify-center text-[var(--text-muted)]">
            <Clock size={22} strokeWidth={1.5} />
          </div>
          <p className="text-sm font-semibold text-white">No matching activity records</p>
          <p className="text-xs text-[var(--text-muted)]">
            Background file transfers and updates will automatically appear here.
          </p>
        </div>
      ) : (
        <div className="desktop-card overflow-hidden">
          {/* Table Header */}
          <div className="grid grid-cols-[100px_110px_1fr_95px_75px] gap-3 px-4 py-3 bg-[var(--surface-2)]/60 border-b border-[var(--border)] text-xs font-bold text-[var(--text-subtle)] uppercase tracking-wider">
            <span>Time</span>
            <span>Type</span>
            <span>File Path</span>
            <span>Result</span>
            <span className="text-right">Action</span>
          </div>

          {/* Rows */}
          <div className="divide-y divide-[var(--border-subtle)]">
            {filtered.slice(0, visibleCount).map((row, i) => {
              const isFailed = row.result === "error";
              const isUpload = row.kind.toLowerCase().includes("upload");
              const isDelete = row.kind.toLowerCase().includes("delete");

              const parts = row.rel_path.split(/[/\\]/);
              const fileName = parts.pop() || row.rel_path;
              const dirPath = parts.join("/");

              return (
                <div
                  key={row.id ?? i}
                  className={cn(
                    "grid grid-cols-[100px_110px_1fr_95px_75px] gap-3 px-4 py-3 items-center text-xs hover:bg-[var(--surface-2)]/50 transition-colors group",
                    isFailed && "bg-red-500/[0.03] hover:bg-red-500/[0.06]"
                  )}
                >
                  {/* Timestamp */}
                  <span
                    className="text-xs text-[var(--text-subtle)] code-text truncate"
                    title={formatTime(row.ts_ms)}
                  >
                    {formatRelTime(row.ts_ms)}
                  </span>

                  {/* Operation Type */}
                  <div>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border",
                        isUpload
                          ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                          : isDelete
                          ? "bg-red-500/10 text-red-400 border-red-500/20"
                          : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      )}
                    >
                      {isUpload ? (
                        <ArrowUp size={12} strokeWidth={2.2} />
                      ) : isDelete ? (
                        <Trash2 size={12} strokeWidth={2.2} />
                      ) : (
                        <ArrowDown size={12} strokeWidth={2.2} />
                      )}
                      {row.kind}
                    </span>
                  </div>

                  {/* File Path */}
                  <div className="min-w-0 pr-2">
                    <div className="code-text text-xs text-[var(--text)] truncate" title={row.rel_path}>
                      {dirPath && (
                        <span className="text-[var(--text-subtle)]">{dirPath}/</span>
                      )}
                      <span className="font-bold text-white text-[13px]">{fileName}</span>
                    </div>
                    {row.detail && (
                      <p className="text-xs text-red-400/90 truncate mt-0.5" title={row.detail}>
                        {row.detail}
                      </p>
                    )}
                  </div>

                  {/* Result Status */}
                  <div>
                    {isFailed ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-red-400">
                        <AlertCircle size={14} />
                        Failed
                      </span>
                    ) : row.result === "dry-run" ? (
                      <span className="text-xs text-[var(--text-subtle)] code-text">Dry run</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                        <CheckCircle2 size={14} />
                        Synced
                      </span>
                    )}
                  </div>

                  {/* Retry Action */}
                  <div className="text-right">
                    {isFailed && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => handleRetry(row.id)}
                        disabled={retryingId === row.id}
                        className="text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                        title="Retry transfer"
                      >
                        <RotateCcw
                          size={12}
                          className={cn(retryingId === row.id && "animate-spin")}
                        />
                        Retry
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination / Progressive Loading Footer */}
          {filtered.length > 50 && (
            <div className="px-4 py-3 bg-[var(--surface-2)]/40 border-t border-[var(--border)] flex items-center justify-between text-xs text-[var(--text-subtle)]">
              <span>
                Showing <strong className="text-white">{Math.min(visibleCount, filtered.length)}</strong> of <strong className="text-white">{filtered.length}</strong> items
              </span>
              <div className="flex items-center gap-2">
                {visibleCount < filtered.length && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setVisibleCount((prev) => prev + 50)}
                    className="text-xs border-[#30363d] hover:bg-[#21262d] text-white"
                  >
                    Load 50 More
                  </Button>
                )}
                {visibleCount < filtered.length && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setVisibleCount(filtered.length)}
                    className="text-xs text-[var(--text-muted)] hover:text-white"
                  >
                    Show All ({filtered.length})
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
