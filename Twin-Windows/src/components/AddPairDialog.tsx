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

  function handleDriveFolderSelected(id: string) {
    setDriveInput(id);
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
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 animate-in fade-in duration-150" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[680px] max-w-[95vw] max-h-[92vh] overflow-y-auto bg-[#0d1117] border border-[#30363d] rounded-xl p-6 z-[60] shadow-2xl animate-in zoom-in-95 duration-150">
          {/* Header */}
          <div className="flex items-start justify-between pb-3.5 border-b border-[#30363d] mb-5">
            <div>
              <Dialog.Title className="text-base font-semibold text-[#e6edf3] tracking-tight">
                Add Synced Folder Pair
              </Dialog.Title>
              <Dialog.Description className="text-xs text-[#7d8590] mt-1">
                Link a local directory with a Google Drive folder for continuous automated synchronization.
              </Dialog.Description>
            </div>
            <button
              onClick={onClose}
              className="text-[#7d8590] hover:text-[#e6edf3] p-1.5 rounded-md hover:bg-[#21262d] transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>

          <div className="space-y-5">
            {/* 1. Local path input */}
            <div>
              <label className="block text-sm font-medium text-[#e6edf3] mb-2 flex items-center gap-2">
                <Folder size={16} className="text-[#58a6ff]" />
                Local Folder Path
              </label>
              <div className="flex items-center gap-2.5">
                <Input
                  value={local}
                  onChange={(e) => {
                    setLocal(e.target.value);
                    if (localErr) setLocalErr("");
                  }}
                  placeholder="e.g. D:\Documents or C:\Users\Username\Projects"
                  className="font-mono text-xs flex-1 h-10 bg-[#161b22] border-[#30363d] text-[#e6edf3] placeholder:text-[#484f58] focus:border-[#58a6ff]"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handlePickLocal}
                  className="shrink-0 flex items-center gap-2 px-4 h-10 bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] hover:text-white border border-[#30363d] text-xs font-medium cursor-pointer"
                >
                  <FolderSearch size={14} className="text-[#7d8590]" />
                  <span>Browse…</span>
                </Button>
              </div>
              {localErr && (
                <p className="text-xs text-[#f85149] mt-1.5 font-medium">{localErr}</p>
              )}
            </div>

            {/* 2. Google Drive Target */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-[#e6edf3] flex items-center gap-2">
                  <img
                    src={gdLogo}
                    alt="Google Drive"
                    style={{ width: 16, height: 16, minWidth: 16, maxWidth: 16 }}
                    className="w-4 h-4 object-contain shrink-0"
                  />
                  Google Drive Target Folder
                </label>
                <div className="flex items-center gap-1 p-0.5 rounded-md bg-[#161b22] border border-[#30363d] text-xs">
                  <button
                    type="button"
                    onClick={() => setDriveSelectionMode("explorer")}
                    className={cn(
                      "px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer",
                      driveSelectionMode === "explorer"
                        ? "bg-[#21262d] text-[#e6edf3] shadow-sm font-semibold border border-[#30363d]"
                        : "text-[#7d8590] hover:text-[#c9d1d9]"
                    )}
                  >
                    Drive Browser
                  </button>
                  <button
                    type="button"
                    onClick={() => setDriveSelectionMode("manual")}
                    className={cn(
                      "px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer",
                      driveSelectionMode === "manual"
                        ? "bg-[#21262d] text-[#e6edf3] shadow-sm font-semibold border border-[#30363d]"
                        : "text-[#7d8590] hover:text-[#c9d1d9]"
                    )}
                  >
                    <Link2 size={12} />
                    <span>Paste Link / ID</span>
                  </button>
                </div>
              </div>

              {driveSelectionMode === "explorer" ? (
                <div>
                  <DriveFolderSelector
                    selectedFolderId={driveInput}
                    onSelect={handleDriveFolderSelected}
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Input
                    value={driveInput}
                    onChange={(e) => {
                      setDriveInput(e.target.value);
                      if (driveErr) setDriveErr("");
                    }}
                    placeholder="https://drive.google.com/drive/folders/… or folder ID"
                    className="font-mono text-xs h-10 bg-[#161b22] border-[#30363d] text-[#e6edf3] placeholder:text-[#484f58] focus:border-[#58a6ff]"
                  />
                  <p className="text-xs text-[#7d8590]">
                    Paste a direct Google Drive folder URL or 33-character folder ID.
                  </p>
                </div>
              )}

              {driveErr && (
                <p className="text-xs text-[#f85149] mt-1.5 font-medium">{driveErr}</p>
              )}
            </div>

            {/* 3. Sync Mode Selection */}
            <div>
              <label className="block text-sm font-medium text-[#e6edf3] mb-2">
                Sync Topology & Mode
              </label>
              <div className="grid grid-cols-3 gap-3">
                {MODES.map((m) => {
                  const isSelected = mode === m.id;
                  const ModeIcon = m.Icon;
                  return (
                    <div
                      key={m.id}
                      onClick={() => setMode(m.id)}
                      className={cn(
                        "p-3 rounded-lg border text-left cursor-pointer transition-all duration-150 flex flex-col justify-between gap-2.5",
                        isSelected
                          ? "bg-blue-900/30 border-blue-600 shadow-sm ring-1 ring-blue-600/40"
                          : "bg-[#161b22] border-[#30363d] hover:border-[#8b949e]/40 hover:bg-[#1c2128]"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div
                          className={cn(
                            "w-7 h-7 rounded-md flex items-center justify-center shrink-0",
                            isSelected ? "text-blue-300 bg-blue-700/40" : "text-[#7d8590] bg-[#21262d]"
                          )}
                        >
                          <ModeIcon size={16} strokeWidth={2} />
                        </div>
                        <span
                          className={cn(
                            "text-xs px-2 py-0.5 rounded-full border font-medium",
                            isSelected
                              ? "bg-blue-700/30 text-blue-300 border-blue-600/50"
                              : "bg-[#21262d] text-[#7d8590] border-[#30363d]"
                          )}
                        >
                          {m.badge}
                        </span>
                      </div>
                      <div>
                        <span className="text-sm font-semibold text-[#e6edf3] block">
                          {m.title}
                        </span>
                        <p className="text-xs text-[#7d8590] mt-1 leading-relaxed">
                          {m.desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 4. Google Drive Deletion Behavior */}
            <div className="flex items-center justify-between gap-4 p-3 rounded-lg bg-[#161b22] border border-[#30363d]">
              <div>
                <span className="text-sm font-medium text-[#e6edf3] block">
                  Remote Deletion Safety
                </span>
                <span className="text-xs text-[#7d8590] mt-0.5 block">
                  {deletion === "drive_trash"
                    ? "Deleted local files are safely moved to Drive Trash (30-day recovery window)"
                    : "Permanently delete remote files immediately without moving to trash"}
                </span>
              </div>
              <div className="flex items-center gap-1 p-0.5 rounded-md bg-[#0d1117] border border-[#30363d] shrink-0">
                <button
                  type="button"
                  onClick={() => setDeletion("drive_trash")}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                    deletion === "drive_trash"
                      ? "bg-blue-700 hover:bg-blue-600 text-white shadow-sm font-semibold border border-blue-600/40"
                      : "text-[#7d8590] hover:text-[#c9d1d9]"
                  )}
                >
                  Drive Trash
                </button>
                <button
                  type="button"
                  onClick={() => setDeletion("delete")}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                    deletion === "delete"
                      ? "bg-[#da3633] text-white shadow-sm font-semibold"
                      : "text-[#7d8590] hover:text-[#c9d1d9]"
                  )}
                >
                  Permanent
                </button>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-[#30363d]">
            <Button
              variant="ghost"
              onClick={onClose}
              disabled={saving}
              className="h-9 px-4 text-xs font-medium text-[#c9d1d9] hover:text-white hover:bg-[#21262d] cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={saving}
              className="h-9 px-5 text-xs font-semibold bg-[#238636] hover:bg-[#2ea043] text-white rounded-md shadow-sm border border-[rgba(240,246,252,0.1)] cursor-pointer"
            >
              {saving ? "Connecting…" : "Create Pair"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
