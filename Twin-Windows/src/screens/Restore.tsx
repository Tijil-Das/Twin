/**
 * Drive Explorer & Version Restore Screen
 * Native remote Google Drive browser, multi-version history inspector,
 * and trash recovery ledger.
 */
import { useState, useEffect, useMemo } from "react";
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
  Search,
  Star,
  Share2,
  Clock,
  RotateCcw,
  Trash2,
  Download,
  RefreshCw,
  X,
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
import gdLogo from "@/assets/gd-icon.png";

type Tab = "files" | "trash";

interface ExtendedDriveFile extends DriveFile {
  description?: string | null;
  starred?: boolean | null;
}

interface SharedDrive {
  id: string;
  name: string;
}

// GitHub Octicon Folder SVG (filled folder shape with tab)
function GithubFolderIcon({ color, className }: { color?: string | null; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-4 h-4 shrink-0 fill-current", className)}
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
    </svg>
  );
}

// GitHub Octicon File SVG (clean sheet with folded corner)
function GithubFileIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-4 h-4 shrink-0 fill-current text-[#7d8590]", className)}
      aria-hidden="true"
    >
      <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />
    </svg>
  );
}

export function RestoreScreen() {
  const [tab, setTab] = useState<Tab>("files");

  return (
    <div className="p-6 sm:p-8 w-full space-y-6">
      {/* Header & Mode Switcher */}
      <div className="flex items-center justify-between pb-3.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <img
            src={gdLogo}
            alt="Google Drive"
            style={{ width: 28, height: 28, minWidth: 28, maxWidth: 28 }}
            className="w-7 h-7 object-contain shrink-0"
          />
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
              Drive Explorer & Restore
            </h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Browse remote Google Drive files, inspect multi-version history, and restore data.
            </p>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 p-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)]">
          <button
            onClick={() => setTab("files")}
            className={cn(
              "px-3.5 py-1.5 rounded text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-2",
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
              "px-3.5 py-1.5 rounded text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-2",
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

  const folders = useMemo(
    () =>
      files
        .filter((f) => f.mime_type === "application/vnd.google-apps.folder")
        .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [files]
  );
  const items = useMemo(
    () =>
      files
        .filter((f) => f.mime_type !== "application/vnd.google-apps.folder")
        .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [files]
  );

  return (
    <div className="flex gap-5 items-start">
      {/* Main File Browser */}
      <div className="flex-1 min-w-0 space-y-3">
        {/* Fallback Root ID input if no drive loaded */}
        {!rootId && (
          <div className="p-3 bg-[#161b22] border border-[#30363d] rounded-md flex items-center gap-3">
            <Input
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="Paste Google Drive Folder ID directly, or choose My Drive above"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleBrowse();
              }}
              className="text-xs code-text h-8 flex-1 bg-[#0d1117] border-[#30363d]"
            />
            <Button size="sm" onClick={() => void handleBrowse()}>
              Open
            </Button>
          </div>
        )}

        {/* GitHub Repository Item Viewer Table */}
        <div className="rounded-md border border-[#30363d] bg-[#0d1117] overflow-hidden shadow-sm">
          {/* GitHub Header Bar */}
          <div className="bg-[#161b22] px-3.5 py-2.5 border-b border-[#30363d] flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {/* Drive selector pill */}
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#21262d] border border-[#30363d] text-xs font-semibold text-[#c9d1d9] hover:bg-[#30363d] transition-colors cursor-pointer shrink-0">
                <img
                  src={gdLogo}
                  alt="Google Drive"
                  style={{ width: 14, height: 14, minWidth: 14, maxWidth: 14 }}
                  className="w-3.5 h-3.5 object-contain shrink-0"
                />
                <select
                  value={selectedDrive}
                  onChange={(e) => void handleDriveChange(e.target.value)}
                  className="bg-transparent border-none text-[#c9d1d9] focus:outline-none cursor-pointer pr-1 font-semibold text-xs"
                >
                  <option value="root" className="bg-[#161b22] text-white">My Drive</option>
                  {sharedDrives.map((d) => (
                    <option key={d.id} value={d.id} className="bg-[#161b22] text-white">
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* GitHub Path Breadcrumbs */}
              {breadcrumb.length > 0 && (
                <nav className="flex items-center gap-1 text-xs font-semibold text-[#e6edf3] overflow-x-auto min-w-0">
                  {breadcrumb.map((bc, i) => (
                    <span key={bc.id} className="flex items-center gap-1 shrink-0">
                      {i > 0 && <span className="text-[#484f58] font-normal px-0.5">/</span>}
                      <button
                        onClick={() => void loadFolder(bc.id, bc.name)}
                        className={cn(
                          "transition-colors rounded cursor-pointer",
                          i === breadcrumb.length - 1
                            ? "font-bold text-[#e6edf3]"
                            : "text-[#58a6ff] hover:underline font-medium"
                        )}
                      >
                        {bc.name}
                      </button>
                    </span>
                  ))}
                </nav>
              )}
            </div>

            {/* Actions: Search, Colorize, Count, Refresh */}
            <div className="flex items-center gap-2 shrink-0">
              {/* GitHub style search input */}
              <div className="relative">
                {isSearching ? (
                  <RefreshCw size={12} className="absolute left-2.5 top-2 text-[#58a6ff] animate-spin" />
                ) : (
                  <Search size={12} className="absolute left-2.5 top-2 text-[#7d8590]" />
                )}
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Go to file…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSearch();
                  }}
                  className="bg-[#0d1117] border border-[#30363d] rounded-md pl-7 pr-6 py-1 text-xs text-[#c9d1d9] placeholder:text-[#7d8590] outline-none focus:border-[#58a6ff] w-32 sm:w-44 transition-all"
                />
                {searchQuery && (
                  <button
                    onClick={handleClearSearch}
                    className="absolute right-2 top-1.5 text-[#7d8590] hover:text-white"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {folders.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    openMultiFolderColor(
                      selectedFolderIds.size > 0 ? Array.from(selectedFolderIds) : undefined
                    )
                  }
                  className="px-2.5 py-1 rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] hover:text-white border border-[#30363d] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                  title="Choose which folders inside this folder to colorize"
                >
                  <Palette size={12} className="text-amber-400" />
                  <span className="hidden sm:inline">Colorize Folders ({folders.length})</span>
                  <span className="sm:hidden">Color</span>
                </button>
              )}

              {breadcrumb.length > 0 && breadcrumb[breadcrumb.length - 1].id !== "root" && (
                <button
                  type="button"
                  onClick={() =>
                    openSingleFolderColor({
                      id: breadcrumb[breadcrumb.length - 1].id,
                      name: breadcrumb[breadcrumb.length - 1].name,
                    })
                  }
                  className="px-2 py-1 rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] hover:text-white border border-[#30363d] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                  title={`Colorize "${breadcrumb[breadcrumb.length - 1].name}" folder`}
                >
                  <Palette size={12} className="text-blue-400" />
                  <span className="hidden sm:inline">Color Current</span>
                </button>
              )}

              <span className="text-xs text-[#7d8590] code-text font-mono hidden md:inline">
                {folders.length} dirs, {items.length} files
              </span>

              <button
                type="button"
                onClick={() => void loadFolder(rootId || "root", breadcrumb[breadcrumb.length - 1]?.name || "Root")}
                disabled={loading}
                title="Refresh folder contents"
                className="p-1.5 rounded-md text-[#7d8590] hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer disabled:opacity-40"
              >
                <RefreshCw size={12} className={cn(loading && "animate-spin text-blue-400")} />
              </button>
            </div>
          </div>

          {/* Multi-selection Banner */}
          {selectedFolderIds.size > 0 && (
            <div className="bg-[#1f6feb]/15 border-b border-[#1f6feb]/30 px-4 py-2 flex items-center justify-between text-xs animate-in fade-in duration-100">
              <div className="flex items-center gap-2">
                <span className="text-[#58a6ff] font-semibold">
                  {selectedFolderIds.size} of {folders.length} folders selected
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedFolderIds(new Set())}
                  className="text-[11px] text-[#7d8590] hover:text-white underline cursor-pointer"
                >
                  Deselect
                </button>
              </div>
              <button
                onClick={() => openMultiFolderColor(Array.from(selectedFolderIds))}
                className="px-2.5 py-1 rounded bg-blue-700 hover:bg-blue-600 active:bg-blue-800 text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer border border-blue-600/40"
              >
                <Palette size={12} />
                <span>Colorize Selected ({selectedFolderIds.size})</span>
              </button>
            </div>
          )}

          {/* GitHub-style '..' Up one level row */}
          {breadcrumb.length > 1 && (
            <div
              onClick={() => {
                const parent = breadcrumb[breadcrumb.length - 2];
                if (parent) void loadFolder(parent.id, parent.name);
              }}
              className="px-4 py-2 border-b border-[#21262d] bg-[#0d1117] flex items-center gap-2.5 text-xs font-semibold text-[#58a6ff] hover:bg-[#161b22] hover:underline cursor-pointer transition-colors select-none"
              title="Go to parent directory"
            >
              <GithubFolderIcon className="text-[#54aeff]" />
              <span className="font-mono text-sm leading-none font-bold">..</span>
            </div>
          )}

          {/* File Browser Table Body */}
          {loading ? (
            <div className="p-12 text-center text-[#7d8590] text-xs flex items-center justify-center gap-2 bg-[#0d1117]">
              <RefreshCw size={14} className="animate-spin text-[#58a6ff]" />
              Loading directory…
            </div>
          ) : rootId && files.length === 0 ? (
            <div className="p-12 text-center text-[#7d8590] text-xs bg-[#0d1117]">
              This Google Drive folder is empty.
            </div>
          ) : (
            <div className="divide-y divide-[#21262d] max-h-[580px] overflow-y-auto bg-[#0d1117]">
              {[...folders, ...items].map((file) => {
                const isFolder = file.mime_type === "application/vnd.google-apps.folder";
                const isSelected = selected?.id === file.id;
                const folderColor = file.folderColorRgb ?? file.folder_color_rgb;
                const isFolderSelected = selectedFolderIds.has(file.id);

                return (
                  <div
                    key={file.id}
                    onClick={() => void handleSelect(file)}
                    className={cn(
                      "group px-4 py-2 flex items-center justify-between text-xs transition-colors cursor-pointer select-none",
                      isSelected
                        ? "bg-[#1f6feb]/20 text-[#58a6ff]"
                        : "hover:bg-[#161b22] text-[#c9d1d9]"
                    )}
                  >
                    {/* Left: Checkbox + Icon + Name */}
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {isFolder && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelectFolder(file.id);
                          }}
                          className="p-0.5 text-[#7d8590] hover:text-[#e6edf3] cursor-pointer shrink-0"
                          title={isFolderSelected ? "Deselect folder" : "Select folder"}
                        >
                          {isFolderSelected ? (
                            <CheckSquare size={13} className="text-[#58a6ff]" />
                          ) : (
                            <Square size={13} className="text-[#484f58]" />
                          )}
                        </button>
                      )}

                      {isFolder ? (
                        <GithubFolderIcon
                          color={folderColor || "#54aeff"}
                          className={cn("shrink-0", !folderColor && "text-[#54aeff]")}
                        />
                      ) : (
                        <GithubFileIcon className="shrink-0" />
                      )}

                      <span
                        className={cn(
                          "truncate group-hover:text-[#58a6ff] group-hover:underline text-[13px]",
                          isFolder ? "text-[#e6edf3] font-medium" : "text-[#c9d1d9] font-normal"
                        )}
                        title={file.name ?? file.id}
                      >
                        {file.name ?? file.id}
                      </span>

                      {isFolder && folderColor && (
                        <span
                          className="w-2 h-2 rounded-full shrink-0 border border-white/20 shadow-sm"
                          style={{ backgroundColor: folderColor }}
                          title={`Folder color: ${folderColor}`}
                        />
                      )}

                      {file.starred && (
                        <Star size={12} className="fill-amber-400 text-amber-400 shrink-0" />
                      )}
                    </div>

                    {/* Middle: Description Note */}
                    {file.description && (
                      <div className="hidden lg:block truncate text-xs text-[#7d8590] px-3 max-w-[200px]">
                        {file.description}
                      </div>
                    )}

                    {/* Right: Date, Size, Actions */}
                    <div className="flex items-center gap-3 shrink-0 text-xs text-[#7d8590]">
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
                          className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] hover:text-white border border-[#30363d] transition-all cursor-pointer flex items-center gap-1 text-[11px]"
                        >
                          <Palette size={11} />
                          <span>Color</span>
                        </button>
                      )}

                      {file.modified_time && (
                        <span className="w-24 text-right truncate font-mono text-[11px] text-[#7d8590]">
                          {formatRelTime(new Date(file.modified_time).getTime())}
                        </span>
                      )}

                      <span className="w-16 text-right font-mono text-[11px] text-[#7d8590]">
                        {file.size ? formatBytes(parseInt(file.size, 10)) : "--"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
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
