/**
 * P10 – Root application shell.
 * Sets up layout, event subscriptions, and mounts screens.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Toaster } from "sonner";
import { useStore, type ProgressEvent } from "@/store";
import { getConfig, authStatus, govState, queueStatus, getPairStatuses } from "@/lib/tauri";
import type { GovStatePayload } from "@/lib/tauri";
import { Sidebar, type Screen } from "@/components/Sidebar";
import { ConflictDialog } from "@/components/ConflictDialog";
import { UpdateBanner } from "@/components/UpdateBanner";
import { HomeScreen }     from "@/screens/Home";
import { ActivityScreen } from "@/screens/Activity";
import { SettingsScreen } from "@/screens/Settings";
import { PairDetailScreen } from "@/screens/PairDetail";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const selectedPairId = useStore((s) => s.selectedPairId);
  const setSelectedPairId = useStore((s) => s.setSelectedPairId);

  const setConfig = useStore((s) => s.setConfig);
  const setAuthed = useStore((s) => s.setAuthed);
  const setUserProfile = useStore((s) => s.setUserProfile);
  const setProgress = useStore((s) => s.setProgress);
  const setGov = useStore((s) => s.setGov);
  const setQueueStatus = useStore((s) => s.setQueueStatus);
  const setPairStatuses = useStore((s) => s.setPairStatuses);
  const conflicts = useStore((s) => s.conflicts) ?? [];
  const addConflict = useStore((s) => s.addConflict);

  // Track window visibility so we stop processing events when hidden.
  const visibleRef = useRef(document.visibilityState === "visible");
  useEffect(() => {
    function onVisChange() {
      visibleRef.current = document.visibilityState === "visible";
      // Refresh status on show
      if (visibleRef.current) {
        void queueStatus().then(setQueueStatus).catch(() => undefined);
        void getPairStatuses().then(setPairStatuses).catch(() => undefined);
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
        setPairStatuses(ps);
      } catch {
        // Will surface as missing data in UI
      }
    })();
  }, [setConfig, setAuthed, setGov, setQueueStatus, setPairStatuses]);

  // Poll queue status and per-pair sync statuses every 2s
  useEffect(() => {
    const id = setInterval(() => {
      if (!visibleRef.current) return;
      void queueStatus().then(setQueueStatus).catch(() => undefined);
      void getPairStatuses().then(setPairStatuses).catch(() => undefined);
    }, 2000);
    return () => clearInterval(id);
  }, [setQueueStatus, setPairStatuses]);

  // Subscribe to Tauri events
  useEffect(() => {
    const subs: Array<Promise<() => void>> = [
      // Transfer progress
      listen<ProgressEvent>("transfer://progress", (ev) => {
        if (!visibleRef.current) return; // drop events when window hidden
        setProgress(ev.payload);
      }),

      // Governor state
      listen<GovStatePayload>("governor://state", (ev) => {
        setGov(ev.payload);
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
  }, [setProgress, setGov, setAuthed, addConflict]);

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

        <main className="flex-1 h-screen overflow-y-auto bg-[var(--bg)] relative">
          {selectedPairId ? (
            <PairDetailScreen
              pairId={selectedPairId}
              onBack={() => setSelectedPairId(null)}
            />
          ) : (
            <>
              {screen === "home"     && <HomeScreen onSelectPair={(id) => setSelectedPairId(id)} />}
              {screen === "activity" && <ActivityScreen />}
              {screen === "settings" && <SettingsScreen />}
            </>
          )}
        </main>
      </div>

      {/* Conflict dialogs — one per pending conflict */}
      {conflicts.map((c) => (
        <ConflictDialog key={`${c.pair_id}:${c.rel_path}`} conflict={c} />
      ))}

      {/* JioTV Max Autonomous Update Floating Banner */}
      <UpdateBanner />

      {/* Toast notifications */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 12,
            boxShadow: "0 12px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
          },
          duration: 4000,
        }}
      />
    </>
  );
}
