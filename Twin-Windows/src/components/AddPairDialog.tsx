/**
 * Add Synced Folder Pair Dialog
 * Desktop modal for selecting local directories, traversing Google Drive
 * folder hierarchies, and choosing sync topologies.
 */
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Folder,
  ArrowLeftRight,
  CloudUpload,
  FlipHorizontal2,
  X,
  FolderSearch,
  Link2,
  Check,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addPair, pickFolder } from "@/lib/tauri";
import type { PairEntry, PairMode } from "@/lib/tauri";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DriveFolderSelector } from "@/components/DriveFolderSelector";
import gdLogo from "@/assets/gd-icon.png";

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
    desc: "Bidirectional continuous replication. Changes made locally or in Google Drive propagate automatically.",
    Icon: ArrowLeftRight,
    badge: "Recommended",
  },
  {
    id: "upload",
    title: "Cloud Backup",
    desc: "One-way upload. Local edits sync to Google Drive. Remote changes will never alter local files.",
    Icon: CloudUpload,
    badge: "Upload Only",
  },
  {
    id: "mirror",
    title: "Cloud Mirror",
    desc: "Strict mirror. Keeps the remote Google Drive directory as an exact mirror image of the local folder.",
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
  const [deletion, setDeletion] = useState<"drive_trash" | "delete">("drive_trash");
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
        deletion,
      };
      await addPair(pair);
      toast.success("Folder pair configured successfully");
      onAdded();
      onClose();
      setLocal("");
      setDriveInput("");
      setSelectedDriveName("");
      setMode("two_way");
      setDeletion("drive_trash");
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
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in fade-in duration-150" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] max-w-[94vw] max-h-[92vh] overflow-y-auto bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 z-[60] shadow-elevation animate-in zoom-in-95 duration-150">
          {/* Header */}
          <div className="flex items-start justify-between pb-3.5 border-b border-[var(--border-subtle)] mb-5">
            <div>
              <Dialog.Title className="text-base font-bold text-white tracking-tight">
                Add Synced Folder Pair
              </Dialog.Title>
              <Dialog.Description className="text-xs text-[var(--text-muted)] mt-1">
                Link a local folder with a Google Drive directory for continuous sync.
              </Dialog.Description>
            </div>
            <button
              onClick={onClose}
              className="text-[var(--text-subtle)] hover:text-white p-1 rounded-lg hover:bg-[var(--surface-2)] transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>

          <div className="space-y-5">
            {/* 1. Local path input */}
            <div>
              <label className="block text-xs font-semibold text-white mb-2 flex items-center gap-2">
                <Folder size={15} className="text-blue-400" />
                Local Folder Path
              </label>
              <div className="flex items-center gap-2.5">
                <Input
                  value={local}
                  onChange={(e) => {
                    setLocal(e.target.value);
                    if (localErr) setLocalErr("");
                  }}
                  placeholder="e.g. C:\Users\Username\Documents\Work"
                  className="code-text text-xs flex-1 h-9"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handlePickLocal}
                  className="shrink-0 flex items-center gap-2 px-3.5 h-9"
                >
                  <FolderSearch size={14} className="text-[var(--text-muted)]" />
                  <span>Browse…</span>
                </Button>
              </div>
              {localErr && (
                <p className="text-xs text-red-400 mt-1.5 font-medium">{localErr}</p>
              )}
            </div>

            {/* 2. Google Drive Target */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-white flex items-center gap-2">
                  <img
                    src={gdLogo}
                    alt="Google Drive"
                    style={{ width: 16, height: 16, minWidth: 16, maxWidth: 16 }}
                    className="w-4 h-4 object-contain shrink-0"
                  />
                  Google Drive Target Folder
                </label>
                <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] text-xs">
                  <button
                    type="button"
                    onClick={() => setDriveSelectionMode("explorer")}
                    className={cn(
                      "px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer",
                      driveSelectionMode === "explorer"
                        ? "bg-[var(--surface)] text-white shadow-sm"
                        : "text-[var(--text-muted)] hover:text-white"
                    )}
                  >
                    Drive Browser
                  </button>
                  <button
                    type="button"
                    onClick={() => setDriveSelectionMode("manual")}
                    className={cn(
                      "px-2.5 py-1 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer",
                      driveSelectionMode === "manual"
                        ? "bg-[var(--surface)] text-white shadow-sm"
                        : "text-[var(--text-muted)] hover:text-white"
                    )}
                  >
                    <Link2 size={12} />
                    <span>Paste Link / ID</span>
                  </button>
                </div>
              </div>

              {driveSelectionMode === "explorer" ? (
                <div className="space-y-2.5">
                  <DriveFolderSelector
                    selectedFolderId={driveInput}
                    onSelect={handleDriveFolderSelected}
                  />
                  {selectedDriveName && (
                    <div className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs">
                      <span className="text-[var(--text-muted)]">
                        Selected: <strong className="text-white font-semibold">{selectedDriveName}</strong>
                      </span>
                      <span className="code-text text-xs text-[var(--text-subtle)]">
                        {driveInput}
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
                    placeholder="https://drive.google.com/drive/folders/… or folder ID"
                    className="code-text text-xs h-9"
                  />
                  <p className="text-xs text-[var(--text-subtle)] mt-1.5">
                    Paste a direct Google Drive folder URL or ID.
                  </p>
                </div>
              )}

              {driveErr && (
                <p className="text-xs text-red-400 mt-1.5 font-medium">{driveErr}</p>
              )}
            </div>

            {/* 3. Sync Mode Selection */}
            <div>
              <label className="block text-xs font-semibold text-white mb-2.5">
                Synchronization Topology
              </label>
              <div className="grid grid-cols-1 gap-2.5">
                {MODES.map((m) => {
                  const isSelected = mode === m.id;
                  const ModeIcon = m.Icon;
                  return (
                    <div
                      key={m.id}
                      onClick={() => setMode(m.id)}
                      className={cn(
                        "p-3.5 rounded-xl border text-left cursor-pointer transition-all duration-150 flex items-start gap-3.5",
                        isSelected
                          ? "bg-blue-500/10 border-blue-500/40 shadow-sm"
                          : "bg-[var(--surface-2)]/40 border-[var(--border)] hover:border-white/15"
                      )}
                    >
                      <div
                        className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border mt-0.5",
                          isSelected
                            ? "bg-blue-500/20 border-blue-500/30 text-blue-400"
                            : "bg-[var(--surface-3)] border-transparent text-[var(--text-muted)]"
                        )}
                      >
                        <ModeIcon size={16} strokeWidth={2} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-white">
                            {m.title}
                          </span>
                          <span
                            className={cn(
                              "text-xs code-text px-2 py-0.5 rounded border font-semibold",
                              isSelected
                                ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
                                : "bg-white/[0.04] text-[var(--text-subtle)] border-white/5"
                            )}
                          >
                            {m.badge}
                          </span>
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                          {m.desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 4. Google Drive Deletion Behavior */}
            <div>
              <label className="block text-xs font-semibold text-white mb-2 flex items-center gap-2">
                <Trash2 size={14} className="text-red-400" />
                Google Drive Deletion Behavior
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setDeletion("drive_trash")}
                  className={cn(
                    "p-3 rounded-xl border text-left cursor-pointer transition-all duration-150 flex flex-col gap-1",
                    deletion === "drive_trash"
                      ? "bg-blue-500/10 border-blue-500/40 shadow-sm"
                      : "bg-[var(--surface-2)]/40 border-[var(--border)] hover:border-white/15"
                  )}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="text-xs font-bold text-white">Move to Drive Trash</span>
                    {deletion === "drive_trash" && <Check size={13} className="text-blue-400" />}
                  </div>
                  <span className="text-xs text-[var(--text-muted)]">30-day recovery in Google Drive</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDeletion("delete")}
                  className={cn(
                    "p-3 rounded-xl border text-left cursor-pointer transition-all duration-150 flex flex-col gap-1",
                    deletion === "delete"
                      ? "bg-red-500/10 border-red-500/40 shadow-sm"
                      : "bg-[var(--surface-2)]/40 border-[var(--border)] hover:border-white/15"
                  )}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="text-xs font-bold text-white">Delete Permanently</span>
                    {deletion === "delete" && <Check size={13} className="text-red-400" />}
                  </div>
                  <span className="text-xs text-[var(--text-muted)]">Bypasses trash, frees quota instantly</span>
                </button>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2.5 mt-6 pt-3.5 border-t border-[var(--border-subtle)]">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={saving}
              className="min-w-[110px]"
            >
              {saving ? "Connecting…" : "Create Pair"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
