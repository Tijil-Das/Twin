/**
 * Add Synced Folder Pair Dialog
 * Desktop modal for selecting local directories, traversing Google Drive
 * folder hierarchies, and choosing sync topologies.
 */
import { useState, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeftRight,
  CloudUpload,
  FlipHorizontal2,
  X,
  Link2,
  Pencil,
  Check,
  CheckCircle2,
  Info,
  Compass,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/store";
import { addPair, pickFolder, getConfig, updateConfig } from "@/lib/tauri";
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

function normalizePath(p: string): string {
  return p.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function getRelativeSubfolder(parentPath: string, childPath: string): string {
  const normParent = normalizePath(parentPath);
  const normChild = normalizePath(childPath);
  if (normChild.startsWith(normParent + "/")) {
    const trimmedChild = childPath.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
    return trimmedChild.slice(normParent.length + 1);
  }
  return "";
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
  const [deletion, setDeletion] = useState<"drive_trash" | "delete">("delete");
  const [saving, setSaving] = useState(false);
  const [localErr, setLocalErr] = useState("");
  const [driveErr, setDriveErr] = useState("");

  const cleanDriveId = parseDriveFolderId(driveInput);

  // Dynamic analysis of relationships with existing pairs
  const smartAnalysis = useMemo(() => {
    const cleanLocal = local.trim();
    if (!cleanLocal) return null;
    const normLocal = normalizePath(cleanLocal);

    // Exact duplicate?
    if (cleanDriveId) {
      const exactMatch = pairs.find(
        (p) => normalizePath(p.local) === normLocal && p.drive_folder_id.trim() === cleanDriveId
      );
      if (exactMatch) {
        return { type: "exact_duplicate" as const, pair: exactMatch };
      }
    }

    // Nested: child of existing pair
    const parentPair = pairs.find((p) => {
      const pNorm = normalizePath(p.local);
      return normLocal.startsWith(pNorm + "/");
    });
    if (parentPair) {
      const subfolder = getRelativeSubfolder(parentPair.local, cleanLocal);
      return { type: "child_of_existing" as const, pair: parentPair, subfolder };
    }

    // Nested: parent of existing pair(s)
    const childPairs = pairs.filter((p) => {
      const pNorm = normalizePath(p.local);
      return pNorm.startsWith(normLocal + "/");
    });
    if (childPairs.length > 0) {
      return { type: "parent_of_existing" as const, childPairs };
    }

    // Same local folder, different Drive folder
    const sameLocal = pairs.find((p) => normalizePath(p.local) === normLocal);
    if (sameLocal) {
      return { type: "same_local" as const, pair: sameLocal };
    }

    // Same Drive folder, different local folder
    if (cleanDriveId) {
      const sameDrive = pairs.find((p) => p.drive_folder_id.trim() === cleanDriveId);
      if (sameDrive) {
        return { type: "same_drive" as const, pair: sameDrive };
      }
    }

    return null;
  }, [local, cleanDriveId, pairs]);

  function validate(): boolean {
    let ok = true;
    const cleanLocal = local.trim();
    if (!cleanLocal) {
      setLocalErr("Please select a local folder to sync.");
      ok = false;
    } else {
      setLocalErr("");
    }

    if (!cleanDriveId) {
      setDriveErr("Please choose a Google Drive folder or provide its ID.");
      ok = false;
    } else {
      setDriveErr("");
    }

    if (!ok) return false;

    // Only block if this is an exact duplicate pair (same local folder AND same Google Drive folder)
    const normLocal = normalizePath(cleanLocal);
    const exactMatch = pairs.find(
      (p) => normalizePath(p.local) === normLocal && p.drive_folder_id.trim() === cleanDriveId
    );
    if (exactMatch) {
      setDriveErr("This exact local folder and Google Drive destination pair is already configured.");
      return false;
    }

    return true;
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
      const cleanLocal = local.trim();
      const normLocal = normalizePath(cleanLocal);
      const cleanDrive = cleanDriveId;

      // 1. If this new folder contains existing child pairs, exclude them from the new parent pair
      const childPairs = pairs.filter((p) => {
        const pNorm = normalizePath(p.local);
        return pNorm.startsWith(normLocal + "/");
      });
      const childExcludedSubfolders = childPairs
        .map((cp) => getRelativeSubfolder(cleanLocal, cp.local))
        .filter(Boolean);

      // 2. If this new folder is inside an existing parent pair, auto-exclude it from the parent pair
      const parentPair = pairs.find((p) => {
        const pNorm = normalizePath(p.local);
        return normLocal.startsWith(pNorm + "/");
      });

      if (parentPair) {
        const subfolderRel = getRelativeSubfolder(parentPair.local, cleanLocal);
        if (subfolderRel) {
          try {
            const currentCfg = await getConfig();
            const currentPairs = Array.isArray(currentCfg.pairs)
              ? currentCfg.pairs
              : Array.isArray((currentCfg as any).pair)
              ? (currentCfg as any).pair
              : [];
            const nextPairs = currentPairs.map((p: PairEntry) => {
              if (p.id === parentPair.id) {
                const currentEx = p.excluded_folders ?? [];
                if (!currentEx.some((x) => normalizePath(x) === normalizePath(subfolderRel))) {
                  return {
                    ...p,
                    excluded_folders: [...currentEx, subfolderRel],
                  };
                }
              }
              return p;
            });
            await updateConfig({ ...currentCfg, pairs: nextPairs, pair: nextPairs });
          } catch (err) {
            console.warn("Could not auto-update parent pair exclusion:", err);
          }
        }
      }

      const pair: PairEntry = {
        id: crypto.randomUUID(),
        local: cleanLocal,
        drive_folder_id: cleanDrive,
        mode,
        enabled: true,
        deletion,
        excluded_folders: childExcludedSubfolders.length > 0 ? childExcludedSubfolders : undefined,
      };

      await addPair(pair);

      if (parentPair) {
        toast.success(`Pair configured. Subfolder isolated from "${getLocalFolderName(parentPair.local)}".`);
      } else if (childPairs.length > 0) {
        toast.success(`Pair configured. Isolated existing subfolder pair${childPairs.length > 1 ? "s" : ""}.`);
      } else if (smartAnalysis?.type === "same_local") {
        toast.success("Multi-destination pair configured successfully");
      } else if (smartAnalysis?.type === "same_drive") {
        toast.success("Multi-location replica pair configured successfully");
      } else {
        toast.success("Folder pair configured successfully");
      }

      onAdded();
      onClose();
      // Reset state for subsequent openings
      setLocal("");
      setIsEditingLocalPath(false);
      setDriveInput("");
      setDriveFolderName("");
      setMode("two_way");
      setDeletion("delete");
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

              {/* Smart feedback when local folder relates to an existing pair */}
              {!localErr && smartAnalysis?.type === "child_of_existing" && (
                <div className="flex items-start gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 p-2.5 rounded-lg mt-2">
                  <CheckCircle2 size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-emerald-400">Smart Subfolder Isolation:</span>
                    <span className="text-[#c9d1d9] ml-1">
                      Subfolder &ldquo;{smartAnalysis.subfolder}&rdquo; will be automatically excluded from &ldquo;{getLocalFolderName(smartAnalysis.pair.local)}&rdquo; to prevent duplicate sync conflicts.
                    </span>
                  </div>
                </div>
              )}

              {!localErr && smartAnalysis?.type === "parent_of_existing" && (
                <div className="flex items-start gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 p-2.5 rounded-lg mt-2">
                  <CheckCircle2 size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-emerald-400">Smart Subfolder Isolation:</span>
                    <span className="text-[#c9d1d9] ml-1">
                      {smartAnalysis.childPairs.length === 1
                        ? `Existing pair subfolder "${getLocalFolderName(smartAnalysis.childPairs[0].local)}" will be automatically excluded from this new pair.`
                        : `${smartAnalysis.childPairs.length} existing pair subfolders will be automatically excluded from this new pair.`}
                    </span>
                  </div>
                </div>
              )}

              {!localErr && smartAnalysis?.type === "same_local" && (
                <div className="flex items-start gap-2 text-xs text-[#58a6ff] bg-[#1f6feb]/10 border border-[#1f6feb]/25 p-2.5 rounded-lg mt-2">
                  <Info size={14} className="text-[#58a6ff] shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-[#58a6ff]">Multi-Destination Sync:</span>
                    <span className="text-[#c9d1d9] ml-1">
                      This local folder is already linked to another Drive destination. It will sync to this additional destination independently.
                    </span>
                  </div>
                </div>
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

              {!driveErr && smartAnalysis?.type === "same_drive" && (
                <div className="flex items-start gap-2 text-xs text-[#58a6ff] bg-[#1f6feb]/10 border border-[#1f6feb]/25 p-2.5 rounded-lg mt-2">
                  <Info size={14} className="text-[#58a6ff] shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-[#58a6ff]">Multi-Location Sync:</span>
                    <span className="text-[#c9d1d9] ml-1">
                      This Drive folder is already linked to local folder &ldquo;{getLocalFolderName(smartAnalysis.pair.local)}&rdquo;. It will sync to this additional local folder independently.
                    </span>
                  </div>
                </div>
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

            {/* ── Remote Deletion Safety Option ── */}
            <div className="p-3.5 rounded-lg border border-[#30363d] bg-[#161b22]/40">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-xs font-semibold text-[#e6edf3] block">
                    Remote Deletion Safety
                  </span>
                  <span className="text-[11px] text-[#7d8590] block mt-0.5">
                    {deletion === "delete"
                      ? "Files deleted on PC are permanently purged from Google Drive without recovery."
                      : "Files deleted on PC are safely moved to Drive Trash with a 30-day recovery window."}
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
