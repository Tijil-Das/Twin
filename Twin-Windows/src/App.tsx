/**
 * P10 – Root application shell.
 * Sets up layout, event subscriptions, and mounts screens.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Toaster } from "sonner";
import { useStore, type ProgressEvent } from "@/store";
import { getConfig, authStatus, govState, queueStatus } from "@/lib/tauri";
import type { GovStatePayload } from "@/lib/tauri";
import { Sidebar, type Screen } from "@/components/Sidebar";
import { ConflictDialog } from "@/components/ConflictDialog";
import { HomeScreen }     from "@/screens/Home";
import { ActivityScreen } from "@/screens/Activity";
import { RestoreScreen }  from "@/screens/Restore";
import { SettingsScreen } from "@/screens/Settings";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");

  const { setConfig, setAuthed, setUserProfile, setProgress, setGov, setQueueStatus, conflicts } = useStore((s) => ({
    setConfig:      s.setConfig,
    setAuthed:      s.setAuthed,
    setUserProfile: s.setUserProfile,
    setProgress:    s.setProgress,
    setGov:         s.setGov,
    setQueueStatus: s.setQueueStatus,
    conflicts:      s.conflicts,
  }));
  const addConflict = useStore((s) => s.addConflict);

  // Track window visibility so we stop processing events when hidden.
  const visibleRef = useRef(document.visibilityState === "visible");
  useEffect(() => {
    function onVisChange() {
      visibleRef.current = document.visibilityState === "visible";
      // Refresh queue status on show
      if (visibleRef.current) {
        void queueStatus().then(setQueueStatus).catch(() => undefined);
      }
    }
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [setQueueStatus]);

  // Boot: load config + auth status + gov state
  useEffect(() => {
    void (async () => {
      try {
        const [cfg, a, g, qs] = await Promise.all([
          getConfig(),
          authStatus(),
          govState(),
          queueStatus(),
        ]);
        setConfig(cfg);
        setAuthed(a.logged_in);
        setUserProfile(a.user ?? null);
        setGov(g);
        setQueueStatus(qs);
      } catch {
        // Will surface as missing data in UI
      }
    })();
  }, [setConfig, setAuthed, setGov, setQueueStatus]);

  // Poll queue status every 5s
  useEffect(() => {
    const id = setInterval(() => {
      void queueStatus().then(setQueueStatus).catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [setQueueStatus]);

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
      <div
        style={{
          display: "flex",
          height: "100vh",
          background: "var(--bg)",
          color: "var(--text)",
          overflow: "hidden",
        }}
      >
        <Sidebar active={screen} onNavigate={setScreen} />

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            justifyContent: "flex-start",
          }}
        >
          {screen === "home"     && <HomeScreen />}
          {screen === "activity" && <ActivityScreen />}
          {screen === "restore"  && <RestoreScreen />}
          {screen === "settings" && <SettingsScreen />}
        </main>
      </div>

      {/* Conflict dialogs — one per pending conflict */}
      {conflicts.map((c) => (
        <ConflictDialog key={`${c.pair_id}:${c.rel_path}`} conflict={c} />
      ))}

      {/* Error toasts only */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 13,
          },
          duration: 4000,
        }}
      />
    </>
  );
}
