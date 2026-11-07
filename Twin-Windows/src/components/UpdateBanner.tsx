import { useEffect, useState } from "react";
import { Sparkles, RefreshCw, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { updateGetState, updateInstall, updateClearPending } from "@/lib/tauri";

export function UpdateBanner() {
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void updateGetState()
      .then((s) => {
        if (s?.ready_version) {
          setReadyVersion(s.ready_version);
        }
      })
      .catch(() => undefined);

    const unlistenPromise = listen<{ version: string; notes?: string }>(
      "update://ready",
      (ev) => {
        setReadyVersion(ev.payload.version);
        setDismissed(false);
      }
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  if (!readyVersion || dismissed) return null;

  const displayVersion = readyVersion.startsWith("v")
    ? readyVersion.slice(1)
    : readyVersion;

  async function handleRestart() {
    setInstalling(true);
    try {
      await updateInstall();
    } catch {
      setInstalling(false);
    }
  }

  function handleDismiss() {
    setDismissed(true);
    void updateClearPending();
  }

  return (
    <div
      className="fixed bottom-5 right-5 z-[100] flex items-center gap-3 rounded-xl border border-blue-500/30 bg-[var(--surface)]/95 px-4 py-3 shadow-elevation backdrop-blur-md animate-in fade-in slide-in-from-bottom-3 duration-200"
      role="status"
      aria-live="polite"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">
        <Sparkles className="h-4 w-4" />
      </div>

      <div className="flex flex-col min-w-0">
        <span className="text-xs font-semibold text-white tracking-tight">
          Twin v{displayVersion} is ready to apply
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">
          Downloaded seamlessly in background
        </span>
      </div>

      <div className="flex items-center gap-2 ml-2 shrink-0">
        <button
          type="button"
          onClick={handleRestart}
          disabled={installing}
          className="rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 px-3 py-1.5 text-xs font-semibold text-white transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
        >
          {installing ? (
            <>
              <RefreshCw size={12} className="animate-spin" />
              Applying…
            </>
          ) : (
            "Restart & Apply"
          )}
        </button>

        <button
          type="button"
          onClick={handleDismiss}
          className="text-[var(--text-subtle)] hover:text-white p-1 rounded-md transition-colors cursor-pointer"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
