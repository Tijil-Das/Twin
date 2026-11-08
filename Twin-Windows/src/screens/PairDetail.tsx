/**
 * Pair Detail Screen
 * Dedicated full-page view for deep inspection, live telemetry,
 * file activity, and controls for an individual synced folder pair.
 */
import { useState } from "react";
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
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useStore, type ProgressEvent } from "@/store";
import {
  runSyncCycle,
  removePair,
  getConfig,
  updateConfig,
  openLocalPath,
  openUrlExternal,
  type PairEntry,
} from "@/lib/tauri";
import { formatBytes, formatSpeed, formatEta, formatRelTime } from "@/lib/format";
import { toast } from "sonner";
import gdLogo from "@/assets/gd-icon.png";
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
      <div className="p-8 max-w-4xl mx-auto space-y-4">
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

  // Active in-flight transfers for this pair
  const pairEvents = Object.values(progress).filter(
    (e): e is ProgressEvent =>
      Boolean(
        e &&
          (e as ProgressEvent).pair_id === pairId &&
          (e as ProgressEvent).bytes_total > 0 &&
          (e as ProgressEvent).bytes_done <= (e as ProgressEvent).bytes_total
      )
  );

  const isCurrentlySyncing = syncing || pairEvents.length > 0;

  // Activity events for this pair
  const pairActivities = allActivity.filter((a) => a.pair_id === pairId);

  const totalFiles = pairStatus?.total ?? 0;
  const syncedFiles = pairStatus?.synced ?? 0;
  const pendingFiles = (pairStatus?.dirty ?? 0) + (pairStatus?.queued ?? 0);
  const failedFiles = pairStatus?.failed ?? 0;
  const conflictFiles = pairStatus?.conflict ?? 0;
  const deletedFiles = pairStatus?.deleted ?? 0;

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

  async function handleSync() {
    setSyncing(true);
    try {
      await runSyncCycle(pairId);
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
        p.id === pairId ? { ...p, enabled: enable } : p
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

  return (
    <div className="p-7 max-w-4xl w-full mx-auto space-y-6">
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
          <span>Synced Folders</span>
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
            {isFullySynced ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">
                <CheckCircle2 size={12} /> Up to date
              </span>
            ) : hasPending ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 whitespace-nowrap">
                <Clock size={12} /> Sync pending ({totalFiles - syncedFiles} remaining)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30 whitespace-nowrap">
                <RefreshCw size={12} className="animate-spin" /> Syncing
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

          <div className="flex items-center gap-1.5 bg-[#161b22] px-2.5 py-1 rounded-md border border-[#30363d]">
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
              <div className="px-3 py-1.5 rounded-lg bg-[#161b22] border border-[#30363d] font-mono text-xs text-[#c9d1d9] truncate select-all max-w-sm" title={pair.local}>
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
              <div className="px-3 py-1.5 rounded-lg bg-[#161b22] border border-[#30363d] font-mono text-xs text-[#c9d1d9] truncate select-all max-w-sm" title={pair.drive_folder_id || "Root"}>
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

      {/* ── In-Flight Real-Time Transfers (Only when transfers active) ── */}
      {pairEvents.length > 0 && (
        <div className="p-5 rounded-xl bg-[#0d1117] border border-[#1f6feb]/40 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#58a6ff] animate-ping" />
              Live In-Flight Transfers ({pairEvents.length})
            </span>
          </div>

          <div className="divide-y divide-[#30363d]/60">
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
                <div key={ev.job_id} className="py-3 space-y-2">
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

                      <span className="font-mono text-xs text-white truncate font-medium" title={ev.rel_path}>
                        {fileName}
                      </span>
                      {ev.rel_path !== fileName && (
                        <span className="text-[#7d8590] text-xs font-mono truncate hidden md:inline">
                          ({ev.rel_path})
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 font-mono text-xs text-[#7d8590] shrink-0">
                      {speed && <span className="text-[#58a6ff]">{speed}</span>}
                      {speed && eta && <span>•</span>}
                      {eta && <span>{eta}</span>}
                      <span className="text-white font-bold ml-1">{evPct}%</span>
                    </div>
                  </div>

                  <Progress value={evPct} className="h-2 bg-[#161b22]" />

                  <div className="flex items-center justify-between text-xs font-mono text-[#7d8590]">
                    <span>
                      {formatBytes(ev.bytes_done)} of {formatBytes(ev.bytes_total)}
                    </span>
                    <span className="text-[#58a6ff] flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] animate-pulse" />
                      Streaming data
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
            {pairActivities.length} recorded event{pairActivities.length === 1 ? "" : "s"}
          </span>
        </div>

        {pairActivities.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#7d8590]">
            No file transfer events recorded yet for this folder pair.
          </div>
        ) : (
          <div className="divide-y divide-[#30363d]/50 font-mono text-xs">
            {pairActivities.map((act) => {
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
                    {act.result === "ok" ? (
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
