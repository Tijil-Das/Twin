/**
 * Windows Explorer style Google Drive folder selector panel.
 * Provides hierarchical breadcrumb navigation, all-folder tree caching,
 * instant inline folder creation, Drive switching, search, and scope diagnostics.
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Folder,
  FolderPlus,
  ChevronRight,
  ArrowUp,
  RefreshCw,
  Search,
  HardDrive,
  Check,
  AlertCircle,
  Plus,
  X,
  ShieldAlert,
} from "lucide-react";
import {
  driveList,
  driveGetFolders,
  driveCreateFolder,
  driveSearch,
  listSharedDrives,
  authHasFullScope,
  authLogin,
} from "@/lib/tauri";
import type { DriveFile } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface DriveFolder {
  id: string;
  name: string;
  modifiedTime?: string | null;
  parents?: string[];
}

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface SharedDriveItem {
  id: string;
  name: string;
}

interface Props {
  selectedFolderId: string;
  onSelect: (folderId: string, folderName: string) => void;
  className?: string;
}

export function DriveFolderSelector({ selectedFolderId, onSelect, className }: Props) {
  const [currentFolderId, setCurrentFolderId] = useState<string>("root");
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: "root", name: "My Drive" },
  ]);
  const [sharedDrives, setSharedDrives] = useState<SharedDriveItem[]>([]);
  const [allDriveFolders, setAllDriveFolders] = useState<DriveFolder[]>([]);
  const [folderCache, setFolderCache] = useState<Record<string, DriveFolder[]>>({});
  const [loading, setLoading] = useState(false);
  const [isSearchingAll, setIsSearchingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [activeSelection, setActiveSelection] = useState<{ id: string; name: string } | null>(
    null
  );
  const [hasFullScope, setHasFullScope] = useState<boolean>(true);
  const [reauthorizing, setReauthorizing] = useState(false);

  // New folder inline creation
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const currentFolder = breadcrumbs[breadcrumbs.length - 1];

  // Check auth scope & load shared drives on mount
  useEffect(() => {
    void authHasFullScope().then((full) => {
      setHasFullScope(full);
    });
    void listSharedDrives().then((drives) => {
      if (Array.isArray(drives)) setSharedDrives(drives);
    });
  }, []);

  // Primary loader: load all folders or fallback to list_folder
  const loadFolders = useCallback(async (targetId: string, forceRefresh = false) => {
    setLoading(true);
    setIsSearchingAll(false);
    setError(null);
    try {
      // 1. If we don't have allDriveFolders loaded yet or forceRefresh requested, try driveGetFolders
      let fullList = allDriveFolders;
      if (fullList.length === 0 || forceRefresh) {
        try {
          const raw = await driveGetFolders();
          if (Array.isArray(raw)) {
            fullList = raw.map((f: DriveFile) => ({
              id: f.id,
              name: f.name || "Untitled Folder",
              modifiedTime: f.modified_time || f.modifiedTime,
              parents: f.parents || [],
            }));
            setAllDriveFolders(fullList);
          }
        } catch (e) {
          console.warn("[DriveFolderSelector] driveGetFolders failed, falling back to driveList:", e);
        }
      }

      // 2. If we have folders from the account-wide query
      if (fullList.length > 0) {
        let matching: DriveFolder[] = [];
        if (targetId === "root") {
          // Folders whose parents include "root" or has no parents recorded
          matching = fullList.filter(
            (f) => !f.parents || f.parents.length === 0 || f.parents.includes("root")
          );
          // If no folders explicitly claim "root", display all top-level folders
          if (matching.length === 0) {
            matching = fullList;
          }
        } else {
          matching = fullList.filter((f) => f.parents && f.parents.includes(targetId));
        }

        matching.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        setFolderCache((prev) => ({ ...prev, [targetId]: matching }));
        return;
      }

      // 3. Fallback: Query single folder children directly
      const items = await driveList(targetId);
      let list: DriveFolder[] = (items || [])
        .filter((item: DriveFile) => {
          const mime = item.mime_type || item.mimeType;
          return (
            mime === "application/vnd.google-apps.folder" ||
            mime === "application/vnd.google-apps.shortcut"
          );
        })
        .map((f: DriveFile) => ({
          id: f.id,
          name: f.name || "Untitled Folder",
          modifiedTime: f.modified_time || f.modifiedTime,
          parents: f.parents || [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      // Broad search fallback if root returned 0 folders
      if (list.length === 0 && targetId === "root") {
        try {
          const all = await driveSearch("", "application/vnd.google-apps.folder");
          if (Array.isArray(all) && all.length > 0) {
            list = all.map((f: DriveFile) => ({
              id: f.id,
              name: f.name || "Untitled Folder",
              modifiedTime: f.modified_time || f.modifiedTime,
              parents: f.parents || [],
            }));
            setIsSearchingAll(true);
          }
        } catch {
          // ignore fallback error
        }
      }

      setFolderCache((prev) => ({ ...prev, [targetId]: list }));
    } catch (err: unknown) {
      console.error("[DriveFolderSelector] loadFolders error:", err);
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : JSON.stringify(err);
      setError(`Failed to retrieve folders: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [allDriveFolders]);

  useEffect(() => {
    void loadFolders(currentFolderId);
  }, [currentFolderId, loadFolders]);

  // Current folder's children
  const currentFolders = useMemo(() => {
    return folderCache[currentFolderId] || [];
  }, [folderCache, currentFolderId]);

  // Search across the entire Google Drive
  async function handleSearchEntireDrive() {
    if (!filterQuery.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const results = await driveSearch(filterQuery.trim(), "application/vnd.google-apps.folder");
      const list: DriveFolder[] = (results || []).map((f: DriveFile) => ({
        id: f.id,
        name: f.name || "Untitled Folder",
        modifiedTime: f.modified_time || f.modifiedTime,
        parents: f.parents || [],
      }));
      setFolderCache((prev) => ({ ...prev, [currentFolderId]: list }));
      setIsSearchingAll(true);
    } catch (err: unknown) {
      setError(`Drive search failed: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  // Create new folder in current directory
  async function handleCreateNewFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setCreatingFolder(true);
    try {
      const newId = await driveCreateFolder(currentFolderId, name);
      toast.success(`Created folder "${name}"`);
      const newFolder: DriveFolder = {
        id: newId,
        name,
        modifiedTime: new Date().toISOString(),
        parents: [currentFolderId],
      };
      setFolderCache((prev) => ({
        ...prev,
        [currentFolderId]: [newFolder, ...(prev[currentFolderId] || [])],
      }));
      setAllDriveFolders((prev) => [newFolder, ...prev]);
      setIsCreatingFolder(false);
      setNewFolderName("");
      selectFolder(newId, name);
    } catch (e) {
      toast.error(`Could not create folder: ${String(e)}`);
    } finally {
      setCreatingFolder(false);
    }
  }

  // Re-authorize with full Drive scope
  async function handleReauthorize() {
    setReauthorizing(true);
    try {
      await authLogin();
      toast.success("Authentication updated! Refreshing Drive folders...");
      setHasFullScope(true);
      void loadFolders(currentFolderId, true);
    } catch (e) {
      toast.error(`Authorization failed: ${String(e)}`);
    } finally {
      setReauthorizing(false);
    }
  }

  // Navigate deeper into a subfolder
  function enterFolder(folder: DriveFolder) {
    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setFilterQuery("");
    setIsCreatingFolder(false);
  }

  // Navigate up to parent folder
  function navigateUp() {
    if (breadcrumbs.length <= 1) return;
    const parent = breadcrumbs[breadcrumbs.length - 2];
    setBreadcrumbs((prev) => prev.slice(0, prev.length - 1));
    setCurrentFolderId(parent.id);
    setFilterQuery("");
    setIsCreatingFolder(false);
  }

  // Jump directly to an ancestor in the breadcrumbs
  function jumpToBreadcrumb(index: number) {
    if (index >= breadcrumbs.length - 1) return;
    const target = breadcrumbs[index];
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    setCurrentFolderId(target.id);
    setFilterQuery("");
    setIsCreatingFolder(false);
  }

  // Switch drive (e.g. Shared Drive or My Drive)
  function handleSwitchDrive(driveId: string, driveName: string) {
    setBreadcrumbs([{ id: driveId, name: driveName }]);
    setCurrentFolderId(driveId);
    setFilterQuery("");
    setIsCreatingFolder(false);
  }

  // Filtered folders in current view
  const displayedFolders = useMemo(() => {
    if (!filterQuery.trim() || isSearchingAll) return currentFolders;
    const q = filterQuery.toLowerCase();
    return currentFolders.filter((f) => f.name.toLowerCase().includes(q));
  }, [currentFolders, filterQuery, isSearchingAll]);

  // Handle selecting a folder
  function selectFolder(id: string, name: string) {
    setActiveSelection({ id, name });
    onSelect(id, name);
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-[var(--border)] bg-[#0d0f15] overflow-hidden flex flex-col text-[12.5px]",
        className
      )}
    >
      {/* ── Scope Warning Banner (If logged in with old restricted drive.file token) ── */}
      {!hasFullScope && (
        <div className="bg-amber-500/10 border-b border-amber-500/25 px-3 py-2 flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 min-w-0 text-amber-300">
            <ShieldAlert size={14} className="shrink-0 text-amber-400" />
            <span className="truncate">
              Limited Google Drive scope: existing folders created outside Twin are hidden.
            </span>
          </div>
          <button
            type="button"
            onClick={handleReauthorize}
            disabled={reauthorizing}
            className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-medium shrink-0 border border-amber-500/30 transition-colors"
          >
            {reauthorizing ? "Opening Google..." : "Grant Full Drive Access"}
          </button>
        </div>
      )}

      {/* ── Explorer Address Bar & Navigation Toolbar ── */}
      <div className="p-2 border-b border-[var(--border)] bg-[#12141d] flex items-center gap-1.5">
        <button
          type="button"
          onClick={navigateUp}
          disabled={breadcrumbs.length <= 1 || loading}
          title="Up one folder level"
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
        >
          <ArrowUp size={14} />
        </button>

        {/* Drive Selector if Shared Drives exist */}
        {sharedDrives.length > 0 && (
          <select
            value={breadcrumbs[0]?.id || "root"}
            onChange={(e) => {
              const id = e.target.value;
              const name =
                id === "root"
                  ? "My Drive"
                  : sharedDrives.find((d) => d.id === id)?.name || "Drive";
              handleSwitchDrive(id, name);
            }}
            className="bg-[#090a0e] text-xs text-white border border-[var(--border)] rounded px-2 py-1 outline-none"
          >
            <option value="root">My Drive</option>
            {sharedDrives.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}

        {/* Breadcrumb address path */}
        <div className="flex-1 min-w-0 flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#090a0e] border border-[var(--border)] overflow-x-auto select-none">
          <HardDrive size={13} className="text-blue-400 shrink-0 mr-0.5" />
          {breadcrumbs.map((bc, idx) => {
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <div key={bc.id} className="flex items-center gap-1 shrink-0">
                {idx > 0 && <ChevronRight size={11} className="text-zinc-600 shrink-0" />}
                <button
                  type="button"
                  onClick={() => jumpToBreadcrumb(idx)}
                  disabled={isLast}
                  className={cn(
                    "px-1 py-0.5 rounded transition-colors text-xs truncate max-w-[140px]",
                    isLast
                      ? "font-semibold text-white cursor-default"
                      : "text-zinc-400 hover:text-blue-400 hover:bg-white/5"
                  )}
                  title={bc.name}
                >
                  {bc.name}
                </button>
              </div>
            );
          })}
        </div>

        {/* New Folder button */}
        <button
          type="button"
          onClick={() => setIsCreatingFolder((prev) => !prev)}
          title="Create a new folder in this directory"
          className={cn(
            "p-1.5 rounded-md transition-colors flex items-center gap-1 text-xs",
            isCreatingFolder
              ? "bg-blue-600/30 text-blue-400 border border-blue-500/40"
              : "text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)]"
          )}
        >
          <FolderPlus size={14} />
          <span className="hidden sm:inline text-[11px] font-medium">New</span>
        </button>

        {/* Refresh button */}
        <button
          type="button"
          onClick={() => void loadFolders(currentFolderId, true)}
          disabled={loading}
          title="Refresh folder listing"
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)] disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin text-blue-400")} />
        </button>
      </div>

      {/* ── Inline New Folder Creator ── */}
      {isCreatingFolder && (
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[#101420] flex items-center gap-2 animate-in fade-in duration-100">
          <FolderPlus size={14} className="text-blue-400 shrink-0" />
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateNewFolder();
              if (e.key === "Escape") setIsCreatingFolder(false);
            }}
            placeholder="Enter new folder name..."
            autoFocus
            className="flex-1 bg-[#090a0e] border border-[var(--border)] rounded px-2.5 py-1 text-xs text-white placeholder:text-zinc-500 outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={handleCreateNewFolder}
            disabled={!newFolderName.trim() || creatingFolder}
            className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium flex items-center gap-1"
          >
            <Plus size={12} />
            <span>{creatingFolder ? "Creating..." : "Create"}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsCreatingFolder(false);
              setNewFolderName("");
            }}
            className="p-1 text-zinc-400 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Subfolder Filter / Search Bar ── */}
      <div className="px-3 py-1.5 border-b border-[var(--border)] bg-[#10121a] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-zinc-400 text-[11px] font-medium flex-1">
          <Search size={12} className="text-zinc-500 shrink-0" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSearchEntireDrive();
            }}
            placeholder={`Filter in ${currentFolder.name} (or press Enter to search Drive)...`}
            className="bg-transparent border-0 outline-none text-xs text-white placeholder:text-zinc-500 w-full"
          />
        </div>
        {filterQuery && !isSearchingAll && (
          <button
            type="button"
            onClick={handleSearchEntireDrive}
            className="text-[11px] text-blue-400 hover:underline shrink-0"
          >
            Search Drive
          </button>
        )}
        <span className="text-[11px] text-zinc-500 shrink-0">
          {displayedFolders.length} folder{displayedFolders.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* ── Folder List View (Windows Explorer dark style) ── */}
      <div className="min-h-[170px] max-h-[220px] overflow-y-auto p-1.5 space-y-0.5 divide-y divide-white/[0.03]">
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 text-zinc-500">
            <RefreshCw size={18} className="animate-spin text-blue-400" />
            <span className="text-xs">Loading folders from Google Drive...</span>
          </div>
        ) : error ? (
          <div className="p-4 text-center space-y-2">
            <AlertCircle size={20} className="mx-auto text-amber-400/80" />
            <p className="text-xs text-zinc-400 leading-relaxed break-words">{error}</p>
            <button
              type="button"
              onClick={() => void loadFolders(currentFolderId, true)}
              className="text-xs text-blue-400 hover:underline inline-block font-medium"
            >
              Retry Connection
            </button>
          </div>
        ) : displayedFolders.length === 0 ? (
          <div className="py-7 text-center space-y-2.5">
            <FolderPlus size={24} className="mx-auto text-zinc-600" />
            <p className="text-xs text-zinc-400">
              {filterQuery
                ? `No folders matching "${filterQuery}".`
                : "No folders found in this directory."}
            </p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsCreatingFolder(true)}
                className="text-xs px-2.5 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-500/30 inline-flex items-center gap-1.5 font-medium"
              >
                <FolderPlus size={13} />
                <span>+ Create Folder Here</span>
              </button>
              <button
                type="button"
                onClick={handleSearchEntireDrive}
                className="text-xs px-2.5 py-1 rounded bg-[var(--surface-2)] text-zinc-300 hover:text-white border border-[var(--border)] inline-flex items-center gap-1.5"
              >
                <Search size={13} />
                <span>Search All Drive</span>
              </button>
            </div>
          </div>
        ) : (
          displayedFolders.map((folder) => {
            const isSelected =
              activeSelection?.id === folder.id || selectedFolderId === folder.id;
            return (
              <div
                key={folder.id}
                onClick={() => selectFolder(folder.id, folder.name)}
                onDoubleClick={() => enterFolder(folder)}
                className={cn(
                  "group px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer transition-colors duration-100",
                  isSelected
                    ? "bg-blue-600/25 border border-blue-500/50 text-white font-medium"
                    : "hover:bg-[var(--surface-2)] text-zinc-300 border border-transparent"
                )}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <Folder
                    size={15}
                    className="text-amber-400 fill-amber-400/20 shrink-0"
                  />
                  <span className="truncate text-xs">{folder.name}</span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {isSelected && (
                    <span className="text-[11px] text-blue-400 font-semibold flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/20">
                      <Check size={11} strokeWidth={3} /> Target
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      enterFolder(folder);
                    }}
                    title={`Open "${folder.name}"`}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-opacity text-[11px] flex items-center gap-0.5"
                  >
                    <span>Open</span>
                    <ChevronRight size={12} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Explorer Bottom Action Bar ── */}
      <div className="p-2 border-t border-[var(--border)] bg-[#12141d] flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => selectFolder(currentFolder.id, currentFolder.name)}
          className={cn(
            "text-xs px-2.5 py-1 rounded-md font-medium border flex items-center gap-1.5 transition-colors",
            selectedFolderId === currentFolder.id || activeSelection?.id === currentFolder.id
              ? "bg-blue-600/20 border-blue-500/40 text-blue-400"
              : "bg-[#090a0e] border-[var(--border)] text-zinc-300 hover:text-white hover:bg-[var(--surface-2)]"
          )}
        >
          <Folder size={12} className="text-amber-400" />
          <span>Use Current: "{currentFolder.name}"</span>
        </button>

        {activeSelection ? (
          <div
            className="text-[11px] text-zinc-400 truncate max-w-[220px]"
            title={activeSelection.name}
          >
            Selected: <span className="font-semibold text-white">{activeSelection.name}</span>
          </div>
        ) : selectedFolderId ? (
          <div
            className="text-[11px] text-zinc-400 font-mono truncate max-w-[200px]"
            title={selectedFolderId}
          >
            ID: <span className="text-zinc-300">{selectedFolderId}</span>
          </div>
        ) : (
          <span className="text-[11px] text-zinc-500">Click a folder to select</span>
        )}
      </div>
    </div>
  );
}
