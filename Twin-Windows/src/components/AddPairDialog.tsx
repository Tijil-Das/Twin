/**
 * Pro Add-Pair Dialog — Windows Explorer style Google Drive folder selector,
 * native local folder picker, and updated sync mode icons.
 */
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Folder,
  Cloud,
  ArrowLeftRight,
  CloudUpload,
  FlipHorizontal2,
  X,
  FolderSearch,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addPair, pickFolder } from "@/lib/tauri";
import type { PairEntry, PairMode } from "@/lib/tauri";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DriveFolderSelector } from "@/components/DriveFolderSelector";

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
  Icon: typeof ArrowLeftRight;
  badge: string;
}[] = [
  {
    id: "two_way",
    title: "Two-Way Sync",
    desc: "Bidirectional continuous replication. Changes in both local and Drive propagate automatically.",
    Icon: ArrowLeftRight,
    badge: "Recommended",
  },
  {
    id: "upload",
    title: "Cloud Backup",
    desc: "One-way upload. Local edits sync to Google Drive. Remote changes do not overwrite local files.",
    Icon: CloudUpload,
    badge: "Upload Only",
  },
  {
    id: "mirror",
    title: "Cloud Mirror",
    desc: "Strict mirror. Keeps the remote Drive folder as an exact mirror image of local folder state.",
    Icon: FlipHorizontal2,
    badge: "Mirror",
  },
];

export function AddPairDialog({ open, onClose, onAdded }: Props) {
  const [local, setLocal] = useState("");
  const [driveInput, setDriveInput] = useState("");
  const [selectedDriveName, setSelectedDriveName] = useState<string>("");
  const [driveSelectionMode, setDriveSelectionMode] = useState<"explorer" | "manual">("explorer");
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
      setDriveErr("Please choose a Google Drive folder or provide its ID.");
      ok = false;
    } else {
      setDriveErr("");
    }
    return ok;
  }

  async function handlePickLocal() {
    try {
      const selected = await pickFolder();
      if (selected) {
        setLocal(selected);
        setLocalErr("");
      }
    } catch (e) {
      console.warn("Folder picker error:", e);
    }
  }

  function handleDriveFolderSelected(id: string, name: string) {
    setDriveInput(id);
    setSelectedDriveName(name);
    setDriveErr("");
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
      setSelectedDriveName("");
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
        <Dialog.Overlay className="fixed inset-0 bg-black/70 z-50 animate-in fade-in duration-150" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[580px] max-w-[94vw] max-h-[92vh] overflow-y-auto bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 z-[60] shadow-2xl animate-in zoom-in-95 duration-150">
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
            {/* 1. Local path input with Browse Button */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text)] mb-1.5 flex items-center gap-1.5">
                <Folder size={13} className="text-blue-400" />
                Local Folder Path
              </label>
              <div className="flex items-center gap-2">
                <Input
                  value={local}
                  onChange={(e) => {
                    setLocal(e.target.value);
                    if (localErr) setLocalErr("");
                  }}
                  placeholder="T:\MyProjects\SourceCode  or  C:\Users\You\Documents"
                  className="font-mono text-[12px] flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handlePickLocal}
                  className="shrink-0 text-xs flex items-center gap-1.5 px-3 h-9"
                >
                  <FolderSearch size={14} className="text-blue-400" />
                  <span>Browse…</span>
                </Button>
              </div>
              {localErr && (
                <p className="text-[11px] text-red-400 mt-1 font-medium">{localErr}</p>
              )}
            </div>

            {/* 2. Google Drive Folder Selector (Windows Explorer Style) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[12px] font-semibold text-[var(--text)] flex items-center gap-1.5">
                  <Cloud size={13} className="text-blue-400" />
                  Google Drive Folder
                </label>
                <div className="flex items-center gap-1 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setDriveSelectionMode("explorer")}
                    className={cn(
                      "px-2 py-0.5 rounded transition-colors",
                      driveSelectionMode === "explorer"
                        ? "bg-blue-600/20 text-blue-400 font-semibold border border-blue-500/30"
                        : "text-zinc-400 hover:text-white"
                    )}
                  >
                    Explorer View
                  </button>
                  <button
                    type="button"
                    onClick={() => setDriveSelectionMode("manual")}
                    className={cn(
                      "px-2 py-0.5 rounded transition-colors flex items-center gap-1",
                      driveSelectionMode === "manual"
                        ? "bg-blue-600/20 text-blue-400 font-semibold border border-blue-500/30"
                        : "text-zinc-400 hover:text-white"
                    )}
                  >
                    <Link2 size={11} />
                    <span>Paste Link / ID</span>
                  </button>
                </div>
              </div>

              {driveSelectionMode === "explorer" ? (
                <div className="space-y-2">
                  <DriveFolderSelector
                    selectedFolderId={driveInput}
                    onSelect={handleDriveFolderSelected}
                  />
                  {selectedDriveName && (
                    <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-blue-600/10 border border-blue-500/30 text-xs">
                      <span className="text-zinc-400">
                        Selected Target:{" "}
                        <strong className="text-blue-400">{selectedDriveName}</strong>
                      </span>
                      <span className="font-mono text-[10.5px] text-zinc-500">
                        ID: {driveInput}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <Input
                    value={driveInput}
                    onChange={(e) => {
                      setDriveInput(e.target.value);
                      setSelectedDriveName("");
                      if (driveErr) setDriveErr("");
                    }}
                    placeholder="https://drive.google.com/drive/folders/1aBcD_...  or  folder ID"
                    className="font-mono text-[12px]"
                  />
                  <p className="text-[11px] text-[var(--text-subtle)] mt-1">
                    Paste the direct browser link or unique folder ID from Google Drive.
                  </p>
                </div>
              )}

              {driveErr && (
                <p className="text-[11px] text-red-400 mt-1 font-medium">{driveErr}</p>
              )}
            </div>

            {/* 3. Sync Mode Selection: Visual Cards with Updated Icons */}
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
              className="bg-blue-600 hover:bg-blue-500 min-w-[110px]"
            >
              {saving ? "Connecting…" : "Create Pair"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
