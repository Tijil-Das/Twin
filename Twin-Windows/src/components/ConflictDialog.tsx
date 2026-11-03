/**
 * Pro Conflict Resolution Dialog — Interactive choice between
 * local version, remote Drive version, or keeping both.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useStore, type ConflictRecord } from "@/store";
import { resolveConflict } from "@/lib/tauri";
import { toast } from "sonner";
import { AlertTriangle, HardDrive, Cloud, Copy } from "lucide-react";

interface Props {
  conflict: ConflictRecord;
}

export function ConflictDialog({ conflict }: Props) {
  const removeConflict = useStore((s) => s.removeConflict);

  async function resolve(choice: "local" | "remote" | "both") {
    try {
      await resolveConflict(conflict.pair_id, conflict.rel_path, choice);
      removeConflict(conflict.pair_id, conflict.rel_path);
      toast.success(
        choice === "both"
          ? "Kept both copies (suffix added)"
          : choice === "local"
          ? "Local copy preserved"
          : "Remote version accepted"
      );
    } catch (e) {
      toast.error(`Conflict resolution failed: ${String(e)}`);
    }
  }

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in fade-in duration-200" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] max-w-[92vw] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 z-51 shadow-2xl animate-in zoom-in-95 duration-200"
          onEscapeKeyDown={() => removeConflict(conflict.pair_id, conflict.rel_path)}
        >
          {/* Header */}
          <div className="flex items-start gap-3.5 mb-4">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
              <AlertTriangle size={18} strokeWidth={2} />
            </div>
            <div>
              <Dialog.Title className="text-base font-bold text-[var(--text)] tracking-tight">
                File Conflict Detected
              </Dialog.Title>
              <Dialog.Description className="text-xs text-[var(--text-muted)] mt-1">
                Both local and remote copies of this file have changed concurrently.
              </Dialog.Description>
            </div>
          </div>

          {/* File path box */}
          <div className="p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] font-mono text-xs text-[var(--text)] break-all mb-4">
            {conflict.rel_path}
          </div>

          {/* Choice cards */}
          <div className="space-y-2 mb-5">
            <button
              onClick={() => resolve("both")}
              className="w-full p-3 rounded-xl border border-[var(--border)] hover:border-blue-500/40 bg-[var(--surface-2)]/50 hover:bg-blue-600/10 text-left transition-all flex items-start gap-3 cursor-pointer group"
            >
              <div className="w-7 h-7 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center shrink-0 mt-0.5">
                <Copy size={14} />
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text)] group-hover:text-blue-300">
                  Keep Both (Recommended)
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Appends a conflict timestamp suffix to the local file and keeps both versions.
                </p>
              </div>
            </button>

            <button
              onClick={() => resolve("local")}
              className="w-full p-3 rounded-xl border border-[var(--border)] hover:border-blue-500/40 bg-[var(--surface-2)]/50 hover:bg-blue-600/10 text-left transition-all flex items-start gap-3 cursor-pointer group"
            >
              <div className="w-7 h-7 rounded-lg bg-[var(--surface-3)] text-[var(--text-muted)] flex items-center justify-center shrink-0 mt-0.5">
                <HardDrive size={14} />
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text)] group-hover:text-blue-300">
                  Keep Local Version
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Overwrites the Google Drive copy with your local computer copy.
                </p>
              </div>
            </button>

            <button
              onClick={() => resolve("remote")}
              className="w-full p-3 rounded-xl border border-[var(--border)] hover:border-blue-500/40 bg-[var(--surface-2)]/50 hover:bg-blue-600/10 text-left transition-all flex items-start gap-3 cursor-pointer group"
            >
              <div className="w-7 h-7 rounded-lg bg-[var(--surface-3)] text-[var(--text-muted)] flex items-center justify-center shrink-0 mt-0.5">
                <Cloud size={14} />
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text)] group-hover:text-blue-300">
                  Keep Google Drive Version
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Replaces your local copy with the latest version from Google Drive.
                </p>
              </div>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
