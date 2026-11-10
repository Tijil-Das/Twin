/**
 * Pair Detail Screen
 * Dedicated full-page view for deep inspection, live telemetry,
 * file activity, and controls for an individual synced folder pair.
 */
import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  RefreshCw,
  Trash2,
  HardDrive,
  ExternalLink,
  FolderOpen,
  Copy,
  Check,
  CheckCircle2,
  AlertCircle,
  Clock,
  Layers,
  ShieldCheck,
  ShieldAlert,
  ArrowUp,
  ArrowDown,
  FolderTree,
  CheckSquare,
  Square,
  FileCode,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useStore, type ProgressEvent } from "@/store";
import {
  runSyncCycle,
  removePair,
  getConfig,
  updateConfig,
  queueStatus,
  getPairStatuses,
  openLocalPath,
  openUrlExternal,
  listPairSubfolders,
  verifyPairIntegrity,
  repairPairMismatches,
  type PairEntry,
  type SubfolderItem,
  type IntegrityReport,
} from "@/lib/tauri";
import { formatBytes, formatSpeed, formatSmartEta, formatRelTime } from "@/lib/format";
import { toast } from "sonner";
import gdLogo from "@/assets/gd-icon.png";
import { GithubFolderIcon } from "@/components/ui/GithubFolderIcon";
import { cn } from "@/lib/utils";

const SYNC_MODES = {
  two_way: {
    label: "Two-Way Sync",
    badge: "Two-Way",
    description: "Bidirectional continuous replication. Changes made locally or in Google Drive propagate both ways automatically.",
  },
  upload: {
    label: "Cloud Backup",
    badge: "Backup",
    description: "One-way upload. Local edits sync to Google Drive. Remote changes will never modify or overwrite local files.",
  },
  mirror: {
    label: "Cloud Mirror",
    badge: "Mirror",
    description: "Strict mirror. Keeps the remote Google Drive directory as an exact replica of the local directory state.",
  },
};

interface Props {
  pairId: string;
  onBack: () => void;
}

export function PairDetailScreen({ pairId, onBack }: Props) {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const setQueueStatus = useStore((s) => s.setQueueStatus);
  const setPairStatuses = useStore((s) => s.setPairStatuses);
  const pairs = useStore((s) => s.pairs) ?? [];
  const pairStatuses = useStore((s) => s.pairStatuses) ?? {};
  const allActivity = useStore((s) => s.activity) ?? [];
  const progress = useStore((s) => s.progress) ?? {};

  const pair = pairs.find((p) => p.id === pairId);
  const pairStatus = pairStatuses[pairId];

  const [syncing, setSyncing] = useState(false);
  const [copiedLocal, setCopiedLocal] = useState(false);
  const [copiedDrive, setCopiedDrive] = useState(false);

  if (!pair) {
    return (
      <div className="p-6 sm:p-8 w-full space-y-4">
        <button
          onClick={onBack}
          className="text-xs text-[#7d8590] hover:text-[#e6edf3] flex items-center gap-1.5 cursor-pointer"
        >
          <ArrowLeft size={14} />
          <span>Back to Overview</span>
        </button>
        <div className="p-8 text-center bg-[#161b22] border border-[#30363d] rounded-xl text-[#8b949e]">
          Folder pair not found or has been removed.
        </div>
      </div>
    );
  }

  const folderName = pair.local.replace(/[/\\]$/, "").split(/[/\\]/).pop() || pair.local;
  const modeInfo = SYNC_MODES[pair.mode as keyof typeof SYNC_MODES] ?? SYNC_MODES.two_way;

  // Active in-flight transfers for this pair from progress store
  // (includes completed transfers briefly so the activity dropdown shows
  // during upload and confirms completion before numbers update)
  const pairEvents = Object.values(progress).filter(
    (e): e is ProgressEvent => Boolean(e && (e as ProgressEvent).pair_id === pairId)
  );

  const runningJobs = pairStatus?.active_jobs?.filter((j) => j.status === "running") ?? [];

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

    // Always keep the currently active transferring item at the top of the dropdown list
    list.sort((a, b) => {
      const aIsActive = (a.speedBps ?? 0) > 0 || (a.isLiveByteStream && a.bytesDone > 0);
      const bIsActive = (b.speedBps ?? 0) > 0 || (b.isLiveByteStream && b.bytesDone > 0);

      if (aIsActive && !bIsActive) return -1;
      if (!aIsActive && bIsActive) return 1;

      if (a.isLiveByteStream && !b.isLiveByteStream) return -1;
      if (!a.isLiveByteStream && b.isLiveByteStream) return 1;

      if (typeof a.jobId === "number" && typeof b.jobId === "number") {
        return a.jobId - b.jobId;
      }
      return 0;
    });

    return list;
  })();

  const isCurrentlySyncing =
    syncing ||
    Boolean(pairStatus?.is_syncing) ||
    activeTransfers.length > 0 ||
    (pairStatus?.running ?? 0) > 0 ||
    (pairStatus?.queued ?? 0) > 0;

  // Activity events for this pair (historical DB records)
  const pairActivities = allActivity.filter((a) => a.pair_id === pairId);

  // Real-time in-flight progress merged into activity display so uploads
  // show during transfer (like delete-from-cloud) before numbers update.
  const realTimeActivities = pairEvents.map((ev) => ({
    id: `rt-${ev.job_id}`,
    pair_id: ev.pair_id,
    rel_path: ev.rel_path,
    kind: ev.kind || "upload",
    result: ev.bytes_done >= ev.bytes_total && ev.bytes_total > 0 ? "ok" : "pending",
    ts_ms: ev.start_ms,
    detail: ev.bytes_total > 0 ? `${Math.round((ev.bytes_done / ev.bytes_total) * 100)}%` : undefined,
    bytes_done: ev.bytes_done,
    bytes_total: ev.bytes_total,
    isRealTime: true,
  }));

  // Combine: real-time first, then historical (dedupe by rel_path+kind)
  const allPairActivities = [
    ...realTimeActivities,
    ...pairActivities.filter(
      (a) =>
        !realTimeActivities.some(
          (rt) => rt.rel_path === a.rel_path && rt.kind === a.kind
        )
    ),
  ];

  const totalFiles = pairStatus?.total ?? 0;
  const syncedFiles = pairStatus?.synced ?? 0;
  const pendingFiles = (pairStatus?.dirty ?? 0) + (pairStatus?.queued ?? 0);
  const failedFiles = pairStatus?.failed ?? 0;
  const conflictFiles = pairStatus?.conflict ?? 0;
  const deletedFiles = pairStatus?.deleted ?? 0;

  const isFullySynced = Boolean(
    pairStatus?.is_synced &&
      activeTransfers.length === 0 &&
      !syncing &&
      !pairStatus?.is_syncing &&
      (totalFiles === 0 || syncedFiles === totalFiles) &&
      pendingFiles === 0 &&
      failedFiles === 0 &&
      conflictFiles === 0
  );

  const hasPending = Boolean(
    activeTransfers.length === 0 &&
      !syncing &&
      !pairStatus?.is_syncing &&
      pairStatus &&
      (pendingFiles > 0 || (totalFiles > 0 && syncedFiles < totalFiles))
  );

  async function handleSync() {
    setSyncing(true);
    try {
      await runSyncCycle(pairId);
      const [qs, ps] = await Promise.all([queueStatus(), getPairStatuses()]);
      setQueueStatus(qs);
      setPairStatuses(ps);
      toast.success(`Sync cycle completed for "${folderName}"`);
    } catch (err) {
      toast.error(`Sync error: ${String(err)}`);
    } finally {
      setTimeout(() => setSyncing(false), 800);
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
        p.id === pairId ? { ...p, enabled: enable } : p
      );
      const nextCfg = { ...config, pairs: nextPairs, pair: nextPairs };
      await updateConfig(nextCfg);
      const reloaded = await getConfig();
      setConfig(reloaded);

      // When disabling a pair, immediately clear its in-flight UI state so
      // active transfers / syncing indicators stop showing right away.
      if (!enable) {
        const clearPairProgress = useStore.getState().clearPairProgress;
        const clearPairStatus = useStore.getState().clearPairStatus;
        clearPairProgress(pairId);
        clearPairStatus(pairId);
      }
      toast.info(enable ? `Resumed sync for "${folderName}"` : `Paused sync for "${folderName}"`);
    } catch (err) {
      toast.error(`Failed to update pair: ${String(err)}`);
    }
  }

  async function handleRemove() {
    try {
      await removePair(pairId);
      const cfg = await getConfig();
      setConfig(cfg);
      toast.success(`Removed "${folderName}"`);
      onBack();
    } catch (err) {
      toast.error(`Failed to remove pair: ${String(err)}`);
    }
  }

  function handleCopyLocal() {
    void navigator.clipboard.writeText(pair?.local || "");
    setCopiedLocal(true);
    setTimeout(() => setCopiedLocal(false), 2000);
    toast.success("Local folder path copied");
  }

  function handleCopyDrive() {
    void navigator.clipboard.writeText(pair?.drive_folder_id || "");
    setCopiedDrive(true);
    setTimeout(() => setCopiedDrive(false), 2000);
    toast.success("Google Drive folder ID copied");
  }

  async function handleOpenLocal() {
    if (!pair?.local) return;
    try {
      await openLocalPath(pair.local);
    } catch (err) {
      toast.error(`Cannot open local folder: ${String(err)}`);
    }
  }

  async function handleOpenDrive() {
    if (!pair?.drive_folder_id) return;
    const url = `https://drive.google.com/drive/folders/${pair.drive_folder_id}`;
    try {
      await openUrlExternal(url);
    } catch (err) {
      toast.error(`Cannot open Google Drive: ${String(err)}`);
    }
  }

  // ── Selective Sync & Subfolders ──
  const [subfolders, setSubfolders] = useState<SubfolderItem[]>([]);
  const [loadingSubfolders, setLoadingSubfolders] = useState(false);
  const [newExcludePattern, setNewExcludePattern] = useState("");

  const loadSubfolders = useCallback(async () => {
    setLoadingSubfolders(true);
    try {
      const items = await listPairSubfolders(pairId);
      setSubfolders(items);
    } catch (e) {
      console.warn("Failed to list subfolders:", e);
    } finally {
      setLoadingSubfolders(false);
    }
  }, [pairId]);

  useEffect(() => {
    void loadSubfolders();
  }, [loadSubfolders]);

  async function handleToggleSubfolder(relPath: string) {
    if (!config) return;
    const currentExcluded = pair?.excluded_folders ?? [];
    const isCurrentlyExcluded = currentExcluded.includes(relPath);
    const updated = isCurrentlyExcluded
      ? currentExcluded.filter((p) => p !== relPath)
      : [...currentExcluded, relPath];

    const updatedPairs = (config.pairs ?? []).map((p) =>
      p.id === pairId ? { ...p, excluded_folders: updated } : p
    );
    try {
      await updateConfig({ ...config, pairs: updatedPairs });
      setConfig({ ...config, pairs: updatedPairs });
      toast.success(
        isCurrentlyExcluded
          ? `Included "${relPath}" in synchronization`
          : `Excluded "${relPath}" from synchronization`
      );
      void loadSubfolders();
    } catch (e) {
      toast.error(`Failed to update selective sync: ${String(e)}`);
    }
  }

  async function handleAddPairExclude() {
    if (!newExcludePattern.trim() || !config) return;
    const p = newExcludePattern.trim();
    const current = pair?.exclude ?? [];
    if (current.includes(p)) {
      toast.error(`"${p}" is already in ignore rules`);
      return;
    }
    const updated = [...current, p];
    const updatedPairs = (config.pairs ?? []).map((item) =>
      item.id === pairId ? { ...item, exclude: updated } : item
    );
    try {
      await updateConfig({ ...config, pairs: updatedPairs });
      setConfig({ ...config, pairs: updatedPairs });
      setNewExcludePattern("");
      toast.success(`Added "${p}" to folder ignore rules`);
    } catch (e) {
      toast.error(`Failed to add pattern: ${String(e)}`);
    }
  }

  async function handleRemovePairExclude(pattern: string) {
    if (!config) return;
    const current = pair?.exclude ?? [];
    const updated = current.filter((x) => x !== pattern);
    const updatedPairs = (config.pairs ?? []).map((item) =>
      item.id === pairId ? { ...item, exclude: updated } : item
    );
    try {
      await updateConfig({ ...config, pairs: updatedPairs });
      setConfig({ ...config, pairs: updatedPairs });
      toast.success(`Removed "${pattern}" from folder ignore rules`);
    } catch (e) {
      toast.error(`Failed to remove pattern: ${String(e)}`);
    }
  }

  // ── On-Demand Hash Integrity Audit ──
  const [verifyingIntegrity, setVerifyingIntegrity] = useState(false);
  const [integrityReport, setIntegrityReport] = useState<IntegrityReport | null>(null);
  const [repairing, setRepairing] = useState(false);

  async function handleVerifyIntegrity() {
    setVerifyingIntegrity(true);
    setIntegrityReport(null);
    try {
      const report = await verifyPairIntegrity(pairId);
      setIntegrityReport(report);
      if (report.mismatches.length === 0 && report.local_missing.length === 0 && report.remote_missing.length === 0) {
        toast.success(`Integrity verified! All ${report.total_scanned} files match cloud checksums.`);
      } else {
        toast.warning(
          `Found ${report.mismatches.length} checksum mismatches and ${report.local_missing.length + report.remote_missing.length} unaligned files.`
        );
      }
    } catch (e) {
      toast.error(`Integrity check failed: ${String(e)}`);
    } finally {
      setVerifyingIntegrity(false);
    }
  }

  async function handleRepairMismatches() {
    if (!integrityReport) return;
    const toRepair = [
      ...integrityReport.mismatches.map((m) => m.rel_path),
      ...integrityReport.remote_missing,
    ];
    if (toRepair.length === 0) return;
    setRepairing(true);
    try {
      const count = await repairPairMismatches(pairId, toRepair);
      toast.success(`Enqueued ${count} files for repair and cloud re-alignment`);
      void handleVerifyIntegrity();
    } catch (e) {
      toast.error(`Repair failed: ${String(e)}`);
    } finally {
      setRepairing(false);
    }
  }

  return (
    <div className="p-6 sm:p-8 w-full max-w-[980px] mx-auto space-y-6 pb-20">
      {/* ── Top Navigation Bar & Breadcrumb ── */}
      <div className="flex items-center justify-between pb-3 border-b border-[#30363d]/70">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 text-xs font-medium text-[#7d8590] hover:text-[#e6edf3] transition-colors cursor-pointer group"
        >
          <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
          <span>Back to Overview</span>
        </button>

        <div className="flex items-center gap-2 text-xs font-mono text-[#7d8590]">
          <span>Pairs</span>
          <span className="text-[#30363d]">/</span>
          <span className="text-[#e6edf3] font-semibold">{folderName}</span>
        </div>
      </div>

      {/* ── Page Header (Clean, Aligned, Professional) ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              {folderName}
            </h1>

            {/* Live Status Pill */}
            {activeTransfers.length > 0 || (pairStatus && pairStatus.running > 0) ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30 whitespace-nowrap">
                <RefreshCw size={12} className="animate-spin" /> Transferring
              </span>
            ) : syncing || Boolean(pairStatus?.is_syncing) ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30 whitespace-nowrap">
                <RefreshCw size={12} className="animate-spin" /> Scanning & Syncing
              </span>
            ) : isFullySynced ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">
                <CheckCircle2 size={12} /> Up to date
              </span>
            ) : hasPending ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 whitespace-nowrap">
                <Clock size={12} /> Sync pending ({totalFiles - syncedFiles} remaining)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#21262d] text-[#7d8590] border border-[#30363d] whitespace-nowrap">
                <CheckCircle2 size={12} /> Ready
              </span>
            )}

            <span className="px-2 py-0.5 rounded-md text-xs font-mono font-medium bg-[#21262d] text-[#c9d1d9] border border-[#30363d] whitespace-nowrap">
              {modeInfo.label}
            </span>

            {!pair.enabled && (
              <span className="px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider bg-[#30363d]/60 border border-[#d29922]/40 text-[#d29922] whitespace-nowrap">
                Paused
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs font-mono text-[#7d8590] flex-wrap">
            <HardDrive size={13} className="text-[#7d8590] shrink-0" />
            <span className="text-[#c9d1d9]">{pair.local}</span>
            <button
              type="button"
              onClick={handleCopyLocal}
              className="text-[#7d8590] hover:text-[#e6edf3] p-0.5 rounded transition-colors cursor-pointer"
              title="Copy local path"
            >
              {copiedLocal ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
            <span className="text-[#30363d]">•</span>
            <span>Last verified: {pairStatus?.last_sync_ms ? formatRelTime(pairStatus.last_sync_ms) : "just now"}</span>
          </div>
        </div>

        {/* Primary Actions Toolbar */}
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <Button
            variant="secondary"
            onClick={handleSync}
            disabled={!pair.enabled || isCurrentlySyncing}
            className="h-8 px-3 text-xs font-semibold bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw size={13} className={cn(isCurrentlySyncing && "animate-spin text-[#58a6ff]")} />
            <span>Sync Now</span>
          </Button>

          <Button
            variant="secondary"
            onClick={handleOpenLocal}
            className="h-8 px-3 text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] cursor-pointer flex items-center gap-1.5"
          >
            <FolderOpen size={13} />
            <span>Explorer</span>
          </Button>

          <Button
            variant="secondary"
            onClick={handleOpenDrive}
            className="h-8 px-3 text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] cursor-pointer flex items-center gap-1.5"
          >
            <ExternalLink size={13} />
            <span>Drive</span>
          </Button>

          <div className="w-[1px] h-4 bg-[#30363d] mx-0.5" />

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[#7d8590] font-medium">Sync:</span>
            <Switch checked={pair.enabled} onCheckedChange={handleToggle} />
          </div>

          <button
            type="button"
            onClick={handleRemove}
            className="p-1.5 rounded-md text-[#7d8590] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors cursor-pointer"
            title="Remove folder pair"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* ── Key Metrics Summary Bar (Clean, Balanced 4-Column Strip) ── */}
      <div className="rounded-xl border border-[#30363d] bg-[#0d1117] grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-[#30363d] overflow-hidden shadow-sm">
        {/* 1. Synced */}
        <div className="p-4 space-y-1">
          <span className="text-xs font-medium text-[#7d8590] flex items-center gap-1.5 whitespace-nowrap">
            <CheckCircle2 size={13} className="text-emerald-400" />
            Synced Files
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold text-emerald-400 font-mono">{syncedFiles}</span>
            <span className="text-xs text-[#7d8590] font-mono">/ {totalFiles}</span>
          </div>
          <span className="text-[11px] text-[#7d8590] block">
            {totalFiles > 0 ? `${Math.round((syncedFiles / totalFiles) * 100)}% verified in cloud` : "Up to date"}
          </span>
        </div>

        {/* 2. Pending */}
        <div className="p-4 space-y-1">
          <span className="text-xs font-medium text-[#7d8590] flex items-center gap-1.5 whitespace-nowrap">
            <Clock size={13} className="text-amber-400" />
            Pending Changes
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className={cn("text-2xl font-bold font-mono", pendingFiles > 0 ? "text-amber-400" : "text-white")}>
              {pendingFiles}
            </span>
            <span className="text-xs text-[#7d8590]">files</span>
          </div>
          <span className="text-[11px] text-[#7d8590] block">
            {pendingFiles > 0 ? "Awaiting sync cycle" : "No pending changes"}
          </span>
        </div>

        {/* 3. In Trash */}
        <div className="p-4 space-y-1">
          <span className="text-xs font-medium text-[#7d8590] flex items-center gap-1.5 whitespace-nowrap">
            <Trash2 size={13} className="text-[#8b949e]" />
            Drive Trash
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold text-white font-mono">{deletedFiles}</span>
            <span className="text-xs text-[#7d8590]">files</span>
          </div>
          <span className="text-[11px] text-[#7d8590] block">30-day recovery window</span>
        </div>

        {/* 4. Errors & Conflicts */}
        <div className="p-4 space-y-1">
          <span className="text-xs font-medium text-[#7d8590] flex items-center gap-1.5 whitespace-nowrap">
            <AlertCircle size={13} className={failedFiles + conflictFiles > 0 ? "text-red-400" : "text-[#7d8590]"} />
            Sync Issues
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className={cn("text-2xl font-bold font-mono", failedFiles + conflictFiles > 0 ? "text-red-400" : "text-white")}>
              {failedFiles + conflictFiles}
            </span>
            <span className="text-xs text-[#7d8590]">errors</span>
          </div>
          <span className="text-[11px] text-[#7d8590] block">
            {failedFiles + conflictFiles > 0 ? "Attention required" : "Healthy & clear"}
          </span>
        </div>
      </div>

      {/* ── Folder Configuration & Storage Paths (Unified Property Sheet) ── */}
      <div className="rounded-xl border border-[#30363d] bg-[#0d1117] overflow-hidden shadow-sm">
        <div className="px-5 py-3 bg-[#161b22] border-b border-[#30363d] flex items-center justify-between">
          <span className="text-xs font-semibold text-[#e6edf3] flex items-center gap-2">
            <Layers size={14} className="text-[#58a6ff]" />
            Folder Configuration & Storage Paths
          </span>
          <span className="text-[11px] font-mono text-[#7d8590]">
            Pair ID: {pair.id.slice(0, 8)}…
          </span>
        </div>

        <div className="divide-y divide-[#30363d]/60 text-xs">
          {/* Row 1: Local Path */}
          <div className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5 sm:max-w-xs">
              <span className="font-semibold text-[#e6edf3] flex items-center gap-1.5">
                <HardDrive size={13} className="text-[#58a6ff]" />
                Local Storage Directory
              </span>
              <p className="text-[#7d8590] text-[11px]">
                Local filesystem directory monitored for file changes
              </p>
            </div>

            <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
              <div className="px-3 py-1.5 rounded-lg bg-[#161b22] border border-[#30363d] font-mono text-xs text-[#c9d1d9] truncate select-all max-w-md lg:max-w-xl xl:max-w-3xl" title={pair.local}>
                {pair.local}
              </div>
              <Button
                variant="secondary"
                onClick={handleOpenLocal}
                className="h-7 px-2.5 text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] border border-[#30363d] shrink-0 cursor-pointer flex items-center gap-1"
              >
                <FolderOpen size={12} />
                <span>Explorer</span>
              </Button>
              <Button
                variant="secondary"
                onClick={handleCopyLocal}
                className="h-7 px-2.5 text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] border border-[#30363d] shrink-0 cursor-pointer flex items-center gap-1"
              >
                {copiedLocal ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                <span>Copy</span>
              </Button>
            </div>
          </div>

          {/* Row 2: Google Drive Target */}
          <div className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5 sm:max-w-xs">
              <span className="font-semibold text-[#e6edf3] flex items-center gap-1.5">
                <img src={gdLogo} alt="Drive" className="w-3.5 h-3.5 object-contain shrink-0" />
                Google Drive Target Folder
              </span>
              <p className="text-[#7d8590] text-[11px]">
                Connected target directory in Google Drive
              </p>
            </div>

            <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
              <div className="px-3 py-1.5 rounded-lg bg-[#161b22] border border-[#30363d] font-mono text-xs text-[#c9d1d9] truncate select-all max-w-md lg:max-w-xl xl:max-w-3xl" title={pair.drive_folder_id || "Root"}>
                {pair.drive_folder_id ? `ID: ${pair.drive_folder_id}` : "My Drive (Root)"}
              </div>
              <Button
                variant="secondary"
                onClick={handleOpenDrive}
                className="h-7 px-2.5 text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] border border-[#30363d] shrink-0 cursor-pointer flex items-center gap-1"
              >
                <ExternalLink size={12} />
                <span>Drive</span>
              </Button>
              <Button
                variant="secondary"
                onClick={handleCopyDrive}
                className="h-7 px-2.5 text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] border border-[#30363d] shrink-0 cursor-pointer flex items-center gap-1"
              >
                {copiedDrive ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                <span>Copy ID</span>
              </Button>
            </div>
          </div>

          {/* Row 3: Sync Mode & Topology */}
          <div className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <span className="font-semibold text-[#e6edf3] flex items-center gap-1.5">
                <Layers size={13} className="text-[#58a6ff]" />
                Sync Topology & Mode
              </span>
              <p className="text-[#7d8590] text-[11px]">
                {modeInfo.description}
              </p>
            </div>

            <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-[#161b22] text-[#c9d1d9] border border-[#30363d] shrink-0 self-start sm:self-auto">
              {modeInfo.label}
            </span>
          </div>

          {/* Row 4: Deletion Safety */}
          <div className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <span className="font-semibold text-[#e6edf3] flex items-center gap-1.5">
                <ShieldCheck size={13} className="text-emerald-400" />
                Remote Deletion Safety
              </span>
              <p className="text-[#7d8590] text-[11px]">
                {pair.deletion === "delete"
                  ? "Files deleted locally are immediately purged permanently on Google Drive."
                  : "Files deleted locally are moved to Google Drive Trash for safe 30-day recovery."}
              </p>
            </div>

            <span className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium border shrink-0 self-start sm:self-auto",
              pair.deletion === "delete"
                ? "bg-red-500/10 text-red-400 border-red-500/30"
                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            )}>
              {pair.deletion === "delete" ? "Permanent Deletion" : "Drive Trash (30-day recovery)"}
            </span>
          </div>
        </div>
      </div>

      {/* ── Data Integrity & Hash Verification ── */}
      <div className="rounded-xl border border-[#30363d] bg-[#0d1117] overflow-hidden shadow-sm">
        <div className="px-5 py-3 bg-[#161b22] border-b border-[#30363d] flex items-center justify-between">
          <span className="text-xs font-semibold text-[#e6edf3] flex items-center gap-2">
            <ShieldCheck size={14} className="text-[#3fb950]" />
            On-Demand Hash Integrity & Cloud Verification
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleVerifyIntegrity}
            disabled={verifyingIntegrity || syncing}
            className="h-7 px-3 text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw size={12} className={cn(verifyingIntegrity && "animate-spin text-[#58a6ff]")} />
            <span>{verifyingIntegrity ? "Auditing Checksums…" : "Verify Integrity"}</span>
          </Button>
        </div>

        <div className="p-5 space-y-3 text-xs">
          <p className="text-[#7d8590] leading-relaxed">
            Directly cross-checks the cryptographic MD5 hash of every local file on disk against Google Drive's cloud checksum to guarantee 100% data integrity and detect silent bit rot.
          </p>

          {integrityReport && (
            <div className="mt-3 space-y-3">
              {integrityReport.mismatches.length === 0 &&
              integrityReport.local_missing.length === 0 &&
              integrityReport.remote_missing.length === 0 ? (
                <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-3 text-emerald-400">
                  <CheckCircle2 size={18} className="shrink-0" />
                  <div>
                    <div className="font-semibold text-white">100% Verified Match</div>
                    <div className="text-[11px] text-emerald-300">
                      All {integrityReport.total_scanned} files on disk bit-for-bit match remote Google Drive MD5 checksums ({integrityReport.duration_ms}ms).
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-amber-300 font-semibold">
                      <ShieldAlert size={16} className="text-amber-400" />
                      <span>
                        Integrity Discrepancies Found ({integrityReport.mismatches.length} mismatches,{" "}
                        {integrityReport.remote_missing.length} unaligned)
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleRepairMismatches}
                      disabled={repairing}
                      className="h-7 px-3 text-xs font-semibold bg-[#238636] hover:bg-[#2ea043] text-white cursor-pointer"
                    >
                      <RefreshCw size={11} className={cn("mr-1", repairing && "animate-spin")} />
                      {repairing ? "Enqueuing…" : "Repair & Resync Mismatches"}
                    </Button>
                  </div>

                  {integrityReport.mismatches.length > 0 && (
                    <div className="max-h-36 overflow-y-auto space-y-1 divide-y divide-[#30363d]/50 pr-1">
                      {integrityReport.mismatches.map((m) => (
                        <div key={m.rel_path} className="pt-1.5 flex items-center justify-between text-[11px] font-mono">
                          <span className="text-[#e6edf3] truncate max-w-xs">{m.rel_path}</span>
                          <span className="text-[#7d8590] shrink-0">
                            Local: <span className="text-amber-400">{m.local_md5.slice(0, 8)}…</span> | Drive:{" "}
                            <span className="text-blue-400">{m.drive_md5.slice(0, 8)}…</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Selective Subfolder Sync & Pair Exclude Rules ── */}
      <div className="rounded-xl border border-[#30363d] bg-[#0d1117] overflow-hidden shadow-sm">
        <div className="px-5 py-3 bg-[#161b22] border-b border-[#30363d] flex items-center justify-between">
          <span className="text-xs font-semibold text-[#e6edf3] flex items-center gap-2">
            <FolderTree size={14} className="text-[#58a6ff]" />
            Selective Sync & Folder-Specific Exclusions
          </span>
          <button
            type="button"
            onClick={() => void loadSubfolders()}
            disabled={loadingSubfolders}
            className="text-[11px] text-[#7d8590] hover:text-[#58a6ff] flex items-center gap-1 cursor-pointer transition-colors"
          >
            <RefreshCw size={11} className={cn(loadingSubfolders && "animate-spin")} />
            <span>Refresh Subfolders</span>
          </button>
        </div>

        <div className="p-5 space-y-5 text-xs">
          {/* Subfolders list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-white">Subfolders in this Directory</span>
              <span className="text-[11px] text-[#7d8590]">
                Uncheck a subfolder to omit it from cloud replication
              </span>
            </div>

            {loadingSubfolders ? (
              <div className="p-4 text-center text-[#7d8590]">
                <RefreshCw size={14} className="animate-spin inline mr-2 text-[#58a6ff]" />
                Scanning subfolders…
              </div>
            ) : subfolders.length === 0 ? (
              <div className="p-4 rounded-lg bg-[#161b22] border border-[#30363d] text-center text-[#7d8590]">
                No top-level subfolders found in this directory.
              </div>
            ) : (
              <div className="border border-[#30363d] rounded-lg divide-y divide-[#30363d]/60 bg-[#161b22]">
                {subfolders.map((sf) => {
                  const isChecked = !sf.is_excluded;
                  return (
                    <div
                      key={sf.rel_path}
                      onClick={() => handleToggleSubfolder(sf.rel_path)}
                      className={cn(
                        "px-4 py-2.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-[#21262d] transition-colors select-none",
                        !isChecked && "opacity-60 bg-[#0d1117]/50"
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {isChecked ? (
                          <CheckSquare size={16} className="text-[#58a6ff] shrink-0" />
                        ) : (
                          <Square size={16} className="text-[#7d8590] shrink-0" />
                        )}
                        <GithubFolderIcon size={16} className={isChecked ? "text-[#54aeff]" : "text-[#7d8590]"} />
                        <span className={cn("font-medium truncate", isChecked ? "text-[#e6edf3]" : "text-[#7d8590] line-through")}>
                          {sf.name}/
                        </span>
                      </div>

                      <div className="flex items-center gap-2.5 shrink-0 text-[11px] font-mono">
                        {sf.file_count > 0 && (
                          <span className="text-[#7d8590]">
                            {sf.file_count} files • {formatBytes(sf.total_bytes)}
                          </span>
                        )}
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded text-[10px] font-semibold border",
                            isChecked
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                              : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                          )}
                        >
                          {isChecked ? "Syncing" : "Excluded"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Folder-specific exclude globs */}
          <div className="pt-4 border-t border-[#30363d]/70">
            <span className="font-semibold text-white block mb-1">Pair Ignore Patterns (Globs)</span>
            <p className="text-[#7d8590] text-[11px] mb-3">
              Patterns entered here apply only to this folder pair (e.g. <code className="text-[#58a6ff]">node_modules/**</code>, <code className="text-[#58a6ff]">*.tmp</code>).
            </p>

            {/* Pattern Badges */}
            <div className="flex flex-wrap gap-2 mb-3">
              {(pair.exclude ?? []).map((pat) => (
                <span
                  key={pat}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-[#161b22] text-[#c9d1d9] border border-[#30363d]"
                >
                  <FileCode size={12} className="text-[#7d8590]" />
                  <span>{pat}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemovePairExclude(pat);
                    }}
                    className="text-[#7d8590] hover:text-[#f85149] p-0.5 rounded hover:bg-[#f85149]/10 transition-colors cursor-pointer"
                    title={`Remove ${pat}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {(pair.exclude ?? []).length === 0 && (
                <span className="text-[11px] text-[#7d8590] italic">No folder-specific patterns added yet.</span>
              )}
            </div>

            {/* Input to add pattern */}
            <div className="flex items-center gap-2">
              <Input
                value={newExcludePattern}
                onChange={(e) => setNewExcludePattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddPairExclude();
                  }
                }}
                placeholder="e.g. *.tmp, build/**, cache/"
                className="font-mono text-xs max-w-sm h-8 bg-[#161b22] border-[#30363d] text-[#e6edf3]"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleAddPairExclude}
                disabled={!newExcludePattern.trim()}
                className="h-8 flex items-center gap-1.5 text-xs bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-[#e6edf3] cursor-pointer"
              >
                <Plus size={13} />
                <span>Add Pattern</span>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── In-Flight Real-Time Transfers (Only when transfers active) ── */}
      {activeTransfers.length > 0 && (
        <div className="p-5 rounded-xl bg-[#0d1117] border border-[#1f6feb]/40 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#58a6ff] animate-ping" />
              Live In-Flight Transfers ({activeTransfers.length})
            </span>
          </div>

          <div className="divide-y divide-[#30363d]/60">
            {activeTransfers.map((t) => {
              const isDownload = t.kind.toLowerCase().includes("download");
              const speed = t.speedBps && t.speedBps > 0 ? formatSpeed(t.speedBps) : "";
              const eta = formatSmartEta(t.etaSecs, t.bytesTotal, t.bytesDone, t.speedBps);

              return (
                <div key={t.jobId} className="py-3 space-y-2">
                  <div className="flex items-center justify-between text-xs gap-3">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {isDownload ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-[#1f6feb]/20 text-[#58a6ff] border border-[#1f6feb]/40 shrink-0">
                          <ArrowDown size={12} className="animate-bounce" />
                          Downloading
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-[#238636]/20 text-[#3fb950] border border-[#238636]/40 shrink-0">
                          <ArrowUp size={12} className="animate-bounce" />
                          Uploading
                        </span>
                      )}

                      <span className="font-mono text-xs text-white truncate font-medium" title={t.relPath}>
                        {t.fileName}
                      </span>
                      {t.relPath !== t.fileName && (
                        <span className="text-[#7d8590] text-xs font-mono truncate hidden md:inline">
                          ({t.relPath})
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 font-mono text-xs text-[#7d8590] shrink-0">
                      {speed && <span className="text-[#58a6ff]">{speed}</span>}
                      {speed && eta && <span>•</span>}
                      {eta && <span>{eta}</span>}
                      {t.bytesTotal > 0 ? (
                        <span className="text-white font-bold ml-1">{t.pct}%</span>
                      ) : (
                        <span className="text-[#58a6ff] font-medium ml-1">Transferring</span>
                      )}
                    </div>
                  </div>

                  <Progress
                    value={t.bytesTotal > 0 ? t.pct : 100}
                    className={cn("h-2 bg-[#161b22]", t.bytesTotal === 0 && "animate-pulse")}
                  />

                  <div className="flex items-center justify-between text-xs font-mono text-[#7d8590]">
                    <span>
                      {t.bytesTotal > 0
                        ? `${formatBytes(t.bytesDone)} of ${formatBytes(t.bytesTotal)}`
                        : "Connecting & transferring…"}
                    </span>
                    <span className="text-[#58a6ff] flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] animate-pulse" />
                      Live Google Drive transfer
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Activity History Ledger ── */}
      <div className="rounded-xl border border-[#30363d] bg-[#0d1117] overflow-hidden shadow-sm">
        <div className="px-5 py-3 bg-[#161b22] border-b border-[#30363d] flex items-center justify-between">
          <span className="text-xs font-semibold text-[#e6edf3] flex items-center gap-2">
            <RefreshCw size={13} className="text-[#58a6ff]" />
            Recent File Activity for this Folder
          </span>
          <span className="text-[11px] font-mono text-[#7d8590]">
            {allPairActivities.length} recorded event{allPairActivities.length === 1 ? "" : "s"}
          </span>
        </div>

        {allPairActivities.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#7d8590]">
            No file transfer events recorded yet for this folder pair.
          </div>
        ) : (
          <div className="divide-y divide-[#30363d]/50 font-mono text-xs">
            {allPairActivities.map((act) => {
              const fileName = act.rel_path.split(/[/\\]/).pop() || act.rel_path;
              const isUpload = act.kind === "upload";
              const isDownload = act.kind === "download";
              const isDelete = act.kind === "delete";

              return (
                <div key={act.id || act.ts_ms} className="px-5 py-2.5 flex items-center justify-between gap-4 hover:bg-[#161b22]/50 transition-colors">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    {isUpload ? (
                      <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[#238636]/20 text-[#3fb950] border border-[#238636]/40 shrink-0 flex items-center gap-1">
                        <ArrowUp size={11} /> Upload
                      </span>
                    ) : isDownload ? (
                      <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[#1f6feb]/20 text-[#58a6ff] border border-[#1f6feb]/40 shrink-0 flex items-center gap-1">
                        <ArrowDown size={11} /> Download
                      </span>
                    ) : isDelete ? (
                      <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[#da3633]/20 text-[#f85149] border border-[#da3633]/40 shrink-0 flex items-center gap-1">
                        <Trash2 size={11} /> Delete
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[#21262d] text-[#c9d1d9] border border-[#30363d] shrink-0">
                        Sync
                      </span>
                    )}

                    <span className="truncate text-white font-medium" title={act.rel_path}>
                      {fileName}
                    </span>
                    {act.rel_path !== fileName && (
                      <span className="text-[#7d8590] text-[11px] truncate hidden md:inline" title={act.rel_path}>
                        ({act.rel_path})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 text-[#7d8590] shrink-0">
                    <span>{formatRelTime(act.ts_ms)}</span>
                    {(act as any).isRealTime ? (
                      <>
                        {(act as any).bytes_total && (act as any).bytes_total > 0 ? (
                          <>
                            <span className="text-[#58a6ff] font-mono text-[10px]">
                              {Math.round(((act as any).bytes_done / (act as any).bytes_total) * 100)}%
                            </span>
                            <Progress
                              value={
                                (act as any).bytes_total > 0
                                  ? Math.round(((act as any).bytes_done / (act as any).bytes_total) * 100)
                                  : 0
                              }
                              className="h-1 bg-[#161b22] w-24 shrink-0"
                            />
                          </>
                        ) : (
                          <span className="text-[#58a6ff] font-mono text-[10px]">
                            Transferring…
                          </span>
                        )}
                      </>
                    ) : act.result === "ok" ? (
                      <span className="text-emerald-400 font-semibold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-[11px]">
                        Success
                      </span>
                    ) : (
                      <span className="text-red-400 font-semibold px-2 py-0.5 rounded bg-red-500/10 border border-red-500/20 text-[11px]" title={act.detail || "Error"}>
                        Failed
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
