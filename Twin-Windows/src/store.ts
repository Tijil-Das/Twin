/**
 * P10 – Zustand store.
 * Holds all shared UI state: pairs, activity, progress, gov, auth, conflicts.
 */
import { create } from "zustand";
import type { Activity, Config, GovStatePayload, QueueStatus, PairEntry, GoogleUserProfile } from "@/lib/tauri";

// ── Progress event payload ─────────────────────────────────────────────────────

export interface ProgressEvent {
  job_id: number;
  pair_id: string;
  rel_path: string;
  bytes_done: number;
  bytes_total: number;
  start_ms: number;
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

  // Governor
  gov: GovStatePayload;
  setGov: (g: GovStatePayload) => void;

  // Queue status (queued/running/failed counts)
  queueStatus: QueueStatus;
  setQueueStatus: (q: QueueStatus) => void;

  // Conflicts waiting for user resolution
  conflicts: ConflictRecord[];
  addConflict: (c: ConflictRecord) => void;
  removeConflict: (pairId: string, relPath: string) => void;

  // Pairs derived shorthand
  pairs: PairEntry[];
}

// ── Default gov ────────────────────────────────────────────────────────────────

const defaultGov: GovStatePayload = { kind: "running", reason: null, concurrency: 2 };

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
  setProgress: (ev) =>
    set((s) => {
      const next = { ...s.progress };
      if (ev.bytes_done >= ev.bytes_total) {
        setTimeout(() => {
          useStore.getState().clearProgress(ev.job_id);
        }, 500);
      }
      next[ev.job_id] = ev;
      return { progress: next };
    }),
  clearProgress: (jobId) =>
    set((s) => {
      const next = { ...s.progress };
      delete next[jobId];
      return { progress: next };
    }),

  gov: defaultGov,
  setGov: (gov) => set({ gov }),

  queueStatus: { queued: 0, running: 0, failed: 0 },
  setQueueStatus: (queueStatus) => set({ queueStatus }),

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
}));

