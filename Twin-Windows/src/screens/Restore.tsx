/**
 * Pro Restore & Google Drive Explorer Screen — Drive hierarchy browser,
 * revision history inspector, and trash management.
 */
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  driveList,
  listRevisions,
  restoreFileCmd,
  listTrash,
  untrash,
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
  FolderOpen,
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
  Layers,
  X,
} from "lucide-react";
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

export function RestoreScreen() {
  const [tab, setTab] = useState<Tab>("files");

  return (
    <div className="p-6 max-w-5xl w-full mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-[var(--text)]">
            Drive Explorer & Restore
          </h1>
          <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
            Browse remote Google Drive files, inspect multi-version history, and restore data.
          </p>
        </div>

        {/* Tab switch */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[var(--surface-2)]/80 border border-[var(--border)]">
          <button
            onClick={() => setTab("files")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer flex items-center gap-1.5",
              tab === "files"
                ? "bg-[var(--surface)] text-[var(--text)] shadow-sm font-semibold border border-[var(--border)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            )}
          >
            <Folder size={13} className="text-blue-400" />
            Drive Files
          </button>
          <button
            onClick={() => setTab("trash")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer flex items-center gap-1.5",
              tab === "trash"
                ? "bg-[var(--surface)] text-[var(--text)] shadow-sm font-semibold border border-[var(--border)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            )}
          >
            <Trash2 size={13} className="text-red-400" />
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

  useEffect(() => {
    invoke<SharedDrive[]>("list_shared_drives")
      .then((d) => setSharedDrives(d))
      .catch(() => {});
  }, []);

  async function loadFolder(folderId: string, name = "Root") {
    setLoading(true);
    setIsSearching(false);
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
      toast.error(`Star failed: ${String(e)}`);
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
    <div className="flex gap-5">
      {/* Main File List Container */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Drive & Search bar */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <HardDrive size={14} className="text-blue-400" />
            <select
              value={selectedDrive}
              onChange={(e) => void handleDriveChange(e.target.value)}
              className="h-8 px-2 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none"
            >
              <option value="root">My Drive</option>
              {sharedDrives.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 flex-1">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-2.5 text-[var(--text-muted)]" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files in Google Drive..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                }}
                className="pl-8 text-xs h-8"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={() => void handleSearch()}>
              Search
            </Button>
            {isSearching && (
              <Button variant="ghost" size="sm" onClick={handleClearSearch}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Fallback Folder ID input if not opened */}
        {!rootId && (
          <div className="p-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex items-center gap-3 shadow-sm">
            <Input
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="Enter Google Drive Folder ID directly (or browse My Drive above)"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleBrowse();
              }}
              className="text-xs font-mono h-8"
            />
            <Button onClick={() => void handleBrowse()} size="sm" className="bg-blue-600 hover:bg-blue-500">
              Open Folder
            </Button>
          </div>
        )}

        {/* Breadcrumb Navigation */}
        {breadcrumb.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] py-1 overflow-x-auto">
            {breadcrumb.map((bc, i) => (
              <span key={bc.id} className="flex items-center gap-1.5 shrink-0">
                {i > 0 && <ChevronRight size={12} className="text-[var(--text-subtle)]" />}
                <button
                  onClick={() => void loadFolder(bc.id, bc.name)}
                  className={cn(
                    "hover:text-blue-400 transition-colors px-1.5 py-0.5 rounded",
                    i === breadcrumb.length - 1
                      ? "font-semibold text-[var(--text)] bg-[var(--surface-2)]"
                      : "text-blue-400"
                  )}
                >
                  {bc.name}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* File Browser Table */}
        {loading ? (
          <div className="p-12 text-center text-[var(--text-muted)] text-xs flex items-center justify-center gap-2">
            <RefreshCw size={14} className="animate-spin text-blue-400" />
            Loading folder contents…
          </div>
        ) : rootId && files.length === 0 ? (
          <div className="p-10 text-center text-[var(--text-muted)] text-xs rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)]">
            This Google Drive folder is empty.
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-sm">
            {[...folders, ...items].map((file) => {
              const isFolder = file.mime_type === "application/vnd.google-apps.folder";
              const isSelected = selected?.id === file.id;
              return (
                <div
                  key={file.id}
                  onClick={() => void handleSelect(file)}
                  className={cn(
                    "flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-subtle)] last:border-b-0 cursor-pointer text-xs transition-colors",
                    isSelected
                      ? "bg-blue-600/12 text-blue-300 font-medium"
                      : "hover:bg-[var(--surface-2)] text-[var(--text)]"
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    {isFolder ? (
                      <Folder size={15} className="text-amber-400 shrink-0" />
                    ) : (
                      <FileText size={15} className="text-blue-400 shrink-0" />
                    )}
                    <span className="truncate font-mono" title={file.name ?? file.id}>
                      {file.name ?? file.id}
                    </span>
                    {file.starred && (
                      <Star size={11} className="fill-amber-400 text-amber-400 shrink-0" />
                    )}
                  </div>

                  <div className="flex items-center gap-3 shrink-0 text-[11px] font-mono text-[var(--text-muted)]">
                    {file.size && <span>{formatBytes(parseInt(file.size, 10))}</span>}
                    {isFolder && <span className="text-[10px] text-zinc-500 uppercase">Folder</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Side Inspector Drawer (Revisions & File Details) */}
      {selected && (
        <aside className="w-72 shrink-0 space-y-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-xs text-[var(--text)] break-all leading-tight">
                  {selected.name}
                </p>
                {selected.size && (
                  <p className="text-[11px] font-mono text-[var(--text-muted)] mt-1">
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
                  size={14}
                  className={cn(
                    selected.starred ? "fill-amber-400 text-amber-400" : "text-[var(--text-muted)]"
                  )}
                />
              </Button>
            </div>

            {/* Description */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-[var(--text-muted)]">
                Notes / Description
              </label>
              <div className="flex gap-2">
                <Input
                  value={descInput}
                  onChange={(e) => setDescInput(e.target.value)}
                  placeholder="Add note..."
                  className="text-xs h-7"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSaveDescription}
                  className="h-7 text-xs"
                >
                  Save
                </Button>
              </div>
            </div>

            {/* Share link button */}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleShareLink}
              className="w-full flex items-center justify-center gap-1.5 text-xs"
            >
              <Share2 size={13} />
              Copy Google Share Link
            </Button>

            {/* Restore target input */}
            <div className="pt-2 border-t border-[var(--border)] space-y-2">
              <label className="text-[11px] font-medium text-[var(--text-muted)]">
                Local Restore Destination
              </label>
              <Input
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder={selected.name ?? "Target path..."}
                className="text-xs font-mono h-8"
              />
              <Button
                onClick={() => void handleRestore(selected, null)}
                className="w-full bg-blue-600 hover:bg-blue-500 text-xs flex items-center justify-center gap-1.5"
              >
                <Download size={13} />
                Restore Latest Version
              </Button>

              {restoreProgress !== null && (
                <div className="mt-2">
                  <Progress value={restoreProgress} aria-label="Restore progress" />
                </div>
              )}
            </div>
          </div>

          {/* Revisions History Drawer */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-sm">
            <div className="px-3 py-2 bg-[var(--surface-2)] border-b border-[var(--border)] flex items-center gap-1.5">
              <Clock size={12} className="text-blue-400" />
              <span className="text-[11.5px] font-semibold text-[var(--text)]">
                Revisions ({revisions.length})
              </span>
            </div>

            <div className="divide-y divide-[var(--border-subtle)] max-h-60 overflow-y-auto">
              {revLoading ? (
                <div className="p-4 text-center text-[var(--text-muted)] text-xs">
                  Loading history…
                </div>
              ) : revisions.length === 0 ? (
                <div className="p-4 text-center text-[var(--text-muted)] text-xs">
                  Single version recorded.
                </div>
              ) : (
                revisions.map((rev) => (
                  <div key={rev.id} className="p-3 text-xs space-y-1.5">
                    <div className="flex items-center justify-between font-mono text-[11px]">
                      <span className="text-[var(--text)]">
                        {rev.modified_time
                          ? formatRelTime(new Date(rev.modified_time).getTime())
                          : "Unknown"}
                      </span>
                      {rev.size && (
                        <span className="text-[var(--text-muted)]">
                          {formatBytes(parseInt(rev.size, 10))}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <label className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5 cursor-pointer">
                        <Switch
                          checked={rev.keep_forever ?? false}
                          onCheckedChange={(v) =>
                            void handleKeepForever(selected.id, rev.id, v)
                          }
                        />
                        Lock
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRestore(selected, rev.id)}
                        className="h-6 px-2 text-[11px] text-blue-400 hover:text-blue-300"
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
    </div>
  );
}

// ── Trash browser ─────────────────────────────────────────────────────────────

function TrashBrowser() {
  const [items, setItems] = useState<TrashedFile[]>([]);
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return (
      <div className="p-12 text-center text-[var(--text-muted)] text-xs flex items-center justify-center gap-2">
        <RefreshCw size={14} className="animate-spin text-blue-400" />
        Loading trash contents…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-12 text-center flex flex-col items-center justify-center space-y-2">
        <Trash2 size={24} className="text-[var(--text-muted)]" />
        <p className="text-[13px] font-medium text-[var(--text)]">Google Drive Trash is Empty</p>
        <p className="text-[11px] text-[var(--text-muted)]">
          Deleted items moved to trash will appear here for recovery.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-sm divide-y divide-[var(--border-subtle)]">
      {items.map((file) => (
        <div
          key={file.id}
          className="flex items-center justify-between px-4 py-3 text-xs hover:bg-[var(--surface-2)] transition-colors"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText size={15} className="text-[var(--text-muted)] shrink-0" />
            <span className="truncate font-mono font-medium text-[var(--text)]">
              {file.name ?? file.id}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {file.size && (
              <span className="font-mono text-[11px] text-[var(--text-muted)]">
                {formatBytes(parseInt(file.size, 10))}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleUntrash(file.id)}
              className="flex items-center gap-1.5 text-xs"
            >
              <RotateCcw size={12} />
              Restore
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
