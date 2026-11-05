/**
 * Windows Explorer style Google Drive folder selector panel.
 * Strictly separates "My Drive" (owned by user) and "Shared with me" (shared by others).
 * Provides hierarchical breadcrumb navigation, instant inline folder creation,
 * Drive switching, search, and scope diagnostics.
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
  Users,
  Check,
  AlertCircle,
  Plus,
  X,
  ShieldAlert,
} from "lucide-react";
import {
  driveList,
  driveGetFolders,
  driveGetSharedFolders,
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
  shared?: boolean;
}

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface SharedDriveItem {
  id: string;
  name: string;
}

type DriveSection = "my_drive" | "shared_with_me" | string;

interface Props {
  selectedFolderId: string;
  onSelect: (folderId: string, folderName: string) => void;
  className?: string;
}

export function DriveFolderSelector({ selectedFolderId, onSelect, className }: Props) {
  const [activeSection, setActiveSection] = useState<DriveSection>("my_drive");
  const [currentFolderId, setCurrentFolderId] = useState<string>("root");
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: "root", name: "My Drive" },
  ]);
  const [sharedDrives, setSharedDrives] = useState<SharedDriveItem[]>([]);
  
  // Cache partitioned by section: "my_drive" or "shared_with_me"
  const [myDriveFolders, setMyDriveFolders] = useState<DriveFolder[]>([]);
  const [sharedFolders, setSharedFolders] = useState<DriveFolder[]>([]);
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

  // Primary loader: load My Drive folders or Shared with me folders
  const loadSectionFolders = useCallback(async (section: DriveSection, force = false) => {
    setLoading(true);
    setIsSearchingAll(false);
    setError(null);
    try {
      if (section === "my_drive") {
        if (myDriveFolders.length === 0 || force) {
          const raw = await driveGetFolders();
          const list: DriveFolder[] = (raw || []).map((f: DriveFile) => ({
            id: f.id,
            name: f.name || "Untitled Folder",
            modifiedTime: f.modified_time || f.modifiedTime,
            parents: f.parents || [],
            shared: f.shared || false,
          }));
          setMyDriveFolders(list);
          return list;
        }
        return myDriveFolders;
      } else if (section === "shared_with_me") {
        if (sharedFolders.length === 0 || force) {
          const raw = await driveGetSharedFolders();
          const list: DriveFolder[] = (raw || []).map((f: DriveFile) => ({
            id: f.id,
            name: f.name || "Untitled Folder",
            modifiedTime: f.modified_time || f.modifiedTime,
            parents: f.parents || [],
            shared: true,
          }));
          setSharedFolders(list);
          return list;
        }
        return sharedFolders;
      } else {
        // Shared Drive or specific drive container
        const items = await driveList(section);
        const list: DriveFolder[] = (items || [])
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
            shared: false,
          }));
        setFolderCache((prev) => ({ ...prev, [section]: list }));
        return list;
      }
    } catch (err: unknown) {
      console.error("[DriveFolderSelector] loadSectionFolders error:", err);
      const msg =
        typeof err === "string" ? err : err instanceof Error ? err.message : JSON.stringify(err);
      setError(`Failed to retrieve folders: ${msg}`);
      return [];
    } finally {
      setLoading(false);
    }
  }, [myDriveFolders, sharedFolders]);

  // Load subfolder or top-level folders
  const loadCurrentFolder = useCallback(async (targetId: string, section: DriveSection, force = false) => {
    // If inside a subfolder, list its direct children if not in cache
    if (targetId !== "root" && targetId !== "shared_with_me" && !sharedDrives.some((d) => d.id === targetId)) {
      if (!folderCache[targetId] || force) {
        setLoading(true);
        try {
          const items = await driveList(targetId);
          const list: DriveFolder[] = (items || [])
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
          setFolderCache((prev) => ({ ...prev, [targetId]: list }));
        } catch (e: unknown) {
          setError(`Failed to open folder: ${String(e)}`);
        } finally {
          setLoading(false);
        }
      }
      return;
    }

    // Top-level section load
    await loadSectionFolders(section, force);
  }, [folderCache, loadSectionFolders, sharedDrives]);

  useEffect(() => {
    void loadCurrentFolder(currentFolderId, activeSection);
  }, [currentFolderId, activeSection, loadCurrentFolder]);

  // Determine displayed folders for current view
  const currentFolders = useMemo(() => {
    if (activeSection === "my_drive") {
      if (currentFolderId === "root") {
        // Direct top-level folders in My Drive:
        // Folders with 'root' in parents, or whose parent is not one of user's other folders
        const allIds = new Set(myDriveFolders.map((f) => f.id));
        const roots = myDriveFolders.filter((f) => {
          if (!f.parents || f.parents.length === 0) return true;
          if (f.parents.includes("root")) return true;
          // If parent is not any folder in myDriveFolders, it sits at root
          return !f.parents.some((p) => allIds.has(p));
        });
        return roots.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      }
      // Subfolder in My Drive
      if (folderCache[currentFolderId]) {
        return folderCache[currentFolderId];
      }
      const children = myDriveFolders.filter((f) => f.parents && f.parents.includes(currentFolderId));
      return children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    } else if (activeSection === "shared_with_me") {
      if (currentFolderId === "root" || currentFolderId === "shared_with_me") {
        return sharedFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      }
      return folderCache[currentFolderId] || [];
    } else {
      // Shared Drive container
      return folderCache[currentFolderId] || [];
    }
  }, [activeSection, currentFolderId, myDriveFolders, sharedFolders, folderCache]);

  // Filtered folders by search text
  const displayedFolders = useMemo(() => {
    if (!filterQuery.trim() || isSearchingAll) return currentFolders;
    const q = filterQuery.toLowerCase();
    return currentFolders.filter((f) => f.name.toLowerCase().includes(q));
  }, [currentFolders, filterQuery, isSearchingAll]);

  // Search across Google Drive
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
        shared: f.shared || false,
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
      const targetParent = currentFolderId === "shared_with_me" ? "root" : currentFolderId;
      const newId = await driveCreateFolder(targetParent, name);
      toast.success(`Created folder "${name}"`);
      const newFolder: DriveFolder = {
        id: newId,
        name,
        modifiedTime: new Date().toISOString(),
        parents: [targetParent],
        shared: false,
      };
      setMyDriveFolders((prev) => [newFolder, ...prev]);
      setFolderCache((prev) => ({
        ...prev,
        [targetParent]: [newFolder, ...(prev[targetParent] || [])],
      }));
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
      toast.success("Authentication updated! Refreshing My Drive folders...");
      setHasFullScope(true);
      void loadSectionFolders(activeSection, true);
    } catch (e) {
      toast.error(`Authorization failed: ${String(e)}`);
    } finally {
      setReauthorizing(false);
    }
  }

  // Switch top-level location (My Drive vs Shared with me vs Shared Drives)
  function handleSectionChange(newSection: DriveSection) {
    setActiveSection(newSection);
    setIsSearchingAll(false);
    setFilterQuery("");
    setIsCreatingFolder(false);

    if (newSection === "my_drive") {
      setCurrentFolderId("root");
      setBreadcrumbs([{ id: "root", name: "My Drive" }]);
      void loadSectionFolders("my_drive");
    } else if (newSection === "shared_with_me") {
      setCurrentFolderId("shared_with_me");
      setBreadcrumbs([{ id: "shared_with_me", name: "Shared with me" }]);
      void loadSectionFolders("shared_with_me");
    } else {
      const drive = sharedDrives.find((d) => d.id === newSection);
      const driveName = drive?.name || "Shared Drive";
      setCurrentFolderId(newSection);
      setBreadcrumbs([{ id: newSection, name: driveName }]);
      void loadSectionFolders(newSection);
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
      {/* ── Scope Warning Banner ── */}
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

      {/* ── Location Selector & Breadcrumb Toolbar ── */}
      <div className="p-2 border-b border-[var(--border)] bg-[#12141d] flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={navigateUp}
          disabled={breadcrumbs.length <= 1 || loading}
          title="Up one folder level"
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)] disabled:opacity-30 disabled:pointer-events-none transition-colors shrink-0"
        >
          <ArrowUp size={14} />
        </button>

        {/* Section Switcher: My Drive / Shared with me / Shared Drives */}
        <select
          value={activeSection}
          onChange={(e) => handleSectionChange(e.target.value)}
          className="bg-[#090a0e] text-xs text-white border border-[var(--border)] rounded px-2.5 py-1 outline-none font-medium shrink-0 cursor-pointer hover:border-zinc-500"
        >
          <option value="my_drive">📁 My Drive (Personal)</option>
          <option value="shared_with_me">👥 Shared with me</option>
          {sharedDrives.map((d) => (
            <option key={d.id} value={d.id}>
              🏢 {d.name} (Shared Drive)
            </option>
          ))}
        </select>

        {/* Breadcrumb address path */}
        <div className="flex-1 min-w-[140px] flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#090a0e] border border-[var(--border)] overflow-x-auto select-none">
          {activeSection === "shared_with_me" ? (
            <Users size={13} className="text-emerald-400 shrink-0 mr-0.5" />
          ) : (
            <HardDrive size={13} className="text-blue-400 shrink-0 mr-0.5" />
          )}
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
            "p-1.5 rounded-md transition-colors flex items-center gap-1 text-xs shrink-0",
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
          onClick={() => void loadSectionFolders(activeSection, true)}
          disabled={loading}
          title="Refresh folder listing"
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)] disabled:opacity-40 transition-colors shrink-0"
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
            placeholder={`Filter ${currentFolder.name}...`}
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

      {/* ── Folder List View ── */}
      <div className="min-h-[170px] max-h-[220px] overflow-y-auto p-1.5 space-y-0.5 divide-y divide-white/[0.03]">
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 text-zinc-500">
            <RefreshCw size={18} className="animate-spin text-blue-400" />
            <span className="text-xs">
              Loading {activeSection === "shared_with_me" ? "shared folders" : "My Drive folders"}...
            </span>
          </div>
        ) : error ? (
          <div className="p-4 text-center space-y-2">
            <AlertCircle size={20} className="mx-auto text-amber-400/80" />
            <p className="text-xs text-zinc-400 leading-relaxed break-words">{error}</p>
            <button
              type="button"
              onClick={() => void loadSectionFolders(activeSection, true)}
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
                : activeSection === "shared_with_me"
                ? "No folders shared with you."
                : "No folders found in your My Drive."}
            </p>
            <div className="flex items-center justify-center gap-2 pt-1 flex-wrap">
              {activeSection === "my_drive" && (
                <button
                  type="button"
                  onClick={() => setIsCreatingFolder(true)}
                  className="text-xs px-2.5 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-500/30 inline-flex items-center gap-1.5 font-medium"
                >
                  <FolderPlus size={13} />
                  <span>+ Create Folder in My Drive</span>
                </button>
              )}
              {activeSection === "my_drive" && (
                <button
                  type="button"
                  onClick={() => handleSectionChange("shared_with_me")}
                  className="text-xs px-2.5 py-1 rounded bg-[var(--surface-2)] text-zinc-300 hover:text-white border border-[var(--border)] inline-flex items-center gap-1.5"
                >
                  <Users size={13} />
                  <span>View Shared with me</span>
                </button>
              )}
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
                  {folder.shared || activeSection === "shared_with_me" ? (
                    <Users size={15} className="text-emerald-400 shrink-0" />
                  ) : (
                    <Folder
                      size={15}
                      className="text-amber-400 fill-amber-400/20 shrink-0"
                    />
                  )}
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
