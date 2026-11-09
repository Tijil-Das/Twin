/**
 * Add Synced Folder Pair Dialog
 * Desktop modal for selecting local directories, traversing Google Drive
 * folder hierarchies, and choosing sync topologies.
 */
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeftRight,
  CloudUpload,
  FlipHorizontal2,
  X,
  Link2,
  ChevronDown,
  Pencil,
  Check,
  Compass,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/store";
import { addPair, pickFolder } from "@/lib/tauri";
import type { PairEntry, PairMode } from "@/lib/tauri";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DriveFolderSelector } from "@/components/DriveFolderSelector";
import { GithubFolderIcon } from "@/components/ui/GithubFolderIcon";
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

function getLocalFolderName(path: string): string {
  if (!path) return "";
  const cleaned = path.trim().replace(/[/\\]+$/, "");
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || cleaned;
}

const MODES: {
  id: PairMode;
  title: string;
  subtitle: string;
  desc: string;
  Icon: typeof ArrowLeftRight;
  badge?: string;
}[] = [
  {
    id: "two_way",
    title: "Two-Way Sync",
    subtitle: "Bidirectional continuous replication",
    desc: "Local and Google Drive edits sync both ways automatically.",
    Icon: ArrowLeftRight,
    badge: "Recommended",
  },
  {
    id: "upload",
    title: "Cloud Backup",
    subtitle: "Local to cloud upload only",
    desc: "PC edits sync to Drive. Remote edits will not touch local files.",
    Icon: CloudUpload,
    badge: "Upload Only",
  },
  {
    id: "mirror",
    title: "Cloud Mirror",
    subtitle: "Exact replica of local folder",
    desc: "Google Drive is strictly mirrored to match your PC folder.",
    Icon: FlipHorizontal2,
    badge: "Mirror",
  },
];

export function AddPairDialog({ open, onClose, onAdded }: Props) {
  const pairs = useStore((s) => s.pairs) ?? [];
  const [local, setLocal] = useState("");
  const [isEditingLocalPath, setIsEditingLocalPath] = useState(false);
  const [driveInput, setDriveInput] = useState("");
  const [driveFolderName, setDriveFolderName] = useState("");
  const [driveSelectionMode, setDriveSelectionMode] = useState<"explorer" | "manual">("explorer");
  const [mode, setMode] = useState<PairMode>("two_way");
  const [deletion, setDeletion] = useState<"drive_trash" | "delete">("drive_trash");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localErr, setLocalErr] = useState("");
  const [driveErr, setDriveErr] = useState("");

  function validate(): boolean {
    let ok = true;
    const cleanLocal = local.trim();
    if (!cleanLocal) {
      setLocalErr("Please select a local folder to sync.");
      ok = false;
    } else {
      const normLocal = cleanLocal.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
      const duplicateLocal = pairs.find(
        (p) => p.local.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === normLocal
      );
      if (duplicateLocal) {
        setLocalErr("This local folder is already configured in an existing sync pair.");
        ok = false;
      } else {
        const parentPair = pairs.find((p) => {
          const pNorm = p.local.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
          return normLocal.startsWith(pNorm + "/");
        });
        if (parentPair) {
          setLocalErr(
            `This folder is inside an already synced folder ("${parentPair.local}"). Nested sync pairs cause duplicate synchronization conflicts.`
          );
          ok = false;
        } else {
          const childPair = pairs.find((p) => {
            const pNorm = p.local.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
            return pNorm.startsWith(normLocal + "/");
          });
          if (childPair) {
            setLocalErr(
              `This folder contains an already synced folder ("${childPair.local}"). Nested sync pairs cause duplicate synchronization conflicts.`
            );
            ok = false;
          } else {
            setLocalErr("");
          }
        }
      }
    }

    const cleanDrive = parseDriveFolderId(driveInput);
    if (!cleanDrive) {
      setDriveErr("Please choose a Google Drive folder or provide its ID.");
      ok = false;
    } else {
      const duplicateDrive = pairs.find((p) => p.drive_folder_id.trim() === cleanDrive);
      if (duplicateDrive) {
        setDriveErr("This Google Drive folder is already linked to another sync pair.");
        ok = false;
      } else {
        setDriveErr("");
      }
    }
    return ok;
  }

  async function handlePickLocal() {
    try {
      const selected = await pickFolder();
      if (selected) {
        setLocal(selected);
        setIsEditingLocalPath(false);
        setLocalErr("");
      }
    } catch (e) {
      console.warn("Folder picker error:", e);
    }
  }

  function handleDriveFolderSelected(id: string, name?: string) {
    setDriveInput(id);
    if (name) {
      setDriveFolderName(name);
    } else if (id === "root") {
      setDriveFolderName("My Drive");
    }
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
      // Reset state for subsequent openings
      setLocal("");
      setIsEditingLocalPath(false);
      setDriveInput("");
      setDriveFolderName("");
      setMode("two_way");
      setDeletion("drive_trash");
      setShowAdvanced(false);
    } catch (e) {
      toast.error(`Failed to add folder pair: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  const localName = getLocalFolderName(local);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 animate-in fade-in duration-150" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] max-w-[95vw] max-h-[92vh] overflow-y-auto bg-[#0d1117] border border-[#30363d] rounded-xl p-6 z-[60] shadow-2xl animate-in zoom-in-95 duration-150 text-[#e6edf3]">
          {/* Header */}
          <div className="flex items-start justify-between pb-4 border-b border-[#30363d] mb-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-[#161b22] border border-[#30363d] flex items-center justify-center shrink-0 shadow-inner">
                <GithubFolderIcon size={20} className="text-[#54aeff]" />
              </div>
              <div>
                <Dialog.Title className="text-base font-semibold text-[#e6edf3] tracking-tight">
                  Add Synced Folder Pair
                </Dialog.Title>
                <Dialog.Description className="text-xs text-[#7d8590] mt-0.5">
                  Link a folder on this PC with a Google Drive directory for continuous background synchronization.
                </Dialog.Description>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-[#7d8590] hover:text-[#e6edf3] p-1.5 rounded-md hover:bg-[#21262d] transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>

          <div className="space-y-5">
            {/* ── STEP 1: Local Directory ── */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-[#1f6feb]/20 text-[#58a6ff] text-[11px] font-bold border border-[#1f6feb]/40 flex items-center justify-center shrink-0">
                    1
                  </span>
                  <label className="text-xs font-semibold text-[#e6edf3] uppercase tracking-wider">
                    Local Folder (PC)
                  </label>
                </div>
                {local && !isEditingLocalPath && (
                  <button
                    type="button"
                    onClick={() => setIsEditingLocalPath(true)}
                    className="text-[11px] text-[#7d8590] hover:text-[#58a6ff] flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <Pencil size={11} />
                    <span>Edit path text</span>
                  </button>
                )}
              </div>

              {local && !isEditingLocalPath ? (
                <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-[#161b22] border border-[#30363d] hover:border-[#484f58] transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-md bg-[#21262d] border border-[#30363d]/80 shrink-0">
                      <GithubFolderIcon size={20} className="text-[#54aeff]" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#e6edf3] truncate">
                        {localName}
                      </div>
                      <div className="text-xs font-mono text-[#7d8590] truncate" title={local}>
                        {local}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handlePickLocal}
                    className="shrink-0 h-8 px-3 bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] hover:text-white border border-[#30363d] text-xs font-medium cursor-pointer"
                  >
                    Change…
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
                      <GithubFolderIcon size={15} className="text-[#54aeff]" />
                    </div>
                    <Input
                      value={local}
                      onChange={(e) => {
                        setLocal(e.target.value);
                        if (localErr) setLocalErr("");
                      }}
                      placeholder="Click Browse or enter path (e.g. D:\Documents)"
                      className="pl-9 font-mono text-xs h-10 bg-[#161b22] border-[#30363d] text-[#e6edf3] placeholder:text-[#484f58] focus:border-[#58a6ff]"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handlePickLocal}
                    className="shrink-0 flex items-center gap-2 px-3.5 h-10 bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] hover:text-white border border-[#30363d] text-xs font-medium cursor-pointer"
                  >
                    <GithubFolderIcon size={14} className="text-[#54aeff]" />
                    <span>Browse Folder…</span>
                  </Button>
                </div>
              )}

              {localErr && (
                <p className="text-xs text-[#f85149] mt-1.5 font-medium">{localErr}</p>
              )}
            </div>

            {/* ── STEP 2: Google Drive Destination ── */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-[#1f6feb]/20 text-[#58a6ff] text-[11px] font-bold border border-[#1f6feb]/40 flex items-center justify-center shrink-0">
                    2
                  </span>
                  <label className="text-xs font-semibold text-[#e6edf3] uppercase tracking-wider flex items-center gap-1.5">
                    <img
                      src={gdLogo}
                      alt="Google Drive"
                      style={{ width: 14, height: 14, minWidth: 14, maxWidth: 14 }}
                      className="w-3.5 h-3.5 object-contain shrink-0"
                    />
                    Google Drive Destination
                  </label>
                </div>

                <div className="flex items-center gap-1 p-0.5 rounded-md bg-[#161b22] border border-[#30363d] text-xs">
                  <button
                    type="button"
                    onClick={() => setDriveSelectionMode("explorer")}
                    className={cn(
                      "px-2.5 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer",
                      driveSelectionMode === "explorer"
                        ? "bg-[#21262d] text-[#e6edf3] shadow-sm font-semibold border border-[#30363d]"
                        : "text-[#7d8590] hover:text-[#c9d1d9]"
                    )}
                  >
                    <Compass size={12} />
                    <span>Drive Browser</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDriveSelectionMode("manual")}
                    className={cn(
                      "px-2.5 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer",
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
                <div className="space-y-2">
                  <DriveFolderSelector
                    selectedFolderId={driveInput}
                    onSelect={handleDriveFolderSelected}
                  />
                  {driveInput && (
                    <div className="flex items-center justify-between text-xs px-3 py-1.5 rounded-md bg-[#161b22] border border-[#30363d]">
                      <div className="flex items-center gap-2 truncate">
                        <Check size={13} className="text-[#3fb950] shrink-0" />
                        <span className="text-[#7d8590]">Selected Drive Target:</span>
                        <span className="font-semibold text-[#e6edf3] truncate">
                          {driveFolderName || (driveInput === "root" ? "My Drive" : driveInput)}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-[#7d8590] shrink-0">
                        ID: {driveInput.length > 20 ? `${driveInput.slice(0, 16)}…` : driveInput}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
                      <Link2 size={14} className="text-[#7d8590]" />
                    </div>
                    <Input
                      value={driveInput}
                      onChange={(e) => {
                        setDriveInput(e.target.value);
                        setDriveFolderName("");
                        if (driveErr) setDriveErr("");
                      }}
                      placeholder="https://drive.google.com/drive/folders/… or direct folder ID"
                      className="pl-9 font-mono text-xs h-10 bg-[#161b22] border-[#30363d] text-[#e6edf3] placeholder:text-[#484f58] focus:border-[#58a6ff]"
                    />
                  </div>
                  <p className="text-[11px] text-[#7d8590]">
                    Paste a direct Google Drive folder URL or 33-character folder ID.
                  </p>
                </div>
              )}

              {driveErr && (
                <p className="text-xs text-[#f85149] mt-1.5 font-medium">{driveErr}</p>
              )}
            </div>

            {/* ── STEP 3: Sync Mode Selection ── */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-5 h-5 rounded-full bg-[#1f6feb]/20 text-[#58a6ff] text-[11px] font-bold border border-[#1f6feb]/40 flex items-center justify-center shrink-0">
                  3
                </span>
                <label className="text-xs font-semibold text-[#e6edf3] uppercase tracking-wider">
                  Sync Topology & Mode
                </label>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                {MODES.map((m) => {
                  const isSelected = mode === m.id;
                  const ModeIcon = m.Icon;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMode(m.id)}
                      className={cn(
                        "p-3 rounded-lg border text-left cursor-pointer transition-all duration-150 flex flex-col justify-between gap-2.5",
                        isSelected
                          ? "bg-[#1f6feb]/15 border-[#1f6feb] shadow-sm ring-1 ring-[#1f6feb]/50"
                          : "bg-[#161b22] border-[#30363d] hover:border-[#8b949e]/40 hover:bg-[#1c2128]"
                      )}
                    >
                      <div className="flex items-center justify-between w-full">
                        <div
                          className={cn(
                            "w-7 h-7 rounded-md flex items-center justify-center shrink-0",
                            isSelected ? "text-[#58a6ff] bg-[#1f6feb]/25" : "text-[#7d8590] bg-[#21262d]"
                          )}
                        >
                          <ModeIcon size={15} strokeWidth={2.2} />
                        </div>
                        {m.badge && (
                          <span
                            className={cn(
                              "text-[10px] px-1.5 py-0.5 rounded font-semibold border",
                              isSelected
                                ? "bg-[#1f6feb]/25 text-[#58a6ff] border-[#1f6feb]/50"
                                : "bg-[#21262d] text-[#7d8590] border-[#30363d]"
                            )}
                          >
                            {m.badge}
                          </span>
                        )}
                      </div>
                      <div>
                        <span className="text-xs font-semibold text-[#e6edf3] block">{m.title}</span>
                        <span className="text-[11px] text-[#7d8590] leading-snug block mt-0.5">
                          {m.desc}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Advanced Options (Collapsible) ── */}
            <div className="border border-[#30363d] rounded-lg bg-[#161b22]/40 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs text-[#7d8590] hover:text-[#c9d1d9] hover:bg-[#161b22] transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <ChevronDown
                    size={14}
                    className={cn("transition-transform duration-150", !showAdvanced && "-rotate-90")}
                  />
                  <span className="font-medium text-[#c9d1d9]">Advanced Settings</span>
                </div>
                <span className="text-[11px] text-[#7d8590]">
                  Deletion: {deletion === "drive_trash" ? "Drive Trash (30-day recovery)" : "Permanent"}
                </span>
              </button>

              {showAdvanced && (
                <div className="p-3.5 pt-2 border-t border-[#30363d] bg-[#0d1117]/60 space-y-2.5 animate-in fade-in duration-100">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <span className="text-xs font-medium text-[#e6edf3] block">
                        Remote Deletion Safety
                      </span>
                      <span className="text-[11px] text-[#7d8590] block mt-0.5">
                        {deletion === "drive_trash"
                          ? "Files deleted on PC are safely moved to Drive Trash with a 30-day recovery window."
                          : "Files deleted on PC are permanently purged from Google Drive without recovery."}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 p-0.5 rounded-md bg-[#161b22] border border-[#30363d] shrink-0">
                      <button
                        type="button"
                        onClick={() => setDeletion("drive_trash")}
                        className={cn(
                          "px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer",
                          deletion === "drive_trash"
                            ? "bg-[#1f6feb] text-white shadow-sm font-semibold"
                            : "text-[#7d8590] hover:text-[#c9d1d9]"
                        )}
                      >
                        Drive Trash
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletion("delete")}
                        className={cn(
                          "px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer",
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
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-between gap-3 mt-6 pt-4 border-t border-[#30363d]">
            <div className="text-xs text-[#7d8590] truncate">
              {local && driveInput ? (
                <span className="flex items-center gap-1.5 text-[#3fb950] font-medium">
                  <Check size={13} strokeWidth={2.5} /> Ready to link & sync
                </span>
              ) : (
                <span>Complete steps 1 and 2 to configure pair</span>
              )}
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <Button
                variant="ghost"
                onClick={onClose}
                disabled={saving}
                className="h-8 px-3.5 text-xs font-medium text-[#c9d1d9] hover:text-white hover:bg-[#21262d] cursor-pointer"
              >
                Cancel
              </Button>
              <Button
                onClick={handleAdd}
                disabled={saving || !local.trim() || !driveInput.trim()}
                className="h-8 px-4 text-xs font-semibold bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 disabled:hover:bg-[#238636] text-white rounded-md shadow-sm border border-[rgba(240,246,252,0.1)] cursor-pointer"
              >
                {saving ? "Connecting…" : "Create Pair"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
