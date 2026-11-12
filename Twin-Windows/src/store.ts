/**
 * P10 – Zustand store.
 * Holds all shared UI state: pairs, activity, progress, gov, auth, conflicts.
 */
import { create } from "zustand";
import type { Activity, Config, GovStatePayload, QueueStatus, PairSyncStatus, PairEntry, GoogleUserProfile } from "@/lib/tauri";

// ── Progress event payload ─────────────────────────────────────────────────────

export interface ProgressEvent {
  job_id: number;
  pair_id: string;
  rel_path: string;
  bytes_done: number;
  bytes_total: number;
  speed_bps?: number;
  eta_secs?: number | null;
  start_ms: number;
  kind?: string;
}

// ── Conflict record ────────────────────────────────────────────────────────────

export interface ConflictRecord {
  pair_id: string;
  rel_path: string;
}

// ── Store shape ────────────────────────────────────────────────────────────────

interface AppState {
  // Config / pairs
  config: Config | null;
  setConfig: (cfg: Config) => void;

  // Auth
  authed: boolean;
  setAuthed: (v: boolean) => void;
  userProfile: GoogleUserProfile | null;
  setUserProfile: (u: GoogleUserProfile | null) => void;

  // Activity
  activity: Activity[];
  setActivity: (rows: Activity[]) => void;

  // Progress: keyed by job_id
  progress: Record<number, ProgressEvent>;
  setProgress: (ev: ProgressEvent) => void;
  clearProgress: (jobId: number) => void;
  clearPairProgress: (pairId: string) => void;
  clearPairStatus: (pairId: string) => void;

  // Governor
  gov: GovStatePayload;
  setGov: (g: GovStatePayload) => void;

  // Queue status (queued/running/failed counts)
  queueStatus: QueueStatus;
  setQueueStatus: (q: QueueStatus) => void;

  // Per-pair real-time sync statuses
  pairStatuses: Record<string, PairSyncStatus>;
  setPairStatuses: (statuses: Record<string, PairSyncStatus>) => void;

  // Conflicts waiting for user resolution
  conflicts: ConflictRecord[];
  addConflict: (c: ConflictRecord) => void;
  removeConflict: (pairId: string, relPath: string) => void;

  // Pairs derived shorthand
  pairs: PairEntry[];

  // Active selected pair for full-page details
  selectedPairId: string | null;
  setSelectedPairId: (id: string | null) => void;
}

// ── Default gov ────────────────────────────────────────────────────────────────

const defaultGov: GovStatePayload = { kind: "running", reason: null, concurrency: 2 };

// ── Completed transfer auto-dismiss timers ────────────────────────────────────
const completionTimers = new Map<number, ReturnType<typeof setTimeout>>();

// ── Store ─────────────────────────────────────────────────────────────────────

export const useStore = create<AppState>((set) => ({
  config: null,
  setConfig: (config) => {
    const raw = config as any;
    const pairs = Array.isArray(raw?.pairs)
      ? raw.pairs
      : (Array.isArray(raw?.pair) ? raw.pair : []);
    set({ config: { ...config, pairs, pair: pairs }, pairs });
  },

  authed: false,
  setAuthed: (authed) => set({ authed }),
  userProfile: null,
  setUserProfile: (userProfile) => set({ userProfile }),

  activity: [],
  setActivity: (activity) => set({ activity }),

  progress: {},
  setProgress: (ev) => {
    // Events may arrive out of order after a retry or reconnect. Store only a
    // finite, monotonic value so a stale event cannot make the UI move
    // backwards, overflow, or display NaN/Infinity.
    const total = Number.isFinite(ev.bytes_total) && ev.bytes_total >= 0
      ? Math.floor(ev.bytes_total)
      : 0;
    const reportedDone = Number.isFinite(ev.bytes_done) && ev.bytes_done >= 0
      ? Math.floor(ev.bytes_done)
      : 0;
    const previous = useStore.getState().progress[ev.job_id];
    const bytesDone = Math.min(total, Math.max(previous?.bytes_done ?? 0, reportedDone));
    const normalized: ProgressEvent = {
      ...ev,
      bytes_total: total,
      bytes_done: bytesDone,
      speed_bps: Number.isFinite(ev.speed_bps) && (ev.speed_bps ?? 0) >= 0 ? ev.speed_bps : undefined,
      eta_secs: Number.isFinite(ev.eta_secs) && (ev.eta_secs ?? 0) >= 0 ? ev.eta_secs : null,
    };

    // 100% guard: never store progress events for disabled pairs
    const cfg = useStore.getState().config;
    if (cfg?.pairs?.some((p: PairEntry) => p.id === normalized.pair_id && !p.enabled)) return;

    // Schedule delayed cleanup for finished jobs outside of the pure reducer
    if (normalized.bytes_done >= normalized.bytes_total) {
      if (!completionTimers.has(normalized.job_id)) {
        const timer = setTimeout(() => {
          completionTimers.delete(normalized.job_id);
          useStore.getState().clearProgress(normalized.job_id);
        }, 300);
        completionTimers.set(normalized.job_id, timer);
      }
    } else {
      const existing = completionTimers.get(normalized.job_id);
      if (existing) {
        clearTimeout(existing);
        completionTimers.delete(normalized.job_id);
      }
    }

    set((s) => ({
      progress: {
        ...s.progress,
        [normalized.job_id]: normalized,
      },
    }));
  },
  clearProgress: (jobId) => {
    const existing = completionTimers.get(jobId);
    if (existing) {
      clearTimeout(existing);
      completionTimers.delete(jobId);
    }
    set((s) => {
      const next = { ...s.progress };
      delete next[jobId];
      return { progress: next };
    });
  },

  // Remove all in-flight progress events for a given pair (e.g. when pair is disabled)
  clearPairProgress: (pairId: string) => {
    set((s) => {
      const next = { ...s.progress };
      let changed = false;
      for (const jobId of Object.keys(next) as (string | number)[]) {
        const ev = next[jobId as number];
        if (ev?.pair_id === pairId) {
          const timer = completionTimers.get(jobId as number);
          if (timer) {
            clearTimeout(timer);
            completionTimers.delete(jobId as number);
          }
          delete next[jobId as number];
          changed = true;
        }
      }
      return changed ? { progress: next } : {};
    });
  },

  // Remove a single pair's sync status (e.g. when pair is disabled)
  clearPairStatus: (pairId: string) => {
    set((s) => {
      const next = { ...s.pairStatuses };
      if (next[pairId]) {
        delete next[pairId];
        return { pairStatuses: next };
      }
      return {};
    });
  },

  gov: defaultGov,
  setGov: (gov) => set({ gov }),

  queueStatus: { queued: 0, running: 0, failed: 0 },
  setQueueStatus: (queueStatus) => set({ queueStatus }),

  pairStatuses: {},
  setPairStatuses: (pairStatuses) => {
    // 100% guard: never persist statuses for pairs that are disabled in config.
    // This makes every call site (boot, poller, events, sync buttons) safe by default.
    const state = useStore.getState();
    const cfg = state.config;
    if (!cfg?.pairs) {
      set({ pairStatuses });
      return;
    }
    const enabledIds = new Set(cfg.pairs.filter((p: PairEntry) => p.enabled).map((p: PairEntry) => p.id));
    const filtered = Object.fromEntries(
      Object.entries(pairStatuses).filter(([id]) => enabledIds.has(id))
    );
    set({ pairStatuses: filtered });
  },

  conflicts: [],
  addConflict: (c) =>
    set((s) => {
      const exists = s.conflicts.some(
        (x) => x.pair_id === c.pair_id && x.rel_path === c.rel_path
      );
      return exists ? {} : { conflicts: [...s.conflicts, c] };
    }),
  removeConflict: (pairId, relPath) =>
    set((s) => ({
      conflicts: s.conflicts.filter(
        (x) => !(x.pair_id === pairId && x.rel_path === relPath)
      ),
    })),

  pairs: [],
  selectedPairId: null,
  setSelectedPairId: (selectedPairId) => set({ selectedPairId }),
}));

