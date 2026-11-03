/**
 * Home screen — status pill, batch bar, pair cards with per-pair progress.
 */
import { useState } from "react";
import { PlusIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useStore, type ProgressEvent } from "@/store";
import { govPause, govResume, syncNow, removePair, getConfig, runSyncCycle } from "@/lib/tauri";
import { progressLabel } from "@/lib/format";
import { AddPairDialog } from "@/components/AddPairDialog";
import { toast } from "sonner";

// ── Status pill ────────────────────────────────────────────────────────────────

function StatusPill() {
  const { state, reason } = useStore((s) => s.gov);

  const colors: Record<string, string> = {
    Running:   "var(--success)",
    Throttled: "var(--warning)",
    Paused:    "var(--text-muted)",
  };
  const labels: Record<string, string> = {
    Running:   "Idle",
    Throttled: "Throttled",
    Paused:    reason ? `Paused: ${reason}` : "Paused",
  };
  const color = colors[state] ?? "var(--text-muted)";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
        role="status"
        aria-label={labels[state] ?? state}
      />
      <span style={{ fontSize: 14, fontWeight: 500 }}>{labels[state] ?? state}</span>
    </div>
  );
}

// ── Batch progress bar ─────────────────────────────────────────────────────────

function BatchBar() {
  const progress = useStore((s) => s.progress) ?? {};
  const queueStatus = useStore((s) => s.queueStatus) ?? { queued: 0, running: 0, failed: 0 };
  const events = Object.values(progress) as ProgressEvent[];

  if (events.length === 0) return null;

  const totalDone  = events.reduce((a, e) => a + e.bytes_done, 0);
  const totalBytes = events.reduce((a, e) => a + e.bytes_total, 0);
  const pct = totalBytes > 0 ? (totalDone / totalBytes) * 100 : 0;
  const startMs = Math.min(...events.map((e) => e.start_ms));

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "12px 16px",
        marginBottom: 16,
      }}
    >
      <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
        Syncing {queueStatus.running} of {queueStatus.queued + queueStatus.running} files
      </p>
      <Progress value={pct} aria-label="Batch sync progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} />
      <p style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: '"Cascadia Mono", Consolas, monospace', marginTop: 4 }}>
        {progressLabel(totalDone, totalBytes, startMs)}
      </p>
    </div>
  );
}

// ── Pair card ─────────────────────────────────────────────────────────────────

const MODE_LABELS: Record<string, string> = {
  two_way: "Two-way",
  upload:  "Upload",
  mirror:  "Mirror",
};

function PairCard({ id, local, drive_folder_id, mode, enabled }: {
  id: string; local: string; drive_folder_id: string; mode: string; enabled: boolean;
}) {
  const progress = useStore((s) => s.progress) ?? {};
  const setConfig = useStore((s) => s.setConfig);
  const [syncing, setSyncing] = useState(false);

  // Find progress events for this pair
  const pairEvents = Object.values(progress).filter(
    (e): e is ProgressEvent => (e as ProgressEvent)?.pair_id === id
  );
  const totalDone  = pairEvents.reduce((a, e) => a + e.bytes_done, 0);
  const totalBytes = pairEvents.reduce((a, e) => a + e.bytes_total, 0);
  const pct = totalBytes > 0 ? (totalDone / totalBytes) * 100 : 0;
  const startMs = pairEvents.length > 0 ? Math.min(...pairEvents.map((e) => e.start_ms)) : 0;

  async function handleSync() {
    setSyncing(true);
    try {
      await runSyncCycle(id);
    } catch (e) {
      toast.error(`Sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleRemove() {
    try {
      await removePair(id);
      const cfg = await getConfig();
      setConfig(cfg);
    } catch (e) {
      toast.error(`Failed to remove pair: ${String(e)}`);
    }
  }

  return (
    <Card>
      <CardHeader style={{ padding: "12px 16px 0 16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <CardTitle style={{ fontSize: 14 }}>
            <span
              title={local}
              style={{
                fontFamily: '"Cascadia Mono", Consolas, monospace',
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 300,
                display: "inline-block",
                verticalAlign: "middle",
              }}
            >
              {local}
            </span>
          </CardTitle>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {MODE_LABELS[mode] ?? mode}
            </span>
            {!enabled && (
              <span style={{ fontSize: 11, color: "var(--warning)" }}>Disabled</span>
            )}
            <Button variant="ghost" size="icon" onClick={handleSync} disabled={syncing} aria-label="Sync now">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </Button>
            <Button variant="ghost" size="icon" onClick={handleRemove} aria-label="Remove pair">
              <Trash2 size={14} strokeWidth={1.5} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent style={{ padding: "8px 16px 12px" }}>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: pairEvents.length > 0 ? 8 : 0 }}>
          Drive: <span style={{ fontFamily: '"Cascadia Mono", Consolas, monospace' }}>{drive_folder_id}</span>
        </p>
        {pairEvents.length > 0 && (
          <>
            <Progress
              value={pct}
              aria-label={`Progress for ${local}`}
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
            <p style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: '"Cascadia Mono", Consolas, monospace', marginTop: 4 }}>
              {progressLabel(totalDone, totalBytes, startMs)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Home screen ────────────────────────────────────────────────────────────────

export function HomeScreen() {
  const gov = useStore((s) => s.gov) ?? { state: "Running", reason: null, concurrency: 2 };
  const pairs = useStore((s) => s.pairs) ?? [];
  const queueStatus = useStore((s) => s.queueStatus) ?? { queued: 0, running: 0, failed: 0 };
  const setConfig = useStore((s) => s.setConfig);

  const [showAdd, setShowAdd] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const isPaused = gov.state === "Paused";

  async function handlePauseResume() {
    try {
      if (isPaused) await govResume();
      else await govPause();
    } catch (e) {
      toast.error(`Failed: ${String(e)}`);
    }
  }

  async function handleSyncNow() {
    setSyncing(true);
    try {
      await syncNow();
    } catch (e) {
      toast.error(`Sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleAdded() {
    const cfg = await getConfig();
    setConfig(cfg);
  }

  return (
    <div style={{ padding: 24, maxWidth: 880, width: "100%" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <StatusPill />
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" onClick={handlePauseResume}>
            {isPaused ? "Resume" : "Pause"}
          </Button>
          <Button variant="secondary" onClick={handleSyncNow} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      </div>

      {/* Failed jobs warning */}
      {queueStatus.failed > 0 && (
        <p style={{ fontSize: 13, color: "var(--danger)", marginBottom: 12 }}>
          {queueStatus.failed} job{queueStatus.failed > 1 ? "s" : ""} failed — check Activity tab.
        </p>
      )}

      {/* Batch bar */}
      <BatchBar />

      {/* Pair cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {pairs.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            No folder pairs configured.{" "}
            <button
              onClick={() => setShowAdd(true)}
              style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: 0 }}
            >
              Add one
            </button>
          </p>
        ) : (
          pairs.map((p) => <PairCard key={p.id} {...p} />)
        )}
      </div>

      {/* Add pair button */}
      {pairs.length > 0 && (
        <Button
          variant="secondary"
          onClick={() => setShowAdd(true)}
          style={{ marginTop: 16 }}
        >
          <PlusIcon size={14} strokeWidth={1.5} /> Add folder
        </Button>
      )}

      <AddPairDialog open={showAdd} onClose={() => setShowAdd(false)} onAdded={handleAdded} />
    </div>
  );
}
