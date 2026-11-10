/**
 * P10 – Root application shell.
 * Sets up layout, event subscriptions, and mounts screens.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Toaster } from "sonner";
import { WifiOff, Info, CheckCircle2, AlertCircle, AlertTriangle, Loader2 } from "lucide-react";
import { useStore, type ProgressEvent } from "@/store";
import { getConfig, authStatus, govState, queueStatus, getPairStatuses } from "@/lib/tauri";
import type { GovStatePayload, PairSyncStatus } from "@/lib/tauri";
import { Sidebar, type Screen } from "@/components/Sidebar";
import { ConflictDialog } from "@/components/ConflictDialog";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { HomeScreen }     from "@/screens/Home";
import { ActivityScreen } from "@/screens/Activity";
import { SettingsScreen } from "@/screens/Settings";
import { PairDetailScreen } from "@/screens/PairDetail";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" && typeof navigator.onLine === "boolean" ? navigator.onLine : true
  );
  const selectedPairId = useStore((s) => s.selectedPairId);
  const setSelectedPairId = useStore((s) => s.setSelectedPairId);

  const setConfig = useStore((s) => s.setConfig);
  const config = useStore((s) => s.config);
  const setAuthed = useStore((s) => s.setAuthed);
  const setUserProfile = useStore((s) => s.setUserProfile);
  const setProgress = useStore((s) => s.setProgress);
  const setGov = useStore((s) => s.setGov);
  const setQueueStatus = useStore((s) => s.setQueueStatus);
  const setPairStatuses = useStore((s) => s.setPairStatuses);
  const conflicts = useStore((s) => s.conflicts) ?? [];
  const addConflict = useStore((s) => s.addConflict);

  // Monitor online / offline connectivity
  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Track window visibility so we stop processing events when hidden.
  const visibleRef = useRef(document.visibilityState === "visible");

  // Only keep pair statuses for pairs still enabled in config.
  // Prevents disabled pairs from resurrecting via backend polling.
  const filterEnabledPairStatuses = (ps: Record<string, PairSyncStatus>) => {
    const enabledIds = new Set((config?.pairs ?? []).filter((p) => p.enabled).map((p) => p.id));
    return Object.fromEntries(Object.entries(ps).filter(([id]) => enabledIds.has(id)));
  };

  useEffect(() => {
    function onVisChange() {
      visibleRef.current = document.visibilityState === "visible";
      // Refresh status on show
      if (visibleRef.current) {
        void queueStatus().then(setQueueStatus).catch(() => undefined);
        void getPairStatuses().then((ps) => setPairStatuses(filterEnabledPairStatuses(ps))).catch(() => undefined);
      }
    }
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [setQueueStatus, setPairStatuses]);

  // Boot: load config + auth status + gov state + pair sync statuses
  useEffect(() => {
    void (async () => {
      try {
        const [cfg, a, g, qs, ps] = await Promise.all([
          getConfig(),
          authStatus(),
          govState(),
          queueStatus(),
          getPairStatuses(),
        ]);
        setConfig(cfg);
        setAuthed(a.logged_in);
        setUserProfile(a.user ?? null);
        setGov(g);
        setQueueStatus(qs);
        setPairStatuses(filterEnabledPairStatuses(ps));
      } catch {
        // Will surface as missing data in UI
      }
    })();
  }, [setConfig, setAuthed, setGov, setQueueStatus, setPairStatuses]);

  // Global desktop keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Escape: return from detail screen
      if (e.key === "Escape") {
        if (selectedPairId) {
          e.preventDefault();
          setSelectedPairId(null);
        }
        return;
      }

      // Ctrl+, or Cmd+,: Open Settings
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSelectedPairId(null);
        setScreen("settings");
        return;
      }

      // Ctrl+1 / 2 / 3 navigation shortcuts
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (e.key === "1") {
          e.preventDefault();
          setSelectedPairId(null);
          setScreen("home");
        } else if (e.key === "2") {
          e.preventDefault();
          setSelectedPairId(null);
          setScreen("activity");
        } else if (e.key === "3") {
          e.preventDefault();
          setSelectedPairId(null);
          setScreen("settings");
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPairId, setSelectedPairId]);

  // Fallback idle polling for queue status and per-pair sync statuses (2s when visible)
  useEffect(() => {
    const id = setInterval(() => {
      if (!visibleRef.current) return;
      void queueStatus().then(setQueueStatus).catch(() => undefined);
      void getPairStatuses().then((ps) => setPairStatuses(filterEnabledPairStatuses(ps))).catch(() => undefined);
    }, 2000);
    return () => clearInterval(id);
  }, [setQueueStatus, setPairStatuses, config]);

  // Subscribe to Tauri events
  useEffect(() => {
    const subs: Array<Promise<() => void>> = [
      // Transfer progress
      listen<ProgressEvent>("transfer://progress", (ev) => {
        if (!visibleRef.current) return; // drop events when window hidden
        // Drop progress events for disabled pairs
        if (config?.pairs?.some((p) => p.id === ev.payload.pair_id && p.enabled) === false) return;
        setProgress(ev.payload);
      }),

      // Governor state
      listen<GovStatePayload>("governor://state", (ev) => {
        setGov(ev.payload);
      }),

      // Instant push event when queue jobs change status
      listen("queue://updated", () => {
        if (!visibleRef.current) return;
        void queueStatus().then(setQueueStatus).catch(() => undefined);
        void getPairStatuses().then((ps) => setPairStatuses(filterEnabledPairStatuses(ps))).catch(() => undefined);
      }),

      // Auth changed
      listen<boolean>("auth://changed", (ev) => {
        setAuthed(ev.payload);
        if (ev.payload) {
          void authStatus().then((s) => setUserProfile(s.user ?? null)).catch(() => undefined);
        } else {
          setUserProfile(null);
        }
      }),

      // Sync conflict
      listen<{ pair_id: string; rel_path: string }>("sync://conflict", (ev) => {
        addConflict(ev.payload);
      }),
    ];

    return () => {
      subs.forEach((p) => p.then((unsub) => unsub()).catch(() => undefined));
    };
  }, [setProgress, setGov, setAuthed, addConflict, setQueueStatus, setPairStatuses]);

  return (
    <>
      <div className="flex h-screen w-screen bg-[var(--bg)] text-[var(--text)] overflow-hidden font-sans">
        <Sidebar
          active={screen}
          onNavigate={(s) => {
            setSelectedPairId(null);
            setScreen(s);
          }}
        />

        <main className="flex-1 h-screen overflow-y-auto bg-[var(--bg)] relative flex flex-col">
          {!isOnline && (
            <div className="sticky top-0 z-40 shrink-0 bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 flex items-center justify-between text-xs text-amber-300 backdrop-blur-md">
              <div className="flex items-center gap-2.5">
                <WifiOff size={15} className="text-amber-400 shrink-0 animate-pulse" />
                <span>
                  <strong className="font-semibold text-amber-200">Network connection offline.</strong> Cloud synchronization is paused and will automatically resume once connectivity returns.
                </span>
              </div>
              <span className="text-[10px] text-amber-400 font-mono font-semibold tracking-wider uppercase px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 shrink-0">
                Offline
              </span>
            </div>
          )}

          <div className="flex-1">
            <ErrorBoundary
              fallbackTitle="View Error"
              onReset={() => setSelectedPairId(null)}
            >
              {selectedPairId ? (
                <PairDetailScreen
                  pairId={selectedPairId}
                  onBack={() => setSelectedPairId(null)}
                />
              ) : (
                <>
                  {screen === "home"     && (
                    <HomeScreen
                      onSelectPair={(id) => setSelectedPairId(id)}
                      onNavigate={(s) => setScreen(s)}
                    />
                  )}
                  {screen === "activity" && <ActivityScreen />}
                  {screen === "settings" && <SettingsScreen />}
                </>
              )}
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {/* Conflict dialogs — one per pending conflict */}
      {conflicts.map((c) => (
        <ConflictDialog key={`${c.pair_id}:${c.rel_path}`} conflict={c} />
      ))}

      {/* JioTV Max Autonomous Update Floating Banner */}
      <UpdateBanner currentScreen={screen} />

      {/* Toast notifications */}
      <Toaster
        theme="dark"
        position="bottom-center"
        offset={44}
        icons={{
          info: <Info size={16} className="text-sky-400 shrink-0" />,
          success: <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />,
          warning: <AlertTriangle size={16} className="text-amber-400 shrink-0" />,
          error: <AlertCircle size={16} className="text-red-400 shrink-0" />,
          loading: <Loader2 size={16} className="text-blue-400 shrink-0 animate-spin" />,
        }}
        toastOptions={{
          duration: 3500,
        }}
      />
    </>
  );
}
