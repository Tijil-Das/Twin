/**
 * Pro Add-Pair Dialog — Visual mode cards, Drive URL parser,
 * and high-contrast inputs with validation.
 */
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Folder,
  Cloud,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
  CheckCircle2,
  Sparkles,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addPair } from "@/lib/tauri";
import type { PairEntry, PairMode } from "@/lib/tauri";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

function parseDriveFolderId(input: string): string {
  const m = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : input.trim();
}

const MODES: {
  id: PairMode;
  title: string;
  desc: string;
  Icon: typeof ArrowUpDown;
  badge: string;
}[] = [
  {
    id: "two_way",
    title: "Two-Way Sync",
    desc: "Bidirectional continuous replication. Changes in both local and Drive propagate automatically.",
    Icon: ArrowUpDown,
    badge: "Recommended",
  },
  {
    id: "upload",
    title: "Cloud Backup",
    desc: "One-way upload. Local edits sync to Google Drive. Remote changes do not overwrite local files.",
    Icon: ArrowUp,
    badge: "Upload Only",
  },
  {
    id: "mirror",
    title: "Cloud Mirror",
    desc: "Strict mirror. Keeps the remote Drive folder as an exact mirror image of local folder state.",
    Icon: ArrowDown,
    badge: "Mirror",
  },
];

export function AddPairDialog({ open, onClose, onAdded }: Props) {
  const [local, setLocal] = useState("");
  const [driveInput, setDriveInput] = useState("");
  const [mode, setMode] = useState<PairMode>("two_way");
  const [saving, setSaving] = useState(false);
  const [localErr, setLocalErr] = useState("");
  const [driveErr, setDriveErr] = useState("");

  function validate(): boolean {
    let ok = true;
    if (!local.trim()) {
      setLocalErr("Local path is required.");
      ok = false;
    } else {
      setLocalErr("");
    }
    if (!driveInput.trim()) {
      setDriveErr("Google Drive folder ID or URL is required.");
      ok = false;
    } else {
      setDriveErr("");
    }
    return ok;
  }

  async function handleAdd() {
    if (!validate()) return;
    setSaving(true);
    try {
      const pair: PairEntry = {
        id: crypto.randomUUID(),
        local: local.trim(),
        drive_folder_id: parseDriveFolderId(driveInput),
        mode,
        enabled: true,
      };
      await addPair(pair);
      toast.success("Folder pair connected successfully");
      onAdded();
      onClose();
      setLocal("");
      setDriveInput("");
      setMode("two_way");
    } catch (e) {
      toast.error(`Failed to add folder pair: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in fade-in duration-200" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] max-w-[92vw] bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 z-51 shadow-2xl animate-in zoom-in-95 duration-200">
          {/* Header */}
          <div className="flex items-start justify-between mb-5">
            <div>
              <Dialog.Title className="text-base font-bold text-[var(--text)] tracking-tight">
                Add Synced Folder Pair
              </Dialog.Title>
              <Dialog.Description className="text-[12px] text-[var(--text-muted)] mt-1">
                Link a local folder with a Google Drive folder for continuous sync.
              </Dialog.Description>
            </div>
            <button
              onClick={onClose}
              className="text-[var(--text-muted)] hover:text-[var(--text)] p-1 rounded-lg hover:bg-[var(--surface-2)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          <div className="space-y-4">
            {/* Local path input */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text)] mb-1.5 flex items-center gap-1.5">
                <Folder size={13} className="text-blue-400" />
                Local Folder Path
              </label>
              <Input
                value={local}
                onChange={(e) => {
                  setLocal(e.target.value);
                  if (localErr) setLocalErr("");
                }}
                placeholder="T:\MyProjects\SourceCode  or  C:\Users\You\Documents"
                className="font-mono text-[12px]"
              />
              {localErr && (
                <p className="text-[11px] text-red-400 mt-1 font-medium">{localErr}</p>
              )}
            </div>

            {/* Google Drive Folder ID / URL input */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text)] mb-1.5 flex items-center gap-1.5">
                <Cloud size={13} className="text-blue-400" />
                Google Drive Folder URL or ID
              </label>
              <Input
                value={driveInput}
                onChange={(e) => {
                  setDriveInput(e.target.value);
                  if (driveErr) setDriveErr("");
                }}
                placeholder="https://drive.google.com/drive/folders/1aBcD_...  or  folder ID"
                className="font-mono text-[12px]"
              />
              {driveErr ? (
                <p className="text-[11px] text-red-400 mt-1 font-medium">{driveErr}</p>
              ) : (
                <p className="text-[11px] text-[var(--text-subtle)] mt-1">
                  Paste the direct link from your browser or the unique folder ID.
                </p>
              )}
            </div>

            {/* Sync Mode Selection: Visual Cards */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text)] mb-2">
                Synchronization Mode
              </label>
              <div className="grid grid-cols-1 gap-2">
                {MODES.map((m) => {
                  const selected = mode === m.id;
                  const ModeIcon = m.Icon;
                  return (
                    <div
                      key={m.id}
                      onClick={() => setMode(m.id)}
                      className={cn(
                        "p-3 rounded-xl border text-left cursor-pointer transition-all duration-150 flex items-start gap-3",
                        selected
                          ? "bg-blue-600/10 border-blue-500/40 shadow-sm"
                          : "bg-[var(--surface-2)]/40 border-[var(--border)] hover:border-zinc-600"
                      )}
                    >
                      <div
                        className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border mt-0.5",
                          selected
                            ? "bg-blue-600/20 border-blue-500/30 text-blue-400"
                            : "bg-[var(--surface-3)] border-transparent text-[var(--text-muted)]"
                        )}
                      >
                        <ModeIcon size={15} strokeWidth={2} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] font-semibold text-[var(--text)]">
                            {m.title}
                          </span>
                          <span
                            className={cn(
                              "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
                              selected
                                ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                                : "bg-zinc-800 text-zinc-400 border-zinc-700"
                            )}
                          >
                            {m.badge}
                          </span>
                        </div>
                        <p className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
                          {m.desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2.5 mt-6 pt-4 border-t border-[var(--border)]">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={saving}
              className="bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/25 min-w-[110px]"
            >
              {saving ? "Connecting…" : "Create Pair"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
