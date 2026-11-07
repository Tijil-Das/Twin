/**
 * Overview & Folder Pairs Dashboard
 * Clean, native desktop interface for live sync state, real-time queues,
 * and folder pair configuration.
 */
import { useState } from "react";
import {
  Plus,
  Trash2,
  Play,
  Pause,
  RefreshCw,
  Folder,
  Cloud,
  ArrowLeftRight,
  CloudUpload,
  FlipHorizontal2,
  Copy,
  Check,
  AlertCircle,
  HardDrive,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useStore, type ProgressEvent } from "@/store";
import {
  govPause,
  govResume,
  syncNow,
  removePair,
  getConfig,
  updateConfig,
  runSyncCycle,
  type PairEntry,
} from "@/lib/tauri";
import { progressLabel } from "@/lib/format";
import { AddPairDialog } from "@/components/AddPairDialog";
import { toast } from "sonner";
import gdLogo from "@/assets/gd-icon.png";
import { cn } from "@/lib/utils";

// ── Sync Mode Definitions ─────────────────────────────────────────────────────

const SYNC_MODES = {
  two_way: {
    label: "Two-Way",
    description: "Bidirectional continuous sync",
    Icon: ArrowLeftRight,
  },
  upload: {
    label: "Backup",
    description: "Local to cloud upload only",
    Icon: CloudUpload,
  },
  mirror: {
    label: "Mirror",
    description: "Exact cloud mirror of local state",
    Icon: FlipHorizontal2,
  },
};

// ── Folder Pair Item ──────────────────────────────────────────────────────────

function FolderPairCard({
  id,
  local,
  drive_folder_id,
  mode,
  enabled,
}: {
  id: string;
  local: string;
  drive_folder_id: string;
  mode: string;
  enabled: boolean;
}) {
  const progress = useStore((s) => s.progress) ?? {};
  const setConfig = useStore((s) => s.setConfig);
  const config = useStore((s) => s.config);

  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState(false);

  const folderName = local.replace(/[/\\]$/, "").split(/[/\\]/).pop() || local;
  const modeInfo = SYNC_MODES[mode as keyof typeof SYNC_MODES] ?? SYNC_MODES.two_way;
  const ModeIcon = modeInfo.Icon;

  // Active in-flight events for this pair
  const pairEvents = Object.values(progress).filter(
    (e): e is ProgressEvent =>
      Boolean(
        e &&
          (e as ProgressEvent).pair_id === id &&
          (e as ProgressEvent).bytes_done < (e as ProgressEvent).bytes_total
      )
  );

  const totalDone = pairEvents.reduce((a, e) => a + e.bytes_done, 0);
  const totalBytes = pairEvents.reduce((a, e) => a + e.bytes_total, 0);
  const pct = totalBytes > 0 ? (totalDone / totalBytes) * 100 : 0;
  const startMs = pairEvents.length > 0 ? Math.min(...pairEvents.map((e) => e.start_ms)) : 0;
  const isCurrentlySyncing = syncing || pairEvents.length > 0;

  async function handleSync() {
    setSyncing(true);
    try {
      await runSyncCycle(id);
      toast.success(`Sync cycle completed for "${folderName}"`);
    } catch (e) {
      toast.error(`Sync error: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleToggle(enable: boolean) {
    if (!config) return;
    try {
      const currentPairs = Array.isArray(config.pairs)
        ? config.pairs
        : Array.isArray((config as any).pair)
        ? (config as any).pair
        : [];
      const nextPairs = currentPairs.map((p: PairEntry) =>
        p.id === id ? { ...p, enabled: enable } : p
      );
      const nextCfg = { ...config, pairs: nextPairs, pair: nextPairs };
      await updateConfig(nextCfg);
      const reloaded = await getConfig();
      setConfig(reloaded);
      toast.info(enable ? `Resumed sync for "${folderName}"` : `Paused sync for "${folderName}"`);
    } catch (e) {
      toast.error(`Failed to update pair: ${String(e)}`);
    }
  }

  async function handleRemove() {
    try {
      await removePair(id);
      const cfg = await getConfig();
      setConfig(cfg);
      toast.success(`Removed "${folderName}"`);
    } catch (e) {
      toast.error(`Failed to remove pair: ${String(e)}`);
    }
  }

  function handleCopyPath() {
    void navigator.clipboard.writeText(local);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Folder path copied");
  }

  return (
    <div
      className={cn(
        "desktop-card p-5 transition-all duration-150 group",
        !enabled && "opacity-60 bg-[var(--surface)]/50"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left: Folder Identity & Paths */}
        <div className="flex items-start gap-3.5 min-w-0 flex-1">
          <div
            className={cn(
              "w-12 h-12 rounded-xl flex items-center justify-center shrink-0 border mt-0.5 transition-colors",
              enabled
                ? "bg-blue-500/10 border-blue-500/25 text-blue-400"
                : "bg-white/[0.04] border-white/5 text-[var(--text-subtle)]"
            )}
          >
            <Folder size={22} strokeWidth={1.8} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="font-bold text-base text-white tracking-tight">
                {folderName}
              </span>

              {/* Mode indicator */}
              <span
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.08] text-[var(--text-muted)]"
                title={modeInfo.description}
              >
                <ModeIcon size={13} strokeWidth={1.8} className="text-[var(--text-subtle)]" />
                {modeInfo.label}
              </span>

              {!enabled && (
                <span className="text-xs font-medium px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  Paused
                </span>
              )}
            </div>

            {/* Path breakdown */}
            <div className="mt-2.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs code-text text-[var(--text)]">
                <HardDrive size={14} className="text-[var(--text-subtle)] shrink-0" />
                <span className="truncate select-all" title={local}>
                  {local}
                </span>
                <button
                  onClick={handleCopyPath}
                  className="hover:text-white text-[var(--text-subtle)] p-0.5 rounded transition-colors cursor-pointer"
                  title="Copy path"
                >
                  {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                </button>
              </div>

              <div className="flex items-center gap-2 text-xs code-text text-[var(--text-muted)]">
                <img src={gdLogo} alt="Google Drive" className="w-3.5 h-3.5 object-contain shrink-0" />
                <span className="truncate" title={`Google Drive ID: ${drive_folder_id}`}>
                  Drive: {drive_folder_id}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Quick Actions */}
        <div className="flex items-center gap-2 shrink-0 pt-1">
          <Button
            variant="ghost"
            size="iconSm"
            onClick={handleSync}
            disabled={!enabled || isCurrentlySyncing}
            title="Sync this folder now"
            className="text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)]"
          >
            <RefreshCw
              size={15}
              strokeWidth={1.8}
              className={cn(isCurrentlySyncing && "animate-spin text-blue-400")}
            />
          </Button>

          <Button
            variant="ghost"
            size="iconSm"
            onClick={handleRemove}
            title="Remove folder pair"
            className="text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10"
          >
            <Trash2 size={15} strokeWidth={1.8} />
          </Button>

          <div className="w-[1px] h-4 bg-[var(--border)] mx-1" />

          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            aria-label={`Toggle sync for ${folderName}`}
          />
        </div>
      </div>

      {/* Real-time Transfer Bar */}
      {pairEvents.length > 0 && (
        <div className="mt-4 pt-3.5 border-t border-[var(--border-subtle)]">
          <div className="flex items-center justify-between text-xs code-text text-[var(--text-muted)] mb-1.5">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              Transferring active files…
            </span>
            <span className="text-blue-400 font-bold">{pct.toFixed(0)}%</span>
          </div>
          <Progress value={pct} aria-label={`Progress for ${folderName}`} className="h-2" />
          <div className="text-xs code-text text-[var(--text-subtle)] mt-1.5">
            {progressLabel(totalDone, totalBytes, startMs)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Overview Screen ───────────────────────────────────────────────────────────

export function HomeScreen() {
  const gov = useStore((s) => s.gov) ?? { kind: "running" as const, reason: null, concurrency: 2 };
  const pairs = useStore((s) => s.pairs) ?? [];
  const queueStatus = useStore((s) => s.queueStatus) ?? { queued: 0, running: 0, done: 0, failed: 0 };
  const authed = useStore((s) => s.authed);
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const progress = useStore((s) => s.progress) ?? {};

  const [showAdd, setShowAdd] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  const govKind = String(gov?.kind || gov?.state || "running").toLowerCase();
  const isPaused = govKind === "user_paused" || govKind === "paused";
  const isThrottled = govKind.includes("throttle");

  // In-flight events
  const activeEvents = Object.values(progress).filter(
    (e): e is ProgressEvent => Boolean(e && e.bytes_total > 0 && e.bytes_done < e.bytes_total)
  );
  const isBatchActive = queueStatus.running > 0 || queueStatus.queued > 0 || activeEvents.length > 0;
  const hasFailures = (queueStatus.failed ?? 0) > 0 && !isBatchActive;

  const totalJobs = (queueStatus.done ?? 0) + queueStatus.queued + queueStatus.running;
  const batchPct = totalJobs > 0 ? Math.min(99.9, ((queueStatus.done ?? 0) / totalJobs) * 100) : 0;
  const activeDone = activeEvents.reduce((a, e) => a + e.bytes_done, 0);
  const activeTotal = activeEvents.reduce((a, e) => a + e.bytes_total, 0);
  const inFlightPct = activeTotal > 0 ? (activeDone / activeTotal) * 100 : 0;
  const displayPct = totalJobs > 0 ? batchPct : inFlightPct;
  const startMs = activeEvents.length > 0 ? Math.min(...activeEvents.map((e) => e.start_ms)) : Date.now();

  async function handlePauseResume() {
    try {
      if (isPaused) {
        await govResume();
        toast.success("Sync engine resumed");
      } else {
        await govPause();
        toast.info("Sync engine paused");
      }
    } catch (e) {
      toast.error(`Engine toggle failed: ${String(e)}`);
    }
  }

  async function handleSyncAll() {
    setSyncingAll(true);
    try {
      await syncNow();
      toast.success("Triggered sync cycle for all folders");
    } catch (e) {
      toast.error(`Sync cycle failed: ${String(e)}`);
    } finally {
      setTimeout(() => setSyncingAll(false), 800);
    }
  }

  async function handleAdded() {
    const cfg = await getConfig();
    setConfig(cfg);
    void syncNow();
  }

  const enabledPairsCount = pairs.filter((p) => p.enabled).length;

  return (
    <div className="p-7 max-w-4xl w-full mx-auto space-y-6">
      {/* ── Status Canvas & Control Bar ── */}
      <div className="desktop-card p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          {/* Status Indicator & Details */}
          <div className="flex items-start sm:items-center gap-4">
            <div
              className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center shrink-0 border",
                isPaused
                  ? "bg-zinc-500/10 border-zinc-500/20 text-zinc-400"
                  : isThrottled
                  ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                  : isBatchActive
                  ? "bg-blue-500/10 border-blue-500/25 text-blue-400"
                  : hasFailures
                  ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
                  : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
              )}
            >
              {isPaused ? (
                <Pause size={22} strokeWidth={2} />
              ) : isThrottled ? (
                <AlertCircle size={22} strokeWidth={2} />
              ) : isBatchActive ? (
                <RefreshCw size={22} className="animate-spin" strokeWidth={2} />
              ) : hasFailures ? (
                <AlertCircle size={22} strokeWidth={2} />
              ) : (
                <CheckCircle2 size={22} strokeWidth={2} />
              )}
            </div>

            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-bold text-white tracking-tight">
                  {isPaused
                    ? "Sync Engine Paused"
                    : isThrottled
                    ? "Engine Throttled (System Load)"
                    : isBatchActive
                    ? `Synchronizing ${queueStatus.running + queueStatus.queued} files…`
                    : hasFailures
                    ? `${queueStatus.failed} ${queueStatus.failed === 1 ? "file" : "files"} failed to sync`
                    : "All Files Up to Date"}
                </h1>
                {authed && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm" title="Google Drive connected" />
                )}
              </div>

              <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-1">
                {enabledPairsCount} active folder {enabledPairsCount === 1 ? "pair" : "pairs"}
                {" • "}
                {config?.app?.parallel_transfers ?? 4} parallel workers
                {authed ? " • Google Drive connected" : " • Signed out"}
              </p>
            </div>
          </div>

          {/* Action Group */}
          <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-auto">
            <Button
              variant="secondary"
              onClick={handlePauseResume}
              className="flex items-center gap-2"
            >
              {isPaused ? (
                <>
                  <Play size={14} className="text-emerald-400 fill-emerald-400" />
                  Resume
                </>
              ) : (
                <>
                  <Pause size={14} className="text-zinc-400" />
                  Pause
                </>
              )}
            </Button>

            <Button
              variant="secondary"
              onClick={handleSyncAll}
              disabled={syncingAll || isPaused}
              className="flex items-center gap-2"
            >
              <RefreshCw
                size={14}
                className={cn("text-[var(--text-muted)]", syncingAll && "animate-spin text-blue-400")}
              />
              Sync All
            </Button>

            <Button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-2"
            >
              <Plus size={15} strokeWidth={2.5} />
              Add Folder
            </Button>
          </div>
        </div>

        {/* In-flight Batch Sync Progress Strip */}
        {isBatchActive && (
          <div className="mt-5 pt-4.5 border-t border-[var(--border-subtle)] space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                Active Batch Progress
              </span>
              <span className="code-text text-blue-400 font-bold">
                {displayPct.toFixed(0)}%
              </span>
            </div>
            <Progress value={displayPct} aria-label="Batch progress" className="h-2" />
            <div className="flex items-center justify-between text-xs code-text text-[var(--text-subtle)]">
              <span>
                {totalJobs > 0
                  ? `${queueStatus.done ?? 0} of ${totalJobs} completed`
                  : progressLabel(activeDone, activeTotal, startMs)}
              </span>
              <span>
                {queueStatus.running} active transfer{queueStatus.running === 1 ? "" : "s"}
                {queueStatus.queued > 0 && ` • ${queueStatus.queued} queued`}
              </span>
            </div>
          </div>
        )}

        {/* Failure alert banner if any transfers failed */}
        {queueStatus.failed > 0 && (
          <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <AlertCircle size={16} className="text-red-400 shrink-0" />
              <span className="font-medium">
                {queueStatus.failed} transfer{queueStatus.failed === 1 ? "" : "s"} encountered errors
              </span>
            </div>
            <span className="text-xs text-red-400 font-semibold hover:underline cursor-pointer">
              View Activity ledger →
            </span>
          </div>
        )}
      </div>

      {/* ── Synced Folders Section ── */}
      <div className="space-y-3.5">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-bold text-white tracking-tight">
              Synced Folders
            </h2>
            <span className="text-xs code-text font-semibold px-2 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--text-muted)] border border-[var(--border)]">
              {pairs.length}
            </span>
          </div>

          {pairs.length > 0 && (
            <button
              onClick={() => setShowAdd(true)}
              className="text-xs font-semibold text-blue-400 hover:text-blue-300 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus size={14} strokeWidth={2.5} />
              Add another
            </button>
          )}
        </div>

        {/* Pairs List or Clean Native Empty State */}
        {pairs.length === 0 ? (
          <div className="desktop-card p-12 text-center flex flex-col items-center justify-center space-y-4 border-dashed">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/5 flex items-center justify-center text-[var(--text-muted)]">
              <Folder size={26} strokeWidth={1.5} />
            </div>

            <div className="max-w-md space-y-1.5">
              <h3 className="text-base font-bold text-white">
                No synced folders configured
              </h3>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Connect a local folder to Google Drive. Changes will sync continuously in real time.
              </p>
            </div>

            <Button
              onClick={() => setShowAdd(true)}
              className="mt-2"
            >
              <Plus size={15} strokeWidth={2.5} />
              Add Your First Folder Pair
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {pairs.map((p) => (
              <FolderPairCard key={p.id} {...p} />
            ))}
          </div>
        )}
      </div>

      {/* Add Pair Dialog */}
      <AddPairDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={handleAdded}
      />
    </div>
  );
}
