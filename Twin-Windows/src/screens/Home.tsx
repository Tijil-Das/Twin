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
  RotateCcw,
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
  retryAllFailed,
  type PairEntry,
} from "@/lib/tauri";
import { progressLabel, formatBytes, formatSpeed, formatSmartEta } from "@/lib/format";
import { AddPairDialog } from "@/components/AddPairDialog";
import { GithubFolderIcon } from "@/components/ui/GithubFolderIcon";
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

  // Active in-flight transfer events for this pair from progress store
  const pairEvents = Object.values(progress).filter(
    (e): e is ProgressEvent => Boolean(e && (e as ProgressEvent).pair_id === id)
  );

  // Active jobs from SQLite pairStatus
  const runningJobs = pairStatus?.active_jobs?.filter((j) => j.status === "running") ?? [];

  // Unified list of active transfers currently working on this pair
  interface ActiveTransferView {
    jobId: number | string;
    relPath: string;
    fileName: string;
    kind: string;
    bytesDone: number;
    bytesTotal: number;
    pct: number;
    speedBps?: number;
    etaSecs?: number | null;
    isLiveByteStream: boolean;
  }

  const activeTransfers: ActiveTransferView[] = (() => {
    const list: ActiveTransferView[] = [];
    const seenPaths = new Set<string>();

    for (const ev of pairEvents) {
      const fileName = ev.rel_path.split(/[/\\]/).pop() || ev.rel_path;
      const pct =
        ev.bytes_total > 0
          ? Math.min(100, Math.round((ev.bytes_done / ev.bytes_total) * 100))
          : 0;
      seenPaths.add(ev.rel_path);
      list.push({
        jobId: ev.job_id,
        relPath: ev.rel_path,
        fileName,
        kind: ev.kind || "upload",
        bytesDone: ev.bytes_done,
        bytesTotal: ev.bytes_total,
        pct,
        speedBps: ev.speed_bps,
        etaSecs: ev.eta_secs,
        isLiveByteStream: true,
      });
    }

    for (const j of runningJobs) {
      if (!seenPaths.has(j.rel_path)) {
        const fileName = j.rel_path.split(/[/\\]/).pop() || j.rel_path;
        seenPaths.add(j.rel_path);
        list.push({
          jobId: j.id,
          relPath: j.rel_path,
          fileName,
          kind: j.kind || "upload",
          bytesDone: 0,
          bytesTotal: 0,
          pct: 0,
          isLiveByteStream: false,
        });
      }
    }

    return list;
  })();

  const isCurrentlySyncing = syncing || activeTransfers.length > 0 || (pairStatus?.running ?? 0) > 0;
  const primaryTransfer = activeTransfers[0];
  const primaryEta = primaryTransfer
    ? formatSmartEta(
        primaryTransfer.etaSecs,
        primaryTransfer.bytesTotal,
        primaryTransfer.bytesDone,
        primaryTransfer.speedBps
      )
    : null;
  const moreTransfersCount = Math.max(0, activeTransfers.length - 1);

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
              {primaryTransfer ? (
                <div className="flex items-center gap-1.5 min-w-0 text-xs">
                  {primaryTransfer.kind.toLowerCase().includes("download") ? (
                    <span className="flex items-center gap-1 text-[#58a6ff] shrink-0 font-semibold">
                      <ArrowDown size={12} className="animate-bounce text-[#58a6ff] shrink-0" />
                      Downloading:
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[#3fb950] shrink-0 font-semibold">
                      <ArrowUp size={12} className="animate-bounce text-[#3fb950] shrink-0" />
                      Uploading:
                    </span>
                  )}
                  <span
                    className="text-[#e6edf3] font-mono font-medium truncate max-w-[240px] sm:max-w-md lg:max-w-xl xl:max-w-2xl"
                    title={primaryTransfer.relPath}
                  >
                    "{primaryTransfer.fileName}"
                  </span>
                  {primaryTransfer.pct > 0 && (
                    <span className="text-[#58a6ff] font-mono font-bold shrink-0">
                      ({primaryTransfer.pct}%)
                    </span>
                  )}
                  {primaryTransfer.speedBps && primaryTransfer.speedBps > 0 ? (
                    <span className="text-[#7d8590] font-mono shrink-0 hidden sm:inline">
                      • {formatSpeed(primaryTransfer.speedBps)}
                    </span>
                  ) : null}
                  {primaryEta ? (
                    <span className="text-[#c9d1d9] font-mono shrink-0 hidden md:inline">
                      • {primaryEta}
                    </span>
                  ) : null}
                  {moreTransfersCount > 0 && (
                    <span className="text-[#7d8590] shrink-0 font-sans text-[11px]">
                      (+{moreTransfersCount} more)
                    </span>
                  )}
                </div>
              ) : syncing ? (
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

      {/* Real-time File Transfers Child Panel (Hierarchically nested under this folder pair) */}
      {activeTransfers.length > 0 && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="pb-3.5 pt-0.5 px-4 sm:pl-11 sm:pr-4 cursor-default select-none"
        >
          <div className="relative rounded-lg bg-[#080c12] border border-[#30363d]/80 p-3 shadow-inner space-y-2.5">
            {/* Visual tree branch connecting parent folder to child transfers */}
            <div
              className="hidden sm:block absolute -left-4 top-3.5 w-3 h-3 border-l-2 border-b-2 border-[#30363d] rounded-bl-md pointer-events-none"
              aria-hidden="true"
            />

            {/* Child Panel Sub-Header */}
            <div className="flex items-center justify-between text-[11px] font-medium text-[#7d8590] pb-1.5 border-b border-[#21262d]">
              <span className="flex items-center gap-1.5 text-[#58a6ff] font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] animate-pulse" />
                Active Transfers in "{folderName}" ({activeTransfers.length})
              </span>
              <span className="font-mono text-[10px] text-[#7d8590] hidden sm:inline">
                Live Drive sync
              </span>
            </div>

            {/* Active Transfer Child Items */}
            <div className="divide-y divide-[#21262d]/60 space-y-2.5">
              {activeTransfers.map((t, idx) => {
                const isDownload = t.kind.toLowerCase().includes("download");
                const speed = t.speedBps && t.speedBps > 0 ? formatSpeed(t.speedBps) : "";
                const eta = formatSmartEta(t.etaSecs, t.bytesTotal, t.bytesDone, t.speedBps);

                return (
                  <div key={t.jobId} className={cn("space-y-1.5", idx > 0 && "pt-2.5")}>
                    <div className="flex items-center justify-between text-xs gap-3">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {isDownload ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#1f6feb]/20 text-[#58a6ff] border border-[#1f6feb]/40 shrink-0">
                            <ArrowDown size={11} className="animate-bounce" />
                            Downloading
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#238636]/20 text-[#3fb950] border border-[#238636]/40 shrink-0">
                            <ArrowUp size={11} className="animate-bounce" />
                            Uploading
                          </span>
                        )}

                        <span
                          className="font-mono text-xs text-[#e6edf3] truncate font-medium"
                          title={t.relPath}
                        >
                          {t.fileName}
                        </span>
                        {t.relPath !== t.fileName && (
                          <span
                            className="text-[#7d8590] text-[11px] font-mono truncate hidden md:inline"
                            title={t.relPath}
                          >
                            ({t.relPath})
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 font-mono text-xs text-[#7d8590] shrink-0">
                        {speed && <span className="text-[#58a6ff] font-medium">{speed}</span>}
                        {speed && eta && <span>•</span>}
                        {eta && <span className="text-[#c9d1d9]">{eta}</span>}
                        {t.bytesTotal > 0 ? (
                          <span className="text-[#e6edf3] font-bold ml-1">{t.pct}%</span>
                        ) : (
                          <span className="text-[#58a6ff] font-medium ml-1">Transferring</span>
                        )}
                      </div>
                    </div>

                    <Progress
                      value={t.bytesTotal > 0 ? t.pct : 100}
                      aria-label={`Transfer progress for ${t.fileName}`}
                      className={cn("h-1.5 bg-[#161b22]", t.bytesTotal === 0 && "animate-pulse")}
                    />

                    <div className="flex items-center justify-between text-[11px] font-mono text-[#7d8590]">
                      <span>
                        {t.bytesTotal > 0
                          ? `${formatBytes(t.bytesDone)} of ${formatBytes(t.bytesTotal)}`
                          : "Connecting & transferring…"}
                      </span>
                      {t.bytesTotal > 0 && t.pct > 0 && (
                        <span className="text-[10px] text-[#7d8590]">
                          {formatBytes(Math.max(0, t.bytesTotal - t.bytesDone))} remaining
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
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
  onNavigate?: (screen: "home" | "activity" | "settings") => void;
}

export function HomeScreen({ onSelectPair, onNavigate }: HomeScreenProps) {
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
  const [retryingAll, setRetryingAll] = useState(false);

  const handleRetryAll = async () => {
    setRetryingAll(true);
    try {
      const count = await retryAllFailed();
      toast.success(`Re-queued ${count} failed transfer${count === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(`Retry failed: ${String(e)}`);
    } finally {
      setRetryingAll(false);
    }
  };

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
  const totalBatchSpeed = activeEvents.reduce((a, e) => a + (e.speed_bps || 0), 0);
  const batchRemainingBytes = Math.max(0, activeTotal - activeDone);
  const batchEtaSecs =
    totalBatchSpeed > 0 && batchRemainingBytes > 0 ? batchRemainingBytes / totalBatchSpeed : null;
  const batchEta = formatSmartEta(batchEtaSecs, batchRemainingBytes, activeDone, totalBatchSpeed);

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
    <div className="p-6 sm:p-8 w-full space-y-6 pb-20">
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
          <div className="mt-5 pt-4 border-t border-[#30363d] space-y-2.5">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
                Active Batch Progress
              </span>
              <span className="font-mono text-blue-400 font-bold">
                {displayPct.toFixed(0)}%
              </span>
            </div>
            <Progress value={displayPct} aria-label="Batch progress" className="h-2" />
            <div className="flex items-center justify-between text-xs font-mono text-[#7d8590]">
              <div className="flex items-center gap-1.5 min-w-0 truncate">
                <span>
                  {totalJobs > 0
                    ? `${queueStatus.done ?? 0} of ${totalJobs} completed`
                    : progressLabel(activeDone, activeTotal, startMs)}
                </span>
                {totalBatchSpeed > 0 && (
                  <>
                    <span>•</span>
                    <span className="text-[#58a6ff] font-semibold">{formatSpeed(totalBatchSpeed)}</span>
                  </>
                )}
                {batchEta && (
                  <>
                    <span>•</span>
                    <span className="text-[#c9d1d9]">{batchEta}</span>
                  </>
                )}
              </div>
              <span className="shrink-0 ml-2">
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
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={retryingAll}
                onClick={handleRetryAll}
                className="text-xs text-red-300 hover:text-white font-medium hover:underline bg-transparent border-none p-0 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <RotateCcw className={cn("w-3 h-3", retryingAll && "animate-spin")} />
                <span>Retry all</span>
              </button>
              <span className="text-red-500/30">•</span>
              <button
                type="button"
                onClick={() => onNavigate?.("activity")}
                className="text-xs text-red-400 font-semibold hover:underline cursor-pointer bg-transparent border-none p-0 flex items-center gap-1"
              >
                <span>View Activity ledger</span>
                <span>→</span>
              </button>
            </div>
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
