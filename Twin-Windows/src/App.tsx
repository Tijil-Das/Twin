/**
 * P10 – Root application shell.
 * Sets up layout, event subscriptions, and mounts screens.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Toaster, toast } from "sonner";
import { useStore, type ProgressEvent } from "@/store";
import { getConfig, authStatus, govState, queueStatus, updateInstall } from "@/lib/tauri";
import type { GovStatePayload } from "@/lib/tauri";
import { Sidebar, type Screen } from "@/components/Sidebar";
import { ConflictDialog } from "@/components/ConflictDialog";
import { HomeScreen }     from "@/screens/Home";
import { ActivityScreen } from "@/screens/Activity";
import { RestoreScreen }  from "@/screens/Restore";
import { SettingsScreen } from "@/screens/Settings";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");

  const setConfig = useStore((s) => s.setConfig);
  const setAuthed = useStore((s) => s.setAuthed);
  const setUserProfile = useStore((s) => s.setUserProfile);
  const setProgress = useStore((s) => s.setProgress);
  const setGov = useStore((s) => s.setGov);
  const setQueueStatus = useStore((s) => s.setQueueStatus);
  const conflicts = useStore((s) => s.conflicts) ?? [];
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

      // Background update ready (JioTV Max pattern)
      listen<{ version: string; notes?: string }>("update://ready", (ev) => {
        toast.success(`Twin v${ev.payload.version} is ready to apply!`, {
          description: "Update was downloaded seamlessly in the background. Restart to apply with zero re-install.",
          action: {
            label: "Restart now",
            onClick: () => {
              void updateInstall();
            },
          },
          duration: 20000,
        });
      }),
    ];

    return () => {
      subs.forEach((p) => p.then((unsub) => unsub()).catch(() => undefined));
    };
  }, [setProgress, setGov, setAuthed, addConflict]);

  return (
    <>
      <div className="flex h-screen w-screen bg-[var(--bg)] text-[var(--text)] overflow-hidden font-sans">
        <Sidebar active={screen} onNavigate={setScreen} />

        <main className="flex-1 h-screen overflow-y-auto bg-[var(--bg)] relative">
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

      {/* Toast notifications */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 12.5,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          },
          duration: 4000,
        }}
      />
    </>
  );
}
