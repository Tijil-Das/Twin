/**
 * Windows Explorer style Google Drive folder selector panel.
 * Performs true path-based directory traversal:
 * - Direct subfolder querying per directory level ('parent_id' in parents)
 * - Breadcrumb address bar with clickable ancestors & jump-to-path
 * - Up-one-level navigation (ArrowUp)
 * - Folder caching for instant back/forth browsing
 * - Dedicated "My Drive" and "Shared with me" locations
 * - Direct folder ID / URL jump support
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
  Edit2,
} from "lucide-react";
import {
  driveListSubfolders,
  driveGetFolderMeta,
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

type DriveLocation = "my_drive" | "shared_with_me" | string;

interface Props {
  selectedFolderId: string;
  onSelect: (folderId: string, folderName: string) => void;
  className?: string;
}

export function DriveFolderSelector({ selectedFolderId, onSelect, className }: Props) {
  const [activeLocation, setActiveLocation] = useState<DriveLocation>("my_drive");
  const [currentFolderId, setCurrentFolderId] = useState<string>("root");
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: "root", name: "My Drive" },
  ]);
  const [sharedDrives, setSharedDrives] = useState<SharedDriveItem[]>([]);

  // Directory cache: parentId -> immediate subfolders
  const [directoryCache, setDirectoryCache] = useState<Record<string, DriveFolder[]>>({});

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [activeSelection, setActiveSelection] = useState<{ id: string; name: string } | null>(
    null
  );
  const [hasFullScope, setHasFullScope] = useState<boolean>(true);
  const [reauthorizing, setReauthorizing] = useState(false);

  // Address bar manual edit mode
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [addressInput, setAddressInput] = useState("");

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

  // Fetch immediate subfolders of a specific parent
  const fetchSubfolders = useCallback(
    async (folderId: string, force = false) => {
      if (!force && directoryCache[folderId]) {
        return directoryCache[folderId];
      }

      setLoading(true);
      setError(null);
      try {
        let raw: DriveFile[] = [];

        // If top-level "Shared with me", query shared items
        if (folderId === "shared_with_me") {
          raw = await driveGetSharedFolders();
        } else {
          // Direct path query: immediate children of folderId
          raw = await driveListSubfolders(folderId);
        }

        const folders: DriveFolder[] = (raw || [])
          .filter((f) => {
            const mime = f.mime_type || f.mimeType;
            return (
              mime === "application/vnd.google-apps.folder" ||
              mime === "application/vnd.google-apps.shortcut"
            );
          })
          .map((f) => ({
            id: f.id,
            name: f.name || "Untitled Folder",
            modifiedTime: f.modified_time || f.modifiedTime,
            parents: f.parents || [],
            shared: f.shared || false,
          }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

        setDirectoryCache((prev) => ({ ...prev, [folderId]: folders }));
        return folders;
      } catch (err: unknown) {
        console.error(`[DriveFolderSelector] fetchSubfolders(${folderId}) error:`, err);
        const msg =
          typeof err === "string" ? err : err instanceof Error ? err.message : JSON.stringify(err);
        setError(`Failed to open folder: ${msg}`);
        return [];
      } finally {
        setLoading(false);
      }
    },
    [directoryCache]
  );

  useEffect(() => {
    void fetchSubfolders(currentFolderId);
  }, [currentFolderId, fetchSubfolders]);

  // Current folder's children from cache
  const subfolders = useMemo(() => {
    return directoryCache[currentFolderId] || [];
  }, [directoryCache, currentFolderId]);

  // Filtered by local search query
  const displayedFolders = useMemo(() => {
    if (!filterQuery.trim()) return subfolders;
    const q = filterQuery.toLowerCase();
    return subfolders.filter((f) => f.name.toLowerCase().includes(q));
  }, [subfolders, filterQuery]);

  // Navigate deeper into a clicked subfolder
  function enterFolder(folder: DriveFolder) {
    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setFilterQuery("");
    setIsCreatingFolder(false);
  }

  // Navigate up one folder level
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

  // Switch top-level location (My Drive vs Shared with me vs Shared Drive)
  function handleLocationChange(newLocation: DriveLocation) {
    setActiveLocation(newLocation);
    setFilterQuery("");
    setIsCreatingFolder(false);

    if (newLocation === "my_drive") {
      setCurrentFolderId("root");
      setBreadcrumbs([{ id: "root", name: "My Drive" }]);
      void fetchSubfolders("root", true);
    } else if (newLocation === "shared_with_me") {
      setCurrentFolderId("shared_with_me");
      setBreadcrumbs([{ id: "shared_with_me", name: "Shared with me" }]);
      void fetchSubfolders("shared_with_me", true);
    } else {
      const drive = sharedDrives.find((d) => d.id === newLocation);
      const driveName = drive?.name || "Shared Drive";
      setCurrentFolderId(newLocation);
      setBreadcrumbs([{ id: newLocation, name: driveName }]);
      void fetchSubfolders(newLocation, true);
    }
  }

  // Jump to pasted folder ID or link
  async function handleJumpToAddress() {
    let input = addressInput.trim();
    if (!input) {
      setIsEditingAddress(false);
      return;
    }
    // Parse ID from URL if pasted (e.g. https://drive.google.com/drive/folders/1aBcDeFg...)
    const urlMatch = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) {
      input = urlMatch[1];
    }

    setLoading(true);
    try {
      const meta = await driveGetFolderMeta(input);
      const name = meta.name || "Target Folder";
      setCurrentFolderId(meta.id);
      setBreadcrumbs([{ id: meta.id, name }]);
      setIsEditingAddress(false);
      setAddressInput("");
      selectFolder(meta.id, name);
      void fetchSubfolders(meta.id, true);
    } catch {
      toast.error(`Folder "${input}" not found or inaccessible`);
    } finally {
      setLoading(false);
    }
  }

  // Create new subfolder inside current folder
  async function handleCreateNewFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setCreatingFolder(true);
    try {
      const parentId = currentFolderId === "shared_with_me" ? "root" : currentFolderId;
      const newId = await driveCreateFolder(parentId, name);
      toast.success(`Created folder "${name}"`);
      const newFolder: DriveFolder = {
        id: newId,
        name,
        modifiedTime: new Date().toISOString(),
        parents: [parentId],
        shared: false,
      };
      setDirectoryCache((prev) => ({
        ...prev,
        [parentId]: [newFolder, ...(prev[parentId] || [])],
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
      toast.success("Authentication updated! Refreshing Drive folders...");
      setHasFullScope(true);
      void fetchSubfolders(currentFolderId, true);
    } catch (e) {
      toast.error(`Authorization failed: ${String(e)}`);
    } finally {
      setReauthorizing(false);
    }
  }

  // Select a folder as target
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

      {/* ── Location Selector & Windows Explorer Address Bar ── */}
      <div className="p-2 border-b border-[var(--border)] bg-[#12141d] flex items-center gap-1.5 flex-wrap">
        {/* Up-one-level button */}
        <button
          type="button"
          onClick={navigateUp}
          disabled={breadcrumbs.length <= 1 || loading}
          title="Up one folder level"
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)] disabled:opacity-30 disabled:pointer-events-none transition-colors shrink-0"
        >
          <ArrowUp size={14} />
        </button>

        {/* Location Switcher: My Drive / Shared with me / Shared Drives */}
        <select
          value={activeLocation}
          onChange={(e) => handleLocationChange(e.target.value)}
          className="bg-[#090a0e] text-xs text-white border border-[var(--border)] rounded px-2.5 py-1 outline-none font-medium shrink-0 cursor-pointer hover:border-zinc-500"
        >
          <option value="my_drive">📁 My Drive</option>
          <option value="shared_with_me">👥 Shared with me</option>
          {sharedDrives.map((d) => (
            <option key={d.id} value={d.id}>
              🏢 {d.name}
            </option>
          ))}
        </select>

        {/* Breadcrumb Path or Direct Address Input */}
        {isEditingAddress ? (
          <div className="flex-1 min-w-[180px] flex items-center gap-1">
            <input
              type="text"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleJumpToAddress();
                if (e.key === "Escape") setIsEditingAddress(false);
              }}
              placeholder="Paste Google Drive folder URL or ID..."
              autoFocus
              className="flex-1 bg-[#090a0e] text-xs text-white border border-blue-500 rounded px-2.5 py-1 outline-none font-mono"
            />
            <button
              type="button"
              onClick={handleJumpToAddress}
              className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium"
            >
              Go
            </button>
            <button
              type="button"
              onClick={() => setIsEditingAddress(false)}
              className="p-1 text-zinc-400 hover:text-white"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="flex-1 min-w-[140px] flex items-center justify-between gap-1 px-2.5 py-1 rounded-md bg-[#090a0e] border border-[var(--border)] overflow-x-auto select-none group">
            <div className="flex items-center gap-1 overflow-x-auto">
              {activeLocation === "shared_with_me" ? (
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
            <button
              type="button"
              onClick={() => {
                setAddressInput(currentFolderId === "root" ? "" : currentFolderId);
                setIsEditingAddress(true);
              }}
              title="Edit folder path or paste ID"
              className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-500 hover:text-white transition-opacity"
            >
              <Edit2 size={11} />
            </button>
          </div>
        )}

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
          onClick={() => void fetchSubfolders(currentFolderId, true)}
          disabled={loading}
          title="Refresh current folder"
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
            placeholder={`Create new folder inside "${currentFolder.name}"...`}
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

      {/* ── Subfolder Filter Bar ── */}
      <div className="px-3 py-1.5 border-b border-[var(--border)] bg-[#10121a] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-zinc-400 text-[11px] font-medium flex-1">
          <Search size={12} className="text-zinc-500 shrink-0" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder={`Filter inside "${currentFolder.name}"...`}
            className="bg-transparent border-0 outline-none text-xs text-white placeholder:text-zinc-500 w-full"
          />
        </div>
        <span className="text-[11px] text-zinc-500 shrink-0">
          {displayedFolders.length} subfolder{displayedFolders.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* ── Folder List View ── */}
      <div className="min-h-[170px] max-h-[220px] overflow-y-auto p-1.5 space-y-0.5 divide-y divide-white/[0.03]">
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 text-zinc-500">
            <RefreshCw size={18} className="animate-spin text-blue-400" />
            <span className="text-xs">Opening "{currentFolder.name}"...</span>
          </div>
        ) : error ? (
          <div className="p-4 text-center space-y-2">
            <AlertCircle size={20} className="mx-auto text-amber-400/80" />
            <p className="text-xs text-zinc-400 leading-relaxed break-words">{error}</p>
            <button
              type="button"
              onClick={() => void fetchSubfolders(currentFolderId, true)}
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
                ? `No subfolders matching "${filterQuery}".`
                : `No subfolders inside "${currentFolder.name}".`}
            </p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsCreatingFolder(true)}
                className="text-xs px-2.5 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-500/30 inline-flex items-center gap-1.5 font-medium"
              >
                <FolderPlus size={13} />
                <span>+ Create Subfolder Here</span>
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
                  {folder.shared ? (
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
          <span>Use Current Folder: "{currentFolder.name}"</span>
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
