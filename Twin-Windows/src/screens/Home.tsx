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

// ── GitHub Octicon Folder Icon ────────────────────────────────────────────────

function GithubFolderIcon({ color, className }: { color?: string | null; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-4 h-4 shrink-0 fill-current", className)}
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
    </svg>
  );
}

// ── Folder Pair Row (GitHub Repository Table Presentation) ───────────────────

function FolderPairRow({
  id,
  local,
  mode,
  enabled,
}: {
  id: string;
  local: string;
  drive_folder_id?: string;
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
        "group transition-colors",
        !enabled ? "bg-[#0d1117]/60 opacity-70" : "bg-[#0d1117] hover:bg-[#161b22]"
      )}
    >
      <div className="px-4 py-2.5 flex items-center justify-between gap-4 text-xs select-none">
        {/* Left: GitHub Octicon + Folder Name + Local Path + Mode */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <GithubFolderIcon
            className={cn(
              "w-4 h-4 shrink-0 transition-colors",
              enabled ? "text-[#54aeff]" : "text-[#7d8590]"
            )}
          />

          {/* Folder Name */}
          <span
            className={cn(
              "font-semibold text-[13px] shrink-0 transition-colors",
              enabled ? "text-[#e6edf3] group-hover:text-[#58a6ff]" : "text-[#7d8590]"
            )}
            title={folderName}
          >
            {folderName}
          </span>

          <span className="text-[#30363d] shrink-0">•</span>

          {/* Local Path with Copy button */}
          <div className="flex items-center gap-1.5 min-w-0 truncate text-[#7d8590] font-mono text-xs">
            <HardDrive size={13} className="text-[#7d8590] shrink-0" />
            <span className="truncate" title={local}>
              {local}
            </span>
            <button
              type="button"
              onClick={handleCopyPath}
              className="text-[#7d8590] hover:text-[#e6edf3] p-0.5 rounded transition-colors cursor-pointer shrink-0"
              title="Copy local path"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
          </div>

          {/* Mode Pill Badge */}
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-[#21262d] text-[#8b949e] border border-[#30363d] shrink-0 ml-auto"
            title={modeInfo.description}
          >
            <ModeIcon size={11} strokeWidth={1.8} className="text-[#7d8590]" />
            {modeInfo.label}
          </span>

          {!enabled && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-[#30363d]/60 border border-[#d29922]/40 text-[#d29922] shrink-0">
              Paused
            </span>
          )}
        </div>

        {/* Right: Quick Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {isCurrentlySyncing && (
            <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#58a6ff] mr-1">
              <RefreshCw size={11} className="animate-spin" />
              <span>{pct > 0 ? `${pct.toFixed(0)}%` : "Syncing"}</span>
            </span>
          )}

          <button
            type="button"
            onClick={handleSync}
            disabled={!enabled || isCurrentlySyncing}
            title="Sync this folder now"
            className="p-1.5 rounded-md text-[#7d8590] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors cursor-pointer disabled:opacity-40"
          >
            <RefreshCw
              size={13}
              strokeWidth={1.8}
              className={cn(isCurrentlySyncing && "animate-spin text-[#58a6ff]")}
            />
          </button>

          <button
            type="button"
            onClick={handleRemove}
            title="Remove folder pair"
            className="p-1.5 rounded-md text-[#7d8590] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors cursor-pointer"
          >
            <Trash2 size={13} strokeWidth={1.8} />
          </button>

          <div className="w-[1px] h-3.5 bg-[#30363d] mx-1" />

          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            aria-label={`Toggle sync for ${folderName}`}
          />
        </div>
      </div>

      {/* Real-time Transfer Bar (attached GitHub Action/Job progress strip) */}
      {pairEvents.length > 0 && (
        <div className="px-4 py-2 bg-[#161b22]/70 border-t border-[#21262d] space-y-1">
          <div className="flex items-center justify-between text-[11px] font-mono text-[#7d8590]">
            <span className="flex items-center gap-1.5 text-[#58a6ff]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] animate-pulse" />
              Transferring active files…
            </span>
            <span className="text-[#58a6ff] font-bold">{pct.toFixed(0)}%</span>
          </div>
          <Progress value={pct} aria-label={`Progress for ${folderName}`} className="h-1.5 bg-[#21262d]" />
          <div className="text-[11px] font-mono text-[#7d8590]">
            {progressLabel(totalDone, totalBytes, startMs)}
          </div>
        </div>
      )}
    </div>
  );
}

// Backward-compatible alias for Vite HMR and dynamic references
export const FolderPairCard = FolderPairRow;

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

              <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-1 flex items-center flex-wrap gap-x-1.5">
                <span>{enabledPairsCount} active folder {enabledPairsCount === 1 ? "pair" : "pairs"}</span>
                <span>•</span>
                <span>{config?.app?.parallel_transfers ?? 4} parallel workers</span>
                <span>•</span>
                {authed ? (
                  <span className="inline-flex items-center gap-1.5 text-[#c9d1d9] font-medium">
                    <img
                      src={gdLogo}
                      alt="Google Drive"
                      style={{ width: 14, height: 14, minWidth: 14, maxWidth: 14 }}
                      className="w-3.5 h-3.5 object-contain inline shrink-0"
                    />
                    Google Drive connected
                  </span>
                ) : (
                  <span>Signed out</span>
                )}
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

      {/* ── Synced Folders (GitHub Repository Presentation) ── */}
      <div className="rounded-md border border-[#30363d] bg-[#0d1117] overflow-hidden shadow-sm">
        {/* GitHub Header Bar */}
        <div className="bg-[#161b22] px-3.5 py-2.5 border-b border-[#30363d] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <GithubFolderIcon className="w-4 h-4 text-[#7d8590]" />
            <span className="font-semibold text-xs text-[#e6edf3]">
              Synced Folders
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs font-mono font-medium bg-[#21262d] text-[#7d8590] border border-[#30363d]">
              {pairs.length}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {pairs.length > 0 && (
              <button
                type="button"
                onClick={handleSyncAll}
                disabled={syncingAll || isPaused}
                className="px-2.5 py-1 rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] hover:text-white border border-[#30363d] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                title="Trigger sync for all pairs"
              >
                <RefreshCw size={12} className={cn(syncingAll && "animate-spin text-[#58a6ff]")} />
                <span>Sync All</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="px-2.5 py-1 rounded-md bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border border-[rgba(240,246,252,0.1)] shadow-sm"
              title="Add a new folder pair"
            >
              <Plus size={13} strokeWidth={2.5} />
              <span>Add Folder</span>
            </button>
          </div>
        </div>

        {/* Pairs List or GitHub Clean Empty State */}
        {pairs.length === 0 ? (
          <div className="p-12 text-center flex flex-col items-center justify-center space-y-3 bg-[#0d1117]">
            <GithubFolderIcon className="w-10 h-10 text-[#7d8590]/40" />
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-[#e6edf3]">
                No synced folders configured
              </h3>
              <p className="text-xs text-[#7d8590]">
                Connect a local folder to Google Drive to begin continuous synchronization.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="mt-2 px-3 py-1.5 rounded-md bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer border border-[rgba(240,246,252,0.1)]"
            >
              <Plus size={14} strokeWidth={2.5} />
              <span>Add Folder Pair</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[#21262d]">
            {pairs.map((p) => (
              <FolderPairRow key={p.id} {...p} />
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
