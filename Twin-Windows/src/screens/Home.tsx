/**
 * Pro Dashboard Home Screen — Overview metrics, live batch progress,
 * and elegant synced folder pair cards.
 */
import { useState } from "react";
import {
  Plus,
  Trash2,
  Play,
  Pause,
  RefreshCw,
  FolderSync,
  Folder,
  Cloud,
  ArrowLeftRight,
  CloudUpload,
  FlipHorizontal2,
  Layers,
  Copy,
  Check,
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
import { cn } from "@/lib/utils";

// ── Metric Stat Card ──────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  subtext,
  iconColor,
  glowColor,
}: {
  icon: typeof FolderSync;
  label: string;
  value: string;
  subtext: string;
  iconColor: string;
  glowColor: string;
}) {
  return (
    <div className="p-3.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] shadow-sm hover:border-[var(--border-subtle)] transition-all flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {label}
        </span>
        <div
          className={cn(
            "w-7 h-7 rounded-lg flex items-center justify-center border",
            iconColor
          )}
          style={{ boxShadow: glowColor }}
        >
          <Icon size={14} />
        </div>
      </div>
      <div className="mt-2">
        <div className="text-xl font-bold tracking-tight text-[var(--text)]">{value}</div>
        <p className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate">{subtext}</p>
      </div>
    </div>
  );
}

// ── Batch sync progress bar ────────────────────────────────────────────────────

function BatchBar() {
  const progress = useStore((s) => s.progress) ?? {};
  const queueStatus = useStore((s) => s.queueStatus) ?? { queued: 0, running: 0, failed: 0 };
  const events = Object.values(progress) as ProgressEvent[];

  if (events.length === 0 && queueStatus.running === 0) return null;

  const totalDone = events.reduce((a, e) => a + e.bytes_done, 0);
  const totalBytes = events.reduce((a, e) => a + e.bytes_total, 0);
  const pct = totalBytes > 0 ? (totalDone / totalBytes) * 100 : 0;
  const startMs = events.length > 0 ? Math.min(...events.map((e) => e.start_ms)) : Date.now();

  return (
    <div className="mb-5 p-4 rounded-xl bg-gradient-to-r from-blue-950/20 via-[var(--surface)] to-indigo-950/20 border border-blue-500/25 shadow-sm">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          <span className="text-[13px] font-semibold text-[var(--text)]">
            Synchronizing batch ({queueStatus.running} active, {queueStatus.queued} queued)
          </span>
        </div>
        <span className="text-xs font-mono font-medium text-blue-400">
          {pct.toFixed(0)}%
        </span>
      </div>

      <Progress value={pct} aria-label="Batch sync progress" />

      <div className="flex items-center justify-between mt-2.5 text-[11px] font-mono text-[var(--text-muted)]">
        <span>{progressLabel(totalDone, totalBytes, startMs)}</span>
        <span>{events.length} active transfer{events.length === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}

// ── Pair Card ─────────────────────────────────────────────────────────────────

const MODE_CONFIG = {
  two_way: {
    label: "Two-way Sync",
    Icon: ArrowLeftRight,
    badgeClass: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  upload: {
    label: "Backup (Upload)",
    Icon: CloudUpload,
    badgeClass: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  },
  mirror: {
    label: "Mirror (Download)",
    Icon: FlipHorizontal2,
    badgeClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  },
};

function PairCard({
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

  // Extract folder name from path
  const folderName = local.replace(/[/\\]$/, "").split(/[/\\]/).pop() || local;

  const modeInfo = MODE_CONFIG[mode as keyof typeof MODE_CONFIG] ?? MODE_CONFIG.two_way;
  const ModeIcon = modeInfo.Icon;

  // Find active progress events for this pair
  const pairEvents = Object.values(progress).filter(
    (e): e is ProgressEvent => (e as ProgressEvent)?.pair_id === id
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
      toast.success(`Sync cycle completed for ${folderName}`);
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
        : (Array.isArray((config as any).pair) ? (config as any).pair : []);
      const nextPairs = currentPairs.map((p: PairEntry) =>
        p.id === id ? { ...p, enabled: enable } : p
      );
      const nextCfg = { ...config, pairs: nextPairs, pair: nextPairs };
      await updateConfig(nextCfg);
      const reloaded = await getConfig();
      setConfig(reloaded);
      toast.info(enable ? `Enabled sync for ${folderName}` : `Paused sync for ${folderName}`);
    } catch (e) {
      toast.error(`Failed to update pair: ${String(e)}`);
    }
  }

  async function handleRemove() {
    try {
      await removePair(id);
      const cfg = await getConfig();
      setConfig(cfg);
      toast.success(`Removed ${folderName}`);
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
        "rounded-xl border bg-[var(--surface)] p-4 transition-all duration-150 shadow-sm",
        enabled
          ? "border-[var(--border)] hover:border-blue-500/30"
          : "border-[var(--border-subtle)] opacity-70 bg-[var(--surface)]/50"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left: Folder badge & Path info */}
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={cn(
              "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border mt-0.5",
              enabled
                ? "bg-blue-600/10 border-blue-500/20 text-blue-400"
                : "bg-zinc-800 border-zinc-700 text-zinc-500"
            )}
          >
            <Folder size={17} strokeWidth={2} />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[13.5px] text-[var(--text)] tracking-tight">
                {folderName}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border",
                  modeInfo.badgeClass
                )}
              >
                <ModeIcon size={11} strokeWidth={2} />
                {modeInfo.label}
              </span>
              {!enabled && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  Disabled
                </span>
              )}
            </div>

            {/* Local path with copy button */}
            <div className="flex items-center gap-1.5 mt-1 text-[11.5px] text-[var(--text-muted)] font-mono">
              <span className="truncate max-w-[340px]" title={local}>
                {local}
              </span>
              <button
                onClick={handleCopyPath}
                className="hover:text-[var(--text)] p-0.5 rounded transition-colors"
                title="Copy folder path"
              >
                {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              </button>
            </div>

            {/* Google Drive target info */}
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--text-subtle)]">
              <Cloud size={12} className="text-blue-400/80 shrink-0" />
              <span className="font-mono truncate max-w-[280px]" title={drive_folder_id}>
                Drive ID: {drive_folder_id}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Actions & Switch */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="iconSm"
            onClick={handleSync}
            disabled={!enabled || isCurrentlySyncing}
            title="Run sync cycle now"
            className="hover:text-blue-400"
          >
            <RefreshCw
              size={14}
              strokeWidth={1.8}
              className={cn(isCurrentlySyncing && "animate-spin text-blue-400")}
            />
          </Button>

          <Button
            variant="ghost"
            size="iconSm"
            onClick={handleRemove}
            title="Remove folder pair"
            className="hover:text-red-400"
          >
            <Trash2 size={14} strokeWidth={1.8} />
          </Button>

          <div className="w-[1px] h-4 bg-[var(--border)] mx-1" />

          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            aria-label={`Toggle sync for ${folderName}`}
          />
        </div>
      </div>

      {/* Progress bar if actively transferring */}
      {pairEvents.length > 0 && (
        <div className="mt-3.5 pt-3 border-t border-[var(--border)]">
          <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)] mb-1.5">
            <span>Syncing active files...</span>
            <span className="text-blue-400 font-semibold">{pct.toFixed(0)}%</span>
          </div>
          <Progress value={pct} aria-label={`Progress for ${folderName}`} />
          <div className="text-[11px] font-mono text-[var(--text-subtle)] mt-1.5">
            {progressLabel(totalDone, totalBytes, startMs)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pro Home Screen ────────────────────────────────────────────────────────────

export function HomeScreen() {
  const gov = useStore((s) => s.gov) ?? { state: "Running", reason: null, concurrency: 2 };
  const pairs = useStore((s) => s.pairs) ?? [];
  const queueStatus = useStore((s) => s.queueStatus) ?? { queued: 0, running: 0, failed: 0 };
  const authed = useStore((s) => s.authed);
  const setConfig = useStore((s) => s.setConfig);

  const [showAdd, setShowAdd] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  const isPaused = gov.state === "Paused";

  async function handlePauseResume() {
    try {
      if (isPaused) {
        await govResume();
        toast.success("Engine resumed");
      } else {
        await govPause();
        toast.info("Engine paused");
      }
    } catch (e) {
      toast.error(`Failed to toggle governor: ${String(e)}`);
    }
  }

  async function handleSyncAll() {
    setSyncingAll(true);
    try {
      await syncNow();
      toast.success("Sync cycle queued for all folders");
    } catch (e) {
      toast.error(`Sync failed: ${String(e)}`);
    } finally {
      setTimeout(() => setSyncingAll(false), 1000);
    }
  }

  async function handleAdded() {
    const cfg = await getConfig();
    setConfig(cfg);
  }

  return (
    <div className="p-6 max-w-4xl w-full mx-auto space-y-6">
      {/* Top Header & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-[var(--text)] flex items-center gap-2">
            Overview
            <span className="text-xs font-normal text-[var(--text-muted)]">
              • Google Drive Continuous Sync
            </span>
          </h1>
          <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
            Monitor real-time sync status, transfer queues, and folder pairs.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={handlePauseResume}
            className="flex items-center gap-1.5"
          >
            {isPaused ? (
              <>
                <Play size={13} className="text-emerald-400 fill-emerald-400" />
                Resume
              </>
            ) : (
              <>
                <Pause size={13} className="text-amber-400" />
                Pause
              </>
            )}
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleSyncAll}
            disabled={syncingAll}
            className="flex items-center gap-1.5"
          >
            <RefreshCw
              size={13}
              className={cn("text-blue-400", syncingAll && "animate-spin")}
            />
            Sync All
          </Button>

          <Button
            onClick={() => setShowAdd(true)}
            size="sm"
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500"
          >
            <Plus size={14} strokeWidth={2.5} />
            Add Folder
          </Button>
        </div>
      </div>

      {/* Metrics Row (4 Cards) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={FolderSync}
          label="Engine State"
          value={gov.state}
          subtext={
            gov.reason
              ? gov.reason
              : `${gov.concurrency} concurrent threads`
          }
          iconColor={
            gov.state === "Running"
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
              : "bg-amber-500/10 text-amber-400 border-amber-500/20"
          }
          glowColor={
            gov.state === "Running"
              ? "0 0 12px rgba(16,185,129,0.15)"
              : "0 0 12px rgba(245,158,11,0.15)"
          }
        />

        <StatCard
          icon={Folder}
          label="Folder Pairs"
          value={String(pairs.length)}
          subtext={`${pairs.filter((p) => p.enabled).length} active`}
          iconColor="bg-blue-500/10 text-blue-400 border-blue-500/20"
          glowColor="0 0 12px rgba(59,130,246,0.15)"
        />

        <StatCard
          icon={Layers}
          label="Queue Status"
          value={
            queueStatus.running > 0
              ? `${queueStatus.running} active`
              : `${queueStatus.queued} queued`
          }
          subtext={
            queueStatus.failed > 0
              ? `${queueStatus.failed} failed jobs`
              : "All jobs completed"
          }
          iconColor={
            queueStatus.failed > 0
              ? "bg-red-500/10 text-red-400 border-red-500/20"
              : "bg-purple-500/10 text-purple-400 border-purple-500/20"
          }
          glowColor="0 0 12px rgba(168,85,247,0.15)"
        />

        <StatCard
          icon={Cloud}
          label="Cloud Status"
          value={authed ? "Connected" : "Signed Out"}
          subtext={authed ? "Google Drive ready" : "Sign in to sync"}
          iconColor={
            authed
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
              : "bg-zinc-800 text-zinc-400 border-zinc-700"
          }
          glowColor="0 0 12px rgba(16,185,129,0.15)"
        />
      </div>

      {/* Batch sync progress bar (appears when jobs are active) */}
      <BatchBar />

      {/* Folder Pairs Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold text-[var(--text)]">
              Folder Pairs
            </h2>
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--text-muted)] border border-[var(--border)]">
              {pairs.length}
            </span>
          </div>

          {pairs.length > 0 && (
            <button
              onClick={() => setShowAdd(true)}
              className="text-[12px] font-medium text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
            >
              <Plus size={13} /> Add another
            </button>
          )}
        </div>

        {/* Pairs list or Pro Empty State */}
        {pairs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/60 p-8 sm:p-12 text-center flex flex-col items-center justify-center space-y-4 shadow-sm">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600/20 to-indigo-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <FolderSync size={26} strokeWidth={1.8} />
            </div>

            <div className="max-w-md space-y-1.5">
              <h3 className="text-base font-semibold text-[var(--text)]">
                No Synced Folders Configured
              </h3>
              <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
                Connect your local folders to Google Drive. Twin will continuously monitor for changes,
                queue transfers, handle conflicts, and keep your files in sync.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-[var(--text-muted)] pt-1">
              <span className="px-2.5 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)]">
                ⚡ Continuous live sync
              </span>
              <span className="px-2.5 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)]">
                🛡️ Delta & conflict safe
              </span>
              <span className="px-2.5 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)]">
                🕒 Drive versioning
              </span>
            </div>

            <Button
              onClick={() => setShowAdd(true)}
              className="mt-2 bg-blue-600 hover:bg-blue-500 px-5 py-2 h-auto text-[13px] font-medium flex items-center gap-2"
            >
              <Plus size={15} strokeWidth={2.5} />
              Add Your First Folder Pair
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {pairs.map((p) => (
              <PairCard key={p.id} {...p} />
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
