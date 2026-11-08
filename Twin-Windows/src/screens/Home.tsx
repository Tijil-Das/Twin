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
  ArrowUp,
  ArrowDown,
  ChevronRight,
  Clock,
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
import { progressLabel, formatBytes, formatSpeed, formatEta } from "@/lib/format";
import { AddPairDialog } from "@/components/AddPairDialog";
import { toast } from "sonner";
import gdLogo from "@/assets/gd-icon.png";
import { cn } from "@/lib/utils";

// ── Sync Mode Definitions ─────────────────────────────────────────────────────

const SYNC_MODES = {
  two_way: {
    label: "Two-Way",
    title: "Two-Way Sync",
    description: "Bidirectional continuous replication. Edits locally or on Google Drive sync both ways.",
    Icon: ArrowLeftRight,
  },
  upload: {
    label: "Backup",
    title: "Cloud Backup",
    description: "Local to cloud upload only. Local edits sync to Google Drive. Remote changes will not alter local files.",
    Icon: CloudUpload,
  },
  mirror: {
    label: "Mirror",
    title: "Cloud Mirror",
    description: "Strict mirror. Keeps remote Google Drive directory as an exact replica of local state.",
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

// ── Folder Pair Row (Clean Desktop Presentation) ─────────────────────────────

interface FolderPairRowProps extends PairEntry {
  onSelect?: (id: string) => void;
}

function FolderPairRow({
  id,
  local,
  mode,
  enabled,
  onSelect,
}: FolderPairRowProps) {
  const progress = useStore((s) => s.progress) ?? {};
  const pairStatuses = useStore((s) => s.pairStatuses) ?? {};
  const pairStatus = pairStatuses[id];
  const setConfig = useStore((s) => s.setConfig);
  const config = useStore((s) => s.config);

  const [syncing, setSyncing] = useState(false);
  const [copiedLocal, setCopiedLocal] = useState(false);

  const folderName = local.replace(/[/\\]$/, "").split(/[/\\]/).pop() || local;
  const modeInfo = SYNC_MODES[mode as keyof typeof SYNC_MODES] ?? SYNC_MODES.two_way;
  const ModeIcon = modeInfo.Icon;

  // Active in-flight transfer events for this pair
  const pairEvents = Object.values(progress).filter(
    (e): e is ProgressEvent =>
      Boolean(
        e &&
          (e as ProgressEvent).pair_id === id &&
          (e as ProgressEvent).bytes_total > 0 &&
          (e as ProgressEvent).bytes_done <= (e as ProgressEvent).bytes_total
      )
  );

  const isCurrentlySyncing = syncing || pairEvents.length > 0;

  const totalFiles = pairStatus?.total ?? 0;
  const syncedFiles = pairStatus?.synced ?? 0;
  const pendingFiles = (pairStatus?.dirty ?? 0) + (pairStatus?.queued ?? 0);
  const failedFiles = pairStatus?.failed ?? 0;
  const conflictFiles = pairStatus?.conflict ?? 0;

  const isFullySynced = Boolean(
    pairStatus?.is_synced &&
      (totalFiles === 0 || syncedFiles === totalFiles) &&
      pendingFiles === 0 &&
      failedFiles === 0 &&
      conflictFiles === 0
  );

  const hasPending = Boolean(
    pairStatus && (pendingFiles > 0 || (totalFiles > 0 && syncedFiles < totalFiles))
  );

  async function handleSync(e: React.MouseEvent) {
    e.stopPropagation();
    setSyncing(true);
    try {
      await runSyncCycle(id);
      toast.success(`Sync cycle completed for "${folderName}"`);
    } catch (err) {
      toast.error(`Sync error: ${String(err)}`);
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
    } catch (err) {
      toast.error(`Failed to update pair: ${String(err)}`);
    }
  }

  async function handleRemove(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await removePair(id);
      const cfg = await getConfig();
      setConfig(cfg);
      toast.success(`Removed "${folderName}"`);
    } catch (err) {
      toast.error(`Failed to remove pair: ${String(err)}`);
    }
  }

  function handleCopyLocal(e: React.MouseEvent) {
    e.stopPropagation();
    void navigator.clipboard.writeText(local);
    setCopiedLocal(true);
    setTimeout(() => setCopiedLocal(false), 2000);
    toast.success("Local folder path copied");
  }

  return (
    <div
      onClick={() => onSelect?.(id)}
      className={cn(
        "group transition-colors border-b border-[#30363d]/70 last:border-b-0 cursor-pointer",
        !enabled ? "bg-[#0d1117]/60 opacity-80" : "bg-[#0d1117] hover:bg-[#161b22]"
      )}
    >
      <div className="px-4 py-3.5 flex items-start justify-between gap-4 select-none">
        {/* Left: Octicon + Folder Info & Live Status */}
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <GithubFolderIcon
            className={cn(
              "w-4 h-4 mt-0.5 shrink-0 transition-colors",
              enabled ? "text-[#54aeff]" : "text-[#7d8590]"
            )}
          />

          <div className="min-w-0 flex-1 space-y-1">
            {/* Line 1: Folder Name + Local Path */}
            <div className="flex items-center gap-2 min-w-0 flex-nowrap whitespace-nowrap overflow-hidden">
              <span
                className={cn(
                  "font-semibold text-sm shrink-0 transition-colors whitespace-nowrap",
                  enabled ? "text-[#e6edf3] group-hover:text-[#58a6ff]" : "text-[#7d8590]"
                )}
                title={folderName}
              >
                {folderName}
              </span>

              <span className="text-[#30363d] shrink-0">•</span>

              <div className="flex items-center gap-1.5 min-w-0 truncate text-[#7d8590] font-mono text-xs whitespace-nowrap">
                <HardDrive size={13} className="text-[#7d8590] shrink-0" />
                <span className="truncate" title={local}>
                  {local}
                </span>
                <button
                  type="button"
                  onClick={handleCopyLocal}
                  className="text-[#7d8590] hover:text-[#e6edf3] p-1 rounded hover:bg-[#21262d] transition-colors cursor-pointer shrink-0"
                  title="Copy local path"
                >
                  {copiedLocal ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                </button>
              </div>

              {!enabled && (
                <span className="px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider bg-[#30363d]/60 border border-[#d29922]/40 text-[#d29922] shrink-0 whitespace-nowrap">
                  Paused
                </span>
              )}
            </div>

            {/* Line 2: Status Line belonging directly to this pair */}
            <div className="flex items-center gap-2 text-xs font-mono min-w-0 whitespace-nowrap overflow-hidden">
              {syncing || isCurrentlySyncing ? (
                <div className="flex items-center gap-1.5 text-[#58a6ff] whitespace-nowrap">
                  <RefreshCw size={12} className="animate-spin text-[#58a6ff] shrink-0" />
                  <span className="truncate">Scanning Google Drive & syncing changes…</span>
                </div>
              ) : failedFiles > 0 ? (
                <div className="flex items-center gap-1.5 text-[#ff7b72] whitespace-nowrap">
                  <AlertCircle size={12} className="text-[#f85149] shrink-0" />
                  <span className="truncate">{failedFiles} transfer(s) failed • Click sync to retry</span>
                </div>
              ) : pairStatus && pairStatus.running > 0 ? (
                <div className="flex items-center gap-1.5 text-[#58a6ff] whitespace-nowrap">
                  <RefreshCw size={12} className="animate-spin text-[#58a6ff] shrink-0" />
                  <span className="truncate">Transferring files with Google Drive…</span>
                </div>
              ) : hasPending ? (
                <div className="flex items-center gap-1.5 text-[#e3b341] whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full bg-[#d29922] animate-ping shrink-0" />
                  <span className="truncate">
                    Sync pending • {syncedFiles}/{totalFiles} synced ({totalFiles - syncedFiles} remaining)
                  </span>
                </div>
              ) : isFullySynced ? (
                <div className="flex items-center gap-1.5 text-[#3fb950] whitespace-nowrap">
                  <CheckCircle2 size={12} className="text-[#3fb950] shrink-0" />
                  <span className="text-[#c9d1d9] whitespace-nowrap">Up to date with Google Drive</span>
                  {totalFiles > 0 && (
                    <>
                      <span className="text-[#30363d]">•</span>
                      <span className="text-[#8b949e] whitespace-nowrap">{syncedFiles}/{totalFiles} synced</span>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[#7d8590] whitespace-nowrap">
                  <CheckCircle2 size={12} className="text-[#7d8590] shrink-0" />
                  <span className="whitespace-nowrap">Ready to sync</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: Mode Badge + Actions + Details Button */}
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <span
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-[#21262d] text-[#c9d1d9] border border-[#30363d] shrink-0"
            title={modeInfo.description}
          >
            <ModeIcon size={12} strokeWidth={1.8} className="text-[#7d8590]" />
            {modeInfo.label}
          </span>

          <button
            type="button"
            onClick={handleSync}
            disabled={!enabled || isCurrentlySyncing}
            title="Sync this folder now"
            className="p-1.5 rounded-md text-[#7d8590] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors cursor-pointer disabled:opacity-40"
          >
            <RefreshCw
              size={14}
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
            <Trash2 size={14} strokeWidth={1.8} />
          </button>

          <div className="w-[1px] h-4 bg-[#30363d] mx-0.5" />

          <div onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              aria-label={`Toggle sync for ${folderName}`}
            />
          </div>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(id);
            }}
            className="px-2.5 py-1 rounded-md text-xs font-medium text-[#7d8590] hover:text-[#58a6ff] hover:bg-[#21262d] transition-colors cursor-pointer flex items-center gap-1 border border-transparent hover:border-[#30363d]"
            title="Open folder details page"
          >
            <span>Details</span>
            <ChevronRight size={13} />
          </button>
        </div>
      </div>

      {/* Real-time File Transfers Strip (Upload / Download over Internet) */}
      {pairEvents.length > 0 && (
        <div className="px-4 pb-3 pt-1 border-t border-[#21262d] divide-y divide-[#21262d]/60 bg-[#161b22]/50">
          {pairEvents.map((ev) => {
            const isDownload = ev.kind === "download";
            const fileName = ev.rel_path.split(/[/\\]/).pop() || ev.rel_path;
            const evPct =
              ev.bytes_total > 0
                ? Math.min(100, Math.round((ev.bytes_done / ev.bytes_total) * 100))
                : 0;
            const speed =
              ev.speed_bps && ev.speed_bps > 0
                ? formatSpeed(ev.speed_bps)
                : ev.start_ms && Date.now() - ev.start_ms > 300
                ? formatSpeed(ev.bytes_done / Math.max(0.1, (Date.now() - ev.start_ms) / 1000))
                : "";
            const eta = ev.eta_secs && ev.eta_secs > 0 ? `${formatEta(ev.eta_secs)} left` : "";

            return (
              <div key={ev.job_id} className="py-2.5 space-y-2">
                <div className="flex items-center justify-between text-xs gap-3">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {isDownload ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-[#1f6feb]/20 text-[#58a6ff] border border-[#1f6feb]/40 shrink-0">
                        <ArrowDown size={12} className="animate-bounce" />
                        Downloading from Drive
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-[#238636]/20 text-[#3fb950] border border-[#238636]/40 shrink-0">
                        <ArrowUp size={12} className="animate-bounce" />
                        Uploading to Drive
                      </span>
                    )}

                    <span
                      className="font-mono text-xs text-[#e6edf3] truncate font-medium"
                      title={ev.rel_path}
                    >
                      {fileName}
                    </span>
                    {ev.rel_path !== fileName && (
                      <span
                        className="text-[#7d8590] text-xs font-mono truncate hidden sm:inline"
                        title={ev.rel_path}
                      >
                        ({ev.rel_path})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 font-mono text-xs text-[#7d8590] shrink-0">
                    {speed && <span className="text-[#58a6ff]">{speed}</span>}
                    {speed && eta && <span>•</span>}
                    {eta && <span>{eta}</span>}
                    <span className="text-[#e6edf3] font-bold ml-1">{evPct}%</span>
                  </div>
                </div>

                <Progress
                  value={evPct}
                  aria-label={`Transfer progress for ${fileName}`}
                  className="h-1.5 bg-[#21262d]"
                />

                <div className="flex items-center justify-between text-xs font-mono text-[#7d8590]">
                  <span>
                    {formatBytes(ev.bytes_done)} of {formatBytes(ev.bytes_total)}
                  </span>
                  <span className="text-[#58a6ff] flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#58a6ff] animate-pulse" />
                    Live Google Drive transfer
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Backward-compatible alias for Vite HMR and dynamic references
export const FolderPairCard = FolderPairRow;

// ── Overview Screen ───────────────────────────────────────────────────────────

interface HomeScreenProps {
  onSelectPair?: (id: string) => void;
}

export function HomeScreen({ onSelectPair }: HomeScreenProps) {
  const gov = useStore((s) => s.gov) ?? { kind: "running" as const, reason: null, concurrency: 2 };
  const pairs = useStore((s) => s.pairs) ?? [];
  const queueStatus = useStore((s) => s.queueStatus) ?? { queued: 0, running: 0, done: 0, failed: 0 };
  const pairStatuses = useStore((s) => s.pairStatuses) ?? {};
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

  // Check if any active pair has pending files that need sync
  const anyPairPending = pairs.some((p) => {
    if (!p.enabled) return false;
    const st = pairStatuses[p.id];
    return Boolean(
      st &&
        (st.dirty > 0 ||
          st.queued > 0 ||
          st.running > 0 ||
          (st.total > 0 && st.synced < st.total))
    );
  });

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
    } catch (err) {
      toast.error(`Engine toggle failed: ${String(err)}`);
    }
  }

  async function handleSyncAll() {
    setSyncingAll(true);
    try {
      await syncNow();
      toast.success("Triggered sync cycle for all folders");
    } catch (err) {
      toast.error(`Sync cycle failed: ${String(err)}`);
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
      <div className="desktop-card p-5 sm:p-6 bg-[#0d1117] border border-[#30363d] rounded-lg shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          {/* Status Indicator & Details */}
          <div className="flex items-start sm:items-center gap-4">
            <div
              className={cn(
                "w-12 h-12 rounded-md flex items-center justify-center shrink-0 border",
                isPaused
                  ? "bg-zinc-500/10 border-zinc-500/20 text-zinc-400"
                  : isThrottled
                  ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                  : isBatchActive
                  ? "bg-blue-500/10 border-blue-500/25 text-blue-400"
                  : hasFailures
                  ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
                  : anyPairPending
                  ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
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
              ) : anyPairPending ? (
                <Clock size={22} strokeWidth={2} />
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
                    : anyPairPending
                    ? "Sync Pending"
                    : "All Files Up to Date"}
                </h1>
                {authed && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm" title="Google Drive connected" />
                )}
              </div>

              <p className="text-xs sm:text-sm text-[#7d8590] mt-1 flex items-center flex-wrap gap-x-2">
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
              className="flex items-center gap-2 bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] cursor-pointer"
            >
              {isPaused ? (
                <>
                  <Play size={14} className="text-emerald-400 fill-emerald-400" />
                  <span>Resume Engine</span>
                </>
              ) : (
                <>
                  <Pause size={14} className="text-zinc-400" />
                  <span>Pause Engine</span>
                </>
              )}
            </Button>
          </div>
        </div>

        {/* In-flight Batch Sync Progress Strip */}
        {isBatchActive && (
          <div className="mt-5 pt-4.5 border-t border-[#30363d] space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                Active Batch Progress
              </span>
              <span className="font-mono text-blue-400 font-bold">
                {displayPct.toFixed(0)}%
              </span>
            </div>
            <Progress value={displayPct} aria-label="Batch progress" className="h-2" />
            <div className="flex items-center justify-between text-xs font-mono text-[#7d8590]">
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
          <div className="mt-4 p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-300 flex items-center justify-between">
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
      <div className="rounded-lg border border-[#30363d] bg-[#0d1117] overflow-hidden shadow-sm">
        {/* GitHub Header Bar */}
        <div className="bg-[#161b22] px-4 py-3 border-b border-[#30363d] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5">
            <GithubFolderIcon className="w-4 h-4 text-[#7d8590]" />
            <span className="font-semibold text-sm text-[#e6edf3]">
              Synced Folders
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-medium bg-[#21262d] text-[#7d8590] border border-[#30363d]">
              {pairs.length}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {pairs.length > 0 && (
              <button
                type="button"
                onClick={handleSyncAll}
                disabled={syncingAll || isPaused}
                className="px-3 py-1.5 rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] hover:text-white border border-[#30363d] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                title="Trigger sync for all pairs"
              >
                <RefreshCw size={13} className={cn(syncingAll && "animate-spin text-[#58a6ff]")} />
                <span>Sync All</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="px-3 py-1.5 rounded-md bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border border-[rgba(240,246,252,0.1)] shadow-sm"
              title="Add a new folder pair"
            >
              <Plus size={14} strokeWidth={2.5} />
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
          <div className="divide-y divide-[#30363d]/60">
            {pairs.map((p) => (
              <FolderPairRow
                key={p.id}
                {...p}
                onSelect={onSelectPair}
              />
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
