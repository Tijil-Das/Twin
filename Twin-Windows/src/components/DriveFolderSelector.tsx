/**
 * Windows Explorer style Google Drive folder selector panel.
 * Provides hierarchical breadcrumb navigation, subfolder listing,
 * fast filtering, and 1-click folder targeting.
 */
import { useState, useEffect, useMemo } from "react";
import {
  Folder,
  ChevronRight,
  ArrowUp,
  RefreshCw,
  Search,
  HardDrive,
  Check,
  AlertCircle,
  FolderPlus,
} from "lucide-react";
import { driveList } from "@/lib/tauri";
import type { DriveFile } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface DriveFolder {
  id: string;
  name: string;
  modifiedTime?: string | null;
}

interface BreadcrumbItem {
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
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [activeSelection, setActiveSelection] = useState<{ id: string; name: string } | null>(
    null
  );

  const currentFolder = breadcrumbs[breadcrumbs.length - 1];

  async function fetchFolders(folderId: string) {
    setLoading(true);
    setError(null);
    try {
      const items = await driveList(folderId);
      // Filter for Google Drive folder MIME types
      const folderList: DriveFolder[] = (items || [])
        .filter((item: DriveFile | any) => {
          const mime = item.mime_type || item.mimeType;
          return mime === "application/vnd.google-apps.folder";
        })
        .map((f: DriveFile | any) => ({
          id: f.id,
          name: f.name || "Untitled Folder",
          modifiedTime: f.modified_time || f.modifiedTime,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      setFolders(folderList);
    } catch (err) {
      setError(
        "Could not load Google Drive folders. Make sure you are authenticated in Settings."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchFolders(currentFolderId);
  }, [currentFolderId]);

  // Navigate deeper into a subfolder
  function enterFolder(folder: DriveFolder) {
    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setFilterQuery("");
  }

  // Navigate up to parent folder
  function navigateUp() {
    if (breadcrumbs.length <= 1) return;
    const parent = breadcrumbs[breadcrumbs.length - 2];
    setBreadcrumbs((prev) => prev.slice(0, prev.length - 1));
    setCurrentFolderId(parent.id);
    setFilterQuery("");
  }

  // Jump directly to an ancestor in the breadcrumbs
  function jumpToBreadcrumb(index: number) {
    if (index >= breadcrumbs.length - 1) return;
    const target = breadcrumbs[index];
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    setCurrentFolderId(target.id);
    setFilterQuery("");
  }

  // Filtered folders
  const displayedFolders = useMemo(() => {
    if (!filterQuery.trim()) return folders;
    const q = filterQuery.toLowerCase();
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, filterQuery]);

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

        {/* Refresh button */}
        <button
          type="button"
          onClick={() => void fetchFolders(currentFolderId)}
          disabled={loading}
          title="Refresh folder listing"
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)] disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin text-blue-400")} />
        </button>
      </div>

      {/* ── Subfolder Filter Bar ── */}
      <div className="px-3 py-1.5 border-b border-[var(--border)] bg-[#10121a] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-zinc-400 text-[11px] font-medium flex-1">
          <Search size={12} className="text-zinc-500 shrink-0" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder={`Filter in ${currentFolder.name}...`}
            className="bg-transparent border-0 outline-none text-xs text-white placeholder:text-zinc-500 w-full"
          />
        </div>
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
            <p className="text-xs text-zinc-400 leading-relaxed">{error}</p>
            <button
              type="button"
              onClick={() => void fetchFolders(currentFolderId)}
              className="text-xs text-blue-400 hover:underline inline-block font-medium"
            >
              Retry Connection
            </button>
          </div>
        ) : displayedFolders.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <FolderPlus size={24} className="mx-auto text-zinc-600" />
            <p className="text-xs text-zinc-500">
              {filterQuery ? "No matching folders found." : "No subfolders in this directory."}
            </p>
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
          <div className="text-[11px] text-zinc-400 truncate max-w-[220px]" title={activeSelection.name}>
            Selected: <span className="font-semibold text-white">{activeSelection.name}</span>
          </div>
        ) : selectedFolderId ? (
          <div className="text-[11px] text-zinc-400 font-mono truncate max-w-[200px]" title={selectedFolderId}>
            ID: <span className="text-zinc-300">{selectedFolderId}</span>
          </div>
        ) : (
          <span className="text-[11px] text-zinc-500">Click a folder to select</span>
        )}
      </div>
    </div>
  );
}
