/**
 * Drive Explorer & Version Restore Screen
 * Native remote Google Drive browser, multi-version history inspector,
 * and trash recovery ledger.
 */
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  driveList,
  listRevisions,
  restoreFileCmd,
  listTrash,
  untrash,
  untrashAll,
  keepRevision,
  type DriveFile,
  type Revision,
  type TrashedFile,
} from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  Folder,
  FileText,
  ChevronRight,
  Search,
  Star,
  Share2,
  HardDrive,
  Clock,
  RotateCcw,
  Trash2,
  Download,
  RefreshCw,
  X,
  FileCode,
  FileSpreadsheet,
  Image as ImageIcon,
  Lock,
  Palette,
  CheckSquare,
  Square,
} from "lucide-react";
import {
  FolderColorDialog,
  type DriveFolderTarget,
} from "@/components/FolderColorDialog";
import { formatBytes, formatRelTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tab = "files" | "trash";

interface ExtendedDriveFile extends DriveFile {
  description?: string | null;
  starred?: boolean | null;
}

interface SharedDrive {
  id: string;
  name: string;
}

function getFileIcon(mime?: string | null) {
  if (!mime) return FileText;
  if (mime.includes("folder")) return Folder;
  if (mime.includes("image")) return ImageIcon;
  if (mime.includes("sheet") || mime.includes("excel") || mime.includes("csv"))
    return FileSpreadsheet;
  if (mime.includes("json") || mime.includes("javascript") || mime.includes("typescript"))
    return FileCode;
  return FileText;
}

export function RestoreScreen() {
  const [tab, setTab] = useState<Tab>("files");

  return (
    <div className="p-7 max-w-5xl w-full mx-auto space-y-6">
      {/* Header & Mode Switcher */}
      <div className="flex items-center justify-between pb-3.5 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-white">
            Drive Explorer & Restore
          </h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Browse remote Google Drive files, inspect multi-version history, and restore data.
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[var(--surface-2)] border border-[var(--border)]">
          <button
            onClick={() => setTab("files")}
            className={cn(
              "px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-2",
              tab === "files"
                ? "bg-[var(--surface)] text-white shadow-sm border border-white/5"
                : "text-[var(--text-muted)] hover:text-white"
            )}
          >
            <Folder size={14} className={tab === "files" ? "text-blue-400" : "text-[var(--text-subtle)]"} />
            Drive Files
          </button>
          <button
            onClick={() => setTab("trash")}
            className={cn(
              "px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-2",
              tab === "trash"
                ? "bg-[var(--surface)] text-white shadow-sm border border-white/5"
                : "text-[var(--text-muted)] hover:text-white"
            )}
          >
            <Trash2 size={14} className={tab === "trash" ? "text-red-400" : "text-[var(--text-subtle)]"} />
            Trash
          </button>
        </div>
      </div>

      {tab === "files" ? <FileBrowser /> : <TrashBrowser />}
    </div>
  );
}

// ── File browser ──────────────────────────────────────────────────────────────

function FileBrowser() {
  const [rootId, setRootId] = useState("");
  const [rootInput, setRootInput] = useState("");
  const [files, setFiles] = useState<ExtendedDriveFile[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<ExtendedDriveFile | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revLoading, setRevLoading] = useState(false);
  const [dest, setDest] = useState("");
  const [restoreProgress, setRestoreProgress] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const [sharedDrives, setSharedDrives] = useState<SharedDrive[]>([]);
  const [selectedDrive, setSelectedDrive] = useState("root");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [descInput, setDescInput] = useState("");

  // Color dialog & folder selection state
  const [colorDialogOpen, setColorDialogOpen] = useState(false);
  const [colorDialogTarget, setColorDialogTarget] = useState<DriveFolderTarget | null>(null);
  const [colorDialogInitialIds, setColorDialogInitialIds] = useState<string[]>([]);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    invoke<SharedDrive[]>("list_shared_drives")
      .then((d) => setSharedDrives(d))
      .catch(() => {});
  }, []);

  async function loadFolder(folderId: string, name = "Root") {
    setLoading(true);
    setIsSearching(false);
    setSelectedFolderIds(new Set());
    try {
      const result = await driveList(folderId);
      setFiles(result as ExtendedDriveFile[]);
      setRootId(folderId);
      setBreadcrumb((bc) => {
        const idx = bc.findIndex((b) => b.id === folderId);
        if (idx >= 0) return bc.slice(0, idx + 1);
        return [...bc, { id: folderId, name }];
      });
    } catch (e) {
      toast.error(`Failed to list folder: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  function openSingleFolderColor(target: DriveFolderTarget) {
    setColorDialogTarget(target);
    setColorDialogInitialIds([target.id]);
    setColorDialogOpen(true);
  }

  function openMultiFolderColor(initialIds?: string[]) {
    setColorDialogTarget(null);
    setColorDialogInitialIds(
      initialIds && initialIds.length > 0 ? initialIds : folders.map((f) => f.id)
    );
    setColorDialogOpen(true);
  }

  function toggleSelectFolder(id: string) {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleColorApplied(ids: string[], color: string | null) {
    setFiles((prev) =>
      prev.map((f) =>
        ids.includes(f.id)
          ? { ...f, folderColorRgb: color, folder_color_rgb: color }
          : f
      )
    );
    setSelectedFolderIds(new Set());
  }

  async function handleBrowse() {
    const id = rootInput.trim();
    if (!id) return;
    setBreadcrumb([]);
    await loadFolder(id, "Root");
  }

  async function handleDriveChange(driveId: string) {
    setSelectedDrive(driveId);
    setBreadcrumb([]);
    const name =
      driveId === "root"
        ? "My Drive"
        : sharedDrives.find((d) => d.id === driveId)?.name ?? "Shared Drive";
    await loadFolder(driveId, name);
  }

  async function handleSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    setLoading(true);
    setIsSearching(true);
    try {
      const results = await invoke<ExtendedDriveFile[]>("drive_search", { query: q });
      setFiles(results);
    } catch (e) {
      toast.error(`Search error: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  function handleClearSearch() {
    setSearchQuery("");
    setIsSearching(false);
    void loadFolder(rootId || "root", selectedDrive === "root" ? "My Drive" : "Shared Drive");
  }

  async function handleSelect(file: ExtendedDriveFile) {
    const isFolder = file.mime_type === "application/vnd.google-apps.folder";
    if (isFolder) {
      await loadFolder(file.id, file.name ?? file.id);
      return;
    }
    setSelected(file);
    setDescInput(file.description ?? "");
    setRevLoading(true);
    try {
      const revs = await listRevisions(file.id);
      setRevisions(revs);
    } catch (e) {
      toast.error(`Failed to load revisions: ${String(e)}`);
    } finally {
      setRevLoading(false);
    }
  }

  async function handleShareLink() {
    if (!selected) return;
    try {
      const link = await invoke<string>("drive_share_link", {
        fileId: selected.id,
        role: "reader",
        anyone: true,
      });
      await navigator.clipboard.writeText(link);
      toast.success("Share link copied to clipboard");
    } catch (e) {
      toast.error(`Share link error: ${String(e)}`);
    }
  }

  async function handleToggleStar() {
    if (!selected) return;
    const newStar = !(selected.starred ?? false);
    try {
      await invoke("set_starred", { fileId: selected.id, starred: newStar });
      setSelected({ ...selected, starred: newStar });
      setFiles((prev) =>
        prev.map((f) => (f.id === selected.id ? { ...f, starred: newStar } : f))
      );
    } catch (e) {
      toast.error(`Star update failed: ${String(e)}`);
    }
  }

  async function handleSaveDescription() {
    if (!selected) return;
    try {
      await invoke("set_description", { fileId: selected.id, text: descInput.trim() });
      setSelected({ ...selected, description: descInput.trim() });
      setFiles((prev) =>
        prev.map((f) => (f.id === selected.id ? { ...f, description: descInput.trim() } : f))
      );
      toast.success("Description updated");
    } catch (e) {
      toast.error(`Save description error: ${String(e)}`);
    }
  }

  async function handleRestore(file: DriveFile, revId: string | null) {
    const target = dest.trim() || file.name || "restored_file";
    setRestoreProgress(0);
    try {
      await restoreFileCmd(file.id, revId, target);
      setRestoreProgress(100);
      toast.success(`Restored to ${target}`);
      setTimeout(() => setRestoreProgress(null), 2000);
    } catch (e) {
      toast.error(`Restore failed: ${String(e)}`);
      setRestoreProgress(null);
    }
  }

  async function handleKeepForever(fileId: string, revId: string, keep: boolean) {
    try {
      await keepRevision(fileId, revId, keep);
      if (selected) {
        const revs = await listRevisions(fileId);
        setRevisions(revs);
      }
      toast.info(keep ? "Revision locked forever" : "Revision retention unlocked");
    } catch (e) {
      toast.error(`Revision update failed: ${String(e)}`);
    }
  }

  const folders = files.filter((f) => f.mime_type === "application/vnd.google-apps.folder");
  const items = files.filter((f) => f.mime_type !== "application/vnd.google-apps.folder");

  return (
    <div className="flex gap-5 items-start">
      {/* Main File Browser */}
      <div className="flex-1 min-w-0 space-y-3.5">
        {/* Drive Selector & Search bar */}
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] shrink-0">
            <HardDrive size={15} className="text-blue-400" />
            <select
              value={selectedDrive}
              onChange={(e) => void handleDriveChange(e.target.value)}
              className="text-xs bg-transparent border-none text-[var(--text)] focus:outline-none cursor-pointer pr-1 font-semibold"
            >
              <option value="root" className="bg-[var(--surface-2)]">My Drive</option>
              {sharedDrives.map((d) => (
                <option key={d.id} value={d.id} className="bg-[var(--surface-2)]">
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 flex-1">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-2.5 text-[var(--text-subtle)]" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files in Google Drive…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                }}
                className="pl-9 text-xs h-9"
              />
              {searchQuery && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-2.5 top-2.5 text-[var(--text-subtle)] hover:text-white p-0.5"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <Button
              variant="secondary"
              onClick={() => void handleSearch()}
            >
              Search
            </Button>
            {folders.length > 0 && (
              <Button
                variant="secondary"
                onClick={() =>
                  openMultiFolderColor(
                    selectedFolderIds.size > 0 ? Array.from(selectedFolderIds) : undefined
                  )
                }
                className="flex items-center gap-1.5 text-xs h-9 shrink-0"
                title="Choose which folders inside this folder to colorize"
              >
                <Palette size={13} className="text-amber-400" />
                <span className="hidden sm:inline">Colorize Folders ({folders.length})</span>
                <span className="sm:hidden">Color ({folders.length})</span>
              </Button>
            )}
          </div>
        </div>

        {/* Fallback Root ID input if no drive loaded */}
        {!rootId && (
          <div className="desktop-card p-4.5 flex items-center gap-3">
            <Input
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="Paste Google Drive Folder ID directly, or choose My Drive above"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleBrowse();
              }}
              className="text-xs code-text h-9 flex-1"
            />
            <Button onClick={() => void handleBrowse()}>
              Open
            </Button>
          </div>
        )}

        {/* Breadcrumb address path */}
        {breadcrumb.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-1 py-1">
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] overflow-x-auto min-w-0">
              {breadcrumb.map((bc, i) => (
                <span key={bc.id} className="flex items-center gap-1.5 shrink-0">
                  {i > 0 && <ChevronRight size={13} className="text-[var(--text-subtle)]" />}
                  <button
                    onClick={() => void loadFolder(bc.id, bc.name)}
                    className={cn(
                      "hover:text-blue-400 transition-colors px-2 py-0.5 rounded cursor-pointer",
                      i === breadcrumb.length - 1
                        ? "font-bold text-white bg-[var(--surface-2)]"
                        : "text-[var(--text-muted)] font-medium"
                    )}
                  >
                    {bc.name}
                  </button>
                </span>
              ))}
            </div>

            {/* Current Folder Colorizer Button */}
            {breadcrumb.length > 0 && breadcrumb[breadcrumb.length - 1].id !== "root" && (
              <button
                type="button"
                onClick={() =>
                  openSingleFolderColor({
                    id: breadcrumb[breadcrumb.length - 1].id,
                    name: breadcrumb[breadcrumb.length - 1].name,
                  })
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--text-muted)] hover:text-white bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] transition-colors cursor-pointer shrink-0"
                title={`Colorize "${breadcrumb[breadcrumb.length - 1].name}" folder`}
              >
                <Palette size={12} className="text-blue-400" />
                <span>Color This Folder</span>
              </button>
            )}
          </div>
        )}

        {/* Multi-selection Banner */}
        {selectedFolderIds.size > 0 && (
          <div className="flex items-center justify-between p-2.5 px-4 bg-blue-500/10 border border-blue-500/20 rounded-xl text-xs animate-in fade-in duration-100">
            <div className="flex items-center gap-2">
              <span className="text-blue-300 font-semibold">
                {selectedFolderIds.size} of {folders.length} {selectedFolderIds.size === 1 ? "folder" : "folders"} selected
              </span>
              <button
                type="button"
                onClick={() => setSelectedFolderIds(new Set())}
                className="text-[11px] text-[var(--text-muted)] hover:text-white underline cursor-pointer"
              >
                Deselect
              </button>
            </div>
            <Button
              size="sm"
              onClick={() => openMultiFolderColor(Array.from(selectedFolderIds))}
              className="h-7 text-xs flex items-center gap-1.5"
            >
              <Palette size={12} />
              Colorize Selected ({selectedFolderIds.size})
            </Button>
          </div>
        )}

        {/* File Browser List */}
        {loading ? (
          <div className="desktop-card p-14 text-center text-[var(--text-muted)] text-xs flex items-center justify-center gap-2">
            <RefreshCw size={15} className="animate-spin text-blue-400" />
            Loading folder contents…
          </div>
        ) : rootId && files.length === 0 ? (
          <div className="desktop-card p-12 text-center text-[var(--text-muted)] text-xs border-dashed">
            This Google Drive folder is empty.
          </div>
        ) : (
          <div className="desktop-card overflow-hidden">
            <div className="divide-y divide-[var(--border-subtle)] max-h-[540px] overflow-y-auto">
              {[...folders, ...items].map((file) => {
                const isFolder = file.mime_type === "application/vnd.google-apps.folder";
                const isSelected = selected?.id === file.id;
                const folderColor = file.folderColorRgb ?? file.folder_color_rgb;
                const isFolderSelected = selectedFolderIds.has(file.id);
                const FileIconComp = getFileIcon(file.mime_type);

                return (
                  <div
                    key={file.id}
                    onClick={() => void handleSelect(file)}
                    className={cn(
                      "group flex items-center justify-between px-4 py-3 cursor-pointer text-xs transition-colors",
                      isSelected
                        ? "bg-blue-600/15 text-blue-300 font-semibold"
                        : "hover:bg-[var(--surface-2)] text-[var(--text)] font-medium"
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {isFolder && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelectFolder(file.id);
                          }}
                          className="p-0.5 text-[var(--text-subtle)] hover:text-white cursor-pointer shrink-0"
                          title={isFolderSelected ? "Deselect folder" : "Select folder"}
                        >
                          {isFolderSelected ? (
                            <CheckSquare size={14} className="text-blue-400" />
                          ) : (
                            <Square size={14} className="text-[var(--text-subtle)]" />
                          )}
                        </button>
                      )}

                      <FileIconComp
                        size={17}
                        style={isFolder && folderColor ? { color: folderColor } : undefined}
                        className={cn(
                          "shrink-0",
                          isFolder && !folderColor ? "text-amber-400" : !isFolder ? "text-blue-400" : ""
                        )}
                      />

                      <span className="truncate code-text text-xs" title={file.name ?? file.id}>
                        {file.name ?? file.id}
                      </span>

                      {isFolder && folderColor && (
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0 border border-white/20 shadow-sm"
                          style={{ backgroundColor: folderColor }}
                          title={`Folder color: ${folderColor}`}
                        />
                      )}

                      {file.starred && (
                        <Star size={13} className="fill-amber-400 text-amber-400 shrink-0" />
                      )}
                    </div>

                    <div className="flex items-center gap-3 shrink-0 text-xs code-text text-[var(--text-subtle)]">
                      {isFolder && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openSingleFolderColor({
                              id: file.id,
                              name: file.name ?? file.id,
                              folderColorRgb: folderColor,
                            });
                          }}
                          title={`Colorize "${file.name ?? file.id}"`}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-3)] transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Palette size={13} />
                          <span className="text-[11px] font-sans">Color</span>
                        </button>
                      )}
                      {file.size && <span>{formatBytes(parseInt(file.size, 10))}</span>}
                      {isFolder && <span className="text-[11px] text-[var(--text-subtle)] uppercase">Folder</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Side Inspector (Revisions & File Details) */}
      {selected && (
        <aside className="w-84 shrink-0 space-y-4">
          <div className="desktop-card p-4.5 space-y-3.5">
            <div className="flex items-start justify-between gap-2.5">
              <div className="min-w-0">
                <p className="font-bold text-sm text-white break-all leading-tight">
                  {selected.name}
                </p>
                {selected.size && (
                  <p className="text-xs code-text text-[var(--text-subtle)] mt-1">
                    {formatBytes(parseInt(selected.size, 10))}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="iconSm"
                onClick={handleToggleStar}
                title={selected.starred ? "Unstar" : "Star"}
              >
                <Star
                  size={15}
                  className={cn(
                    selected.starred ? "fill-amber-400 text-amber-400" : "text-[var(--text-subtle)]"
                  )}
                />
              </Button>
            </div>

            {/* Description Notes */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-[var(--text-subtle)] uppercase tracking-wider">
                Drive Note
              </label>
              <div className="flex gap-2">
                <Input
                  value={descInput}
                  onChange={(e) => setDescInput(e.target.value)}
                  placeholder="Add note…"
                  className="text-xs h-8"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSaveDescription}
                  className="h-8 text-xs px-3"
                >
                  Save
                </Button>
              </div>
            </div>

            {/* Share link button */}
            <Button
              variant="secondary"
              onClick={handleShareLink}
              className="w-full flex items-center justify-center gap-2 text-xs"
            >
              <Share2 size={14} />
              Copy Google Share Link
            </Button>

            {/* Restore target input */}
            <div className="pt-3.5 border-t border-[var(--border-subtle)] space-y-2.5">
              <label className="text-[11px] font-semibold text-[var(--text-subtle)] uppercase tracking-wider">
                Restore Destination
              </label>
              <Input
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder={selected.name ?? "Target path…"}
                className="text-xs code-text h-8"
              />
              <Button
                onClick={() => void handleRestore(selected, null)}
                className="w-full flex items-center justify-center gap-2"
              >
                <Download size={15} />
                Restore Latest Version
              </Button>

              {restoreProgress !== null && (
                <div className="mt-2">
                  <Progress value={restoreProgress} aria-label="Restore progress" className="h-2" />
                </div>
              )}
            </div>
          </div>

          {/* Revisions History Drawer */}
          <div className="desktop-card overflow-hidden">
            <div className="px-4 py-3 bg-[var(--surface-2)]/60 border-b border-[var(--border)] flex items-center gap-2">
              <Clock size={14} className="text-blue-400" />
              <span className="text-xs font-bold text-white">
                Version History ({revisions.length})
              </span>
            </div>

            <div className="divide-y divide-[var(--border-subtle)] max-h-64 overflow-y-auto">
              {revLoading ? (
                <div className="p-4.5 text-center text-[var(--text-muted)] text-xs">
                  Loading history…
                </div>
              ) : revisions.length === 0 ? (
                <div className="p-4.5 text-center text-[var(--text-subtle)] text-xs">
                  Single version recorded.
                </div>
              ) : (
                revisions.map((rev) => (
                  <div key={rev.id} className="p-3.5 text-xs space-y-2">
                    <div className="flex items-center justify-between code-text text-xs">
                      <span className="text-[var(--text)] font-medium">
                        {rev.modified_time
                          ? formatRelTime(new Date(rev.modified_time).getTime())
                          : "Unknown"}
                      </span>
                      {rev.size && (
                        <span className="text-[var(--text-subtle)]">
                          {formatBytes(parseInt(rev.size, 10))}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <label className="text-xs text-[var(--text-muted)] flex items-center gap-2 cursor-pointer font-medium">
                        <Switch
                          checked={rev.keep_forever ?? false}
                          onCheckedChange={(v) =>
                            void handleKeepForever(selected.id, rev.id, v)
                          }
                        />
                        <span className="flex items-center gap-1">
                          <Lock size={12} className="text-[var(--text-subtle)]" />
                          Lock
                        </span>
                      </label>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void handleRestore(selected, rev.id)}
                        className="text-blue-400 hover:text-blue-300 font-semibold"
                      >
                        Restore
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      )}

      {/* Colorize Google Drive Folders Dialog */}
      <FolderColorDialog
        isOpen={colorDialogOpen}
        onClose={() => setColorDialogOpen(false)}
        targetFolder={colorDialogTarget}
        parentFolderName={breadcrumb[breadcrumb.length - 1]?.name || "Current Folder"}
        availableFolders={folders.map((f) => ({
          id: f.id,
          name: f.name ?? f.id,
          folderColorRgb: f.folderColorRgb ?? f.folder_color_rgb ?? null,
        }))}
        initialSelectedIds={colorDialogInitialIds}
        onColorApplied={handleColorApplied}
      />
    </div>
  );
}

// ── Trash browser ─────────────────────────────────────────────────────────────

function TrashBrowser() {
  const [items, setItems] = useState<TrashedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringAll, setRestoringAll] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const data = await listTrash();
        setItems(data);
      } catch (e) {
        toast.error(`Failed to load trash: ${String(e)}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleUntrash(fileId: string) {
    try {
      await untrash(fileId);
      setItems((prev) => prev.filter((f) => f.id !== fileId));
      toast.success("File restored from Drive trash");
    } catch (e) {
      toast.error(`Failed to restore: ${String(e)}`);
    }
  }

  async function handleUntrashAll() {
    if (items.length === 0 || restoringAll) return;
    setRestoringAll(true);
    try {
      try {
        const count = await untrashAll();
        setItems([]);
        toast.success(`Successfully restored ${count} file(s) from Drive trash!`);
        return;
      } catch (err) {
        console.warn("untrashAll fallback to single items:", err);
      }

      let count = 0;
      for (const item of items) {
        try {
          await untrash(item.id);
          count++;
        } catch {
          // ignore
        }
      }
      setItems([]);
      toast.success(`Successfully restored ${count} file(s) from Drive trash!`);
    } catch (e) {
      toast.error(`Failed to restore: ${String(e)}`);
    } finally {
      setRestoringAll(false);
    }
  }

  if (loading) {
    return (
      <div className="desktop-card p-14 text-center text-[var(--text-muted)] text-xs flex items-center justify-center gap-2">
        <RefreshCw size={15} className="animate-spin text-blue-400" />
        Loading trash contents…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="desktop-card p-14 text-center flex flex-col items-center justify-center space-y-3 border-dashed">
        <Trash2 size={26} className="text-[var(--text-subtle)]" strokeWidth={1.5} />
        <p className="text-sm font-bold text-white">Google Drive Trash is Empty</p>
        <p className="text-xs text-[var(--text-muted)]">
          Deleted items moved to trash will appear here for recovery.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-[var(--text-muted)]">
          {items.length} file{items.length === 1 ? "" : "s"} in Google Drive Trash
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleUntrashAll}
          disabled={restoringAll || items.length === 0}
          className="flex items-center gap-2 text-xs text-emerald-400 hover:text-emerald-300 font-semibold"
        >
          <RotateCcw size={14} className={cn(restoringAll && "animate-spin")} />
          {restoringAll ? "Restoring All Files…" : "Restore All Files"}
        </Button>
      </div>

      <div className="desktop-card overflow-hidden divide-y divide-[var(--border-subtle)]">
        {items.map((file) => (
          <div
            key={file.id}
            className="flex items-center justify-between px-4 py-3 text-xs hover:bg-[var(--surface-2)] transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <FileText size={16} className="text-[var(--text-subtle)] shrink-0" />
              <span className="truncate code-text font-semibold text-white">
                {file.name ?? file.id}
              </span>
            </div>

            <div className="flex items-center gap-3.5 shrink-0">
              {file.size && (
                <span className="code-text text-xs text-[var(--text-subtle)]">
                  {formatBytes(parseInt(file.size, 10))}
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleUntrash(file.id)}
                className="flex items-center gap-1.5 text-xs"
              >
                <RotateCcw size={13} />
                Restore
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
