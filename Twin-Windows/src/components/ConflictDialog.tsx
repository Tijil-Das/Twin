/**
 * Conflict Resolution Dialog
 * Interactive choice between local version, remote Drive version, or keeping both.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useStore, type ConflictRecord } from "@/store";
import { resolveConflict } from "@/lib/tauri";
import { toast } from "sonner";
import { AlertTriangle, HardDrive, Cloud, Copy, X } from "lucide-react";

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
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in fade-in duration-150" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[92vw] bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 z-[60] shadow-elevation animate-in zoom-in-95 duration-150"
          onEscapeKeyDown={() => removeConflict(conflict.pair_id, conflict.rel_path)}
        >
          {/* Header */}
          <div className="flex items-start justify-between pb-3 border-b border-[var(--border-subtle)] mb-4">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
                <AlertTriangle size={16} strokeWidth={2} />
              </div>
              <div>
                <Dialog.Title className="text-sm font-semibold text-[var(--text)] tracking-tight">
                  File Conflict Detected
                </Dialog.Title>
                <Dialog.Description className="text-xs text-[var(--text-muted)] mt-0.5">
                  Both local and remote files were modified concurrently.
                </Dialog.Description>
              </div>
            </div>

            <button
              onClick={() => removeConflict(conflict.pair_id, conflict.rel_path)}
              className="text-[var(--text-subtle)] hover:text-white p-1 rounded-md transition-colors"
            >
              <X size={15} />
            </button>
          </div>

          {/* Conflicted file path */}
          <div className="p-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] code-text text-xs text-[var(--text)] break-all mb-4">
            {conflict.rel_path}
          </div>

          {/* Choice cards */}
          <div className="space-y-2">
            <button
              onClick={() => resolve("both")}
              className="w-full p-3 rounded-lg border border-[var(--border)] hover:border-blue-500/40 bg-[var(--surface-2)]/40 hover:bg-blue-600/10 text-left transition-all flex items-start gap-3 cursor-pointer group"
            >
              <div className="w-7 h-7 rounded-md bg-blue-600/15 text-blue-400 flex items-center justify-center shrink-0 mt-0.5">
                <Copy size={13} />
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text)] group-hover:text-blue-300">
                  Keep Both (Recommended)
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Appends a conflict timestamp to the local file and preserves both copies.
                </p>
              </div>
            </button>

            <button
              onClick={() => resolve("local")}
              className="w-full p-3 rounded-lg border border-[var(--border)] hover:border-white/20 bg-[var(--surface-2)]/40 hover:bg-[var(--surface-2)] text-left transition-all flex items-start gap-3 cursor-pointer group"
            >
              <div className="w-7 h-7 rounded-md bg-[var(--surface-3)] text-[var(--text-muted)] flex items-center justify-center shrink-0 mt-0.5">
                <HardDrive size={13} />
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text)] group-hover:text-white">
                  Keep Local Version
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Overwrites the Google Drive copy with your local computer copy.
                </p>
              </div>
            </button>

            <button
              onClick={() => resolve("remote")}
              className="w-full p-3 rounded-lg border border-[var(--border)] hover:border-white/20 bg-[var(--surface-2)]/40 hover:bg-[var(--surface-2)] text-left transition-all flex items-start gap-3 cursor-pointer group"
            >
              <div className="w-7 h-7 rounded-md bg-[var(--surface-3)] text-[var(--text-muted)] flex items-center justify-center shrink-0 mt-0.5">
                <Cloud size={13} />
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text)] group-hover:text-white">
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
