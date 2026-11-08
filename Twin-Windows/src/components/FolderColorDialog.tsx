import React, { useState, useMemo } from "react";
import {
  Folder,
  Palette,
  Check,
  Search,
  X,
  RotateCcw,
  CheckSquare,
  Square,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { driveSetFolderColor, driveSetFoldersColor } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export interface DriveColorOption {
  hex: string;
  name: string;
}

export const GOOGLE_DRIVE_FOLDER_COLORS: DriveColorOption[] = [
  { hex: "#ac725e", name: "Chocolate" },
  { hex: "#d06b64", name: "Deep Red" },
  { hex: "#f83a22", name: "Mars Orange" },
  { hex: "#fa573c", name: "Yellow Orange" },
  { hex: "#ff7537", name: "Orange" },
  { hex: "#ffad46", name: "Macaroni" },
  { hex: "#fbe983", name: "Desert Yellow" },
  { hex: "#fad165", name: "Lemon" },
  { hex: "#b3dc6c", name: "Sage" },
  { hex: "#7bd148", name: "Olive" },
  { hex: "#16a765", name: "Sea Green" },
  { hex: "#42d692", name: "Slime Green" },
  { hex: "#92e1c0", name: "Peacock" },
  { hex: "#9fe1e7", name: "Cerulean" },
  { hex: "#9fc6e7", name: "Cobalt" },
  { hex: "#4986e7", name: "Denim Blue" },
  { hex: "#3f51b5", name: "Dark Blue" },
  { hex: "#b99aff", name: "Amethyst" },
  { hex: "#cd74e6", name: "Purple" },
  { hex: "#a479c1", name: "Lilac" },
  { hex: "#f691b2", name: "Bubblegum" },
  { hex: "#cca6ac", name: "Valentine" },
  { hex: "#c2c2c2", name: "Mouse Gray" },
  { hex: "#cabdbf", name: "Slate" },
];

export interface DriveFolderTarget {
  id: string;
  name: string;
  folderColorRgb?: string | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  // If single folder mode:
  targetFolder?: DriveFolderTarget | null;
  // If multi-folder inside parent mode:
  parentFolderName?: string;
  availableFolders?: DriveFolderTarget[];
  initialSelectedIds?: string[];
  onColorApplied?: (folderIds: string[], color: string | null) => void;
}

export function FolderColorDialog({
  isOpen,
  onClose,
  targetFolder,
  parentFolderName,
  availableFolders = [],
  initialSelectedIds = [],
  onColorApplied,
}: Props) {
  const isSingleMode = !!targetFolder;

  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(() => {
    if (targetFolder) return new Set([targetFolder.id]);
    return new Set(initialSelectedIds.length > 0 ? initialSelectedIds : availableFolders.map((f) => f.id));
  });

  const [chosenColor, setChosenColor] = useState<string | null>(() => {
    if (targetFolder) return targetFolder.folderColorRgb ?? null;
    return "#4986e7"; // Default to Google Blue
  });

  const [searchFilter, setSearchFilter] = useState("");
  const [applying, setApplying] = useState(false);

  // Sync state when props change
  React.useEffect(() => {
    if (!isOpen) return;
    if (targetFolder) {
      setSelectedFolderIds(new Set([targetFolder.id]));
      setChosenColor(targetFolder.folderColorRgb ?? null);
    } else {
      setSelectedFolderIds(
        new Set(initialSelectedIds.length > 0 ? initialSelectedIds : availableFolders.map((f) => f.id))
      );
      setChosenColor("#4986e7");
    }
    setSearchFilter("");
  }, [isOpen, targetFolder, availableFolders, initialSelectedIds]);

  const filteredFolders = useMemo(() => {
    if (!searchFilter.trim()) return availableFolders;
    const q = searchFilter.toLowerCase();
    return availableFolders.filter((f) => f.name.toLowerCase().includes(q));
  }, [availableFolders, searchFilter]);

  if (!isOpen) return null;

  const toggleFolder = (id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedFolderIds(new Set(availableFolders.map((f) => f.id)));
  };

  const deselectAll = () => {
    setSelectedFolderIds(new Set());
  };

  async function handleApply() {
    const ids = isSingleMode && targetFolder ? [targetFolder.id] : Array.from(selectedFolderIds);
    if (ids.length === 0) {
      toast.error("Please choose at least one folder to colorize");
      return;
    }

    setApplying(true);
    try {
      if (ids.length === 1) {
        await driveSetFolderColor(ids[0], chosenColor);
      } else {
        await driveSetFoldersColor(ids, chosenColor);
      }

      const colorName = chosenColor
        ? GOOGLE_DRIVE_FOLDER_COLORS.find((c) => c.hex.toLowerCase() === chosenColor.toLowerCase())?.name ?? chosenColor
        : "Default";

      toast.success(
        ids.length === 1
          ? `Folder color updated to ${colorName}`
          : `Colorized ${ids.length} folders with ${colorName}`
      );

      onColorApplied?.(ids, chosenColor);
      onClose();
    } catch (e) {
      toast.error(`Failed to update folder color: ${String(e)}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="desktop-card w-full max-w-lg overflow-hidden border border-[var(--border)] shadow-2xl flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="p-4 px-5 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface-2)]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400">
              <Palette size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">
                {isSingleMode
                  ? `Colorize Folder: ${targetFolder?.name}`
                  : `Colorize Folders in ${parentFolderName || "Current Folder"}`}
              </h2>
              <p className="text-[11px] text-[var(--text-muted)]">
                {isSingleMode
                  ? "Choose an accent color for this Google Drive folder."
                  : "Choose which folders inside to colorize and select an accent color."}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface)] transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content body */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Subfolder Checklist (Multi-folder mode) */}
          {!isSingleMode && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white">
                  Choose Folders ({selectedFolderIds.size}/{availableFolders.length})
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-[11px] text-blue-400 hover:text-blue-300 font-medium cursor-pointer"
                  >
                    Select All
                  </button>
                  <span className="text-[var(--text-subtle)]">•</span>
                  <button
                    type="button"
                    onClick={deselectAll}
                    className="text-[11px] text-[var(--text-muted)] hover:text-white font-medium cursor-pointer"
                  >
                    Deselect All
                  </button>
                </div>
              </div>

              {availableFolders.length > 6 && (
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-2.5 text-[var(--text-subtle)]" />
                  <Input
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    placeholder="Filter subfolders…"
                    className="pl-8 text-xs h-8"
                  />
                </div>
              )}

              <div className="border border-[var(--border)] rounded-lg bg-[var(--surface-2)]/50 divide-y divide-[var(--border-subtle)] max-h-48 overflow-y-auto">
                {filteredFolders.length === 0 ? (
                  <div className="p-4 text-center text-xs text-[var(--text-muted)]">
                    No folders match filter
                  </div>
                ) : (
                  filteredFolders.map((f) => {
                    const isChecked = selectedFolderIds.has(f.id);
                    const folderColor = f.folderColorRgb;
                    return (
                      <div
                        key={f.id}
                        onClick={() => toggleFolder(f.id)}
                        className={cn(
                          "flex items-center justify-between px-3 py-2 text-xs cursor-pointer hover:bg-[var(--surface-2)] transition-colors select-none",
                          isChecked ? "bg-blue-600/10" : ""
                        )}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {isChecked ? (
                            <CheckSquare size={15} className="text-blue-400 shrink-0" />
                          ) : (
                            <Square size={15} className="text-[var(--text-subtle)] shrink-0" />
                          )}
                          <Folder
                            size={15}
                            style={{ color: folderColor || "#eab308" }}
                            className="shrink-0"
                          />
                          <span className="truncate text-white font-medium">{f.name}</span>
                        </div>
                        {folderColor && (
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0 border border-white/20"
                            style={{ backgroundColor: folderColor }}
                            title={`Current color: ${folderColor}`}
                          />
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Color Palette Selector */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-white">Choose Color</span>
              {chosenColor ? (
                <span className="text-[11px] text-blue-400 font-medium flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-full inline-block border border-white/20"
                    style={{ backgroundColor: chosenColor }}
                  />
                  {GOOGLE_DRIVE_FOLDER_COLORS.find((c) => c.hex.toLowerCase() === chosenColor.toLowerCase())?.name ??
                    chosenColor}
                </span>
              ) : (
                <span className="text-[11px] text-[var(--text-muted)]">Default Gray</span>
              )}
            </div>

            {/* 24 Google Drive Colors Grid */}
            <div className="grid grid-cols-8 gap-2 p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
              {GOOGLE_DRIVE_FOLDER_COLORS.map((col) => {
                const isSelected = chosenColor?.toLowerCase() === col.hex.toLowerCase();
                return (
                  <button
                    key={col.hex}
                    type="button"
                    onClick={() => setChosenColor(col.hex)}
                    title={col.name}
                    className={cn(
                      "w-7 h-7 rounded-md transition-transform duration-100 flex items-center justify-center cursor-pointer shadow-sm relative group hover:scale-110",
                      isSelected ? "ring-2 ring-white ring-offset-2 ring-offset-[var(--surface)] scale-105" : ""
                    )}
                    style={{ backgroundColor: col.hex }}
                  >
                    {isSelected && <Check size={14} className="text-white drop-shadow-md stroke-[2.5]" />}
                  </button>
                );
              })}
            </div>

            {/* Clear / Reset to Default option */}
            <button
              type="button"
              onClick={() => setChosenColor(null)}
              className={cn(
                "w-full px-3 py-2 rounded-md text-xs font-medium border flex items-center justify-center gap-2 transition-colors cursor-pointer",
                chosenColor === null
                  ? "bg-white/10 border-white/30 text-white font-semibold"
                  : "bg-[var(--surface-2)]/60 border-[var(--border)] text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)]"
              )}
            >
              <RotateCcw size={13} />
              Reset to Default Drive Gray (Clear Color)
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 px-5 border-t border-[var(--border)] bg-[var(--surface-2)] flex items-center justify-between">
          <Button variant="secondary" onClick={onClose} disabled={applying}>
            Cancel
          </Button>

          <Button
            onClick={handleApply}
            disabled={applying || (!isSingleMode && selectedFolderIds.size === 0)}
            className="flex items-center gap-2"
          >
            {applying ? (
              <>
                <RefreshCw size={13} className="animate-spin" />
                Applying…
              </>
            ) : (
              <>
                <Palette size={13} />
                {isSingleMode
                  ? "Apply Color"
                  : `Apply to ${selectedFolderIds.size} ${selectedFolderIds.size === 1 ? "Folder" : "Folders"}`}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

