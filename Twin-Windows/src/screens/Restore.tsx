/**
 * Restore screen — Drive browser, revisions panel, trash sub-tab, restore progress.
 */
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { driveList, listRevisions, restoreFileCmd, listTrash, untrash, keepRevision } from "@/lib/tauri";
import type { DriveFile, Revision, TrashedFile } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { FolderOpen, FileText, ChevronRight, Search, Star, Share2, HardDrive } from "lucide-react";
import { formatBytes, formatRelTime } from "@/lib/format";

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
    <div style={{ padding: 24, maxWidth: 880, width: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 0, borderBottom: "1px solid var(--border)" }}>
        <h1 style={{ fontSize: 16, fontWeight: 600, marginRight: 24 }}>Restore</h1>
        {(["files", "trash"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 12px",
              fontSize: 13,
              color: tab === t ? "var(--text)" : "var(--text-muted)",
              background: "none",
              border: "none",
              borderBottom: `2px solid ${tab === t ? "var(--accent)" : "transparent"}`,
              cursor: "pointer",
              fontWeight: tab === t ? 500 : 400,
            }}
          >
            {t === "files" ? "Files" : "Trash"}
          </button>
        ))}
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
    const name = driveId === "root" ? "My Drive" : (sharedDrives.find((d) => d.id === driveId)?.name ?? "Shared Drive");
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
      toast.success("Share link copied to clipboard!");
    } catch (e) {
      toast.error(`Share link failed: ${String(e)}`);
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
      toast.success("Description saved");
    } catch (e) {
      toast.error(`Save description failed: ${String(e)}`);
    }
  }

  async function handleRestore(file: DriveFile, revId: string | null) {
    const target = dest.trim() || file.name || "restored_file";
    setRestoreProgress(0);
    try {
      await restoreFileCmd(file.id, revId, target);
      setRestoreProgress(100);
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
    } catch (e) {
      toast.error(`Failed to update revision: ${String(e)}`);
    }
  }

  const folders = files.filter((f) => f.mime_type === "application/vnd.google-apps.folder");
  const items   = files.filter((f) => f.mime_type !== "application/vnd.google-apps.folder");

  return (
    <div style={{ display: "flex", gap: 16 }}>
      {/* File list */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Drive selector and search bar */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <HardDrive size={14} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} />
            <select
              value={selectedDrive}
              onChange={(e) => void handleDriveChange(e.target.value)}
              style={{
                fontSize: 13,
                height: 32,
                padding: "0 8px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--surface)",
                color: "var(--text)",
              }}
            >
              <option value="root">My Drive</option>
              {sharedDrives.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: 6, flex: 1, minWidth: 200 }}>
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search Drive files..."
              onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
              style={{ flex: 1 }}
            />
            <Button variant="secondary" size="sm" onClick={() => void handleSearch()}>
              <Search size={13} strokeWidth={1.5} style={{ marginRight: 4 }} />
              Search
            </Button>
            {isSearching && (
              <Button variant="ghost" size="sm" onClick={handleClearSearch}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Root input (fallback) */}
        {!rootId && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <Input
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="Or enter Drive folder ID directly"
              onKeyDown={(e) => { if (e.key === "Enter") void handleBrowse(); }}
              style={{ flex: 1 }}
            />
            <Button onClick={() => void handleBrowse()}>Browse</Button>
          </div>
        )}

        {/* Breadcrumb */}
        {breadcrumb.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
            {breadcrumb.map((bc, i) => (
              <span key={bc.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {i > 0 && <ChevronRight size={12} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} />}
                <button
                  onClick={() => void loadFolder(bc.id, bc.name)}
                  style={{
                    fontSize: 13,
                    color: i === breadcrumb.length - 1 ? "var(--text)" : "var(--accent)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                    fontWeight: i === breadcrumb.length - 1 ? 500 : 400,
                  }}
                >
                  {bc.name}
                </button>
              </span>
            ))}
          </div>
        )}

        {loading ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
        ) : rootId && files.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>This folder is empty.</p>
        ) : (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              overflow: "hidden",
              background: "var(--surface)",
            }}
          >
            {[...folders, ...items].map((file, i) => {
              const isFolder = file.mime_type === "application/vnd.google-apps.folder";
              return (
                <div
                  key={file.id}
                  onClick={() => void handleSelect(file)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 16px",
                    borderBottom: i < files.length - 1 ? "1px solid var(--border)" : "none",
                    cursor: "pointer",
                    fontSize: 13,
                    background: selected?.id === file.id ? "var(--surface-2)" : "var(--surface)",
                    minHeight: 36,
                  }}
                  className="hover:bg-[var(--surface-2)]"
                >
                  {isFolder ? (
                    <FolderOpen size={14} strokeWidth={1.5} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  ) : (
                    <FileText size={14} strokeWidth={1.5} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  )}
                  <span
                    title={file.name ?? file.id}
                    style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {file.name ?? file.id}
                  </span>
                  {file.starred && (
                    <Star size={12} fill="var(--accent)" color="var(--accent)" style={{ flexShrink: 0 }} />
                  )}
                  {file.size && (
                    <span style={{ fontSize: 12, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                      {formatBytes(parseInt(file.size, 10))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Side panel — revisions */}
      {selected && (
        <div
          style={{
            width: 280,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--surface)",
              padding: 16,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
              <p style={{ fontSize: 14, fontWeight: 600, wordBreak: "break-word", margin: 0, flex: 1 }}>
                {selected.name}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleStar}
                title={selected.starred ? "Unstar" : "Star"}
                style={{ padding: 4, height: 28, width: 28 }}
              >
                {selected.starred ? (
                  <Star size={14} fill="var(--accent)" color="var(--accent)" />
                ) : (
                  <Star size={14} style={{ color: "var(--text-muted)" }} />
                )}
              </Button>
            </div>

            {selected.size && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                {formatBytes(parseInt(selected.size, 10))}
              </p>
            )}

            {/* Description metadata */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
                Description
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <Input
                  value={descInput}
                  onChange={(e) => setDescInput(e.target.value)}
                  placeholder="Add a description"
                  style={{ fontSize: 12, height: 28 }}
                />
                <Button variant="secondary" size="sm" onClick={handleSaveDescription} style={{ height: 28, padding: "0 8px", fontSize: 12 }}>
                  Save
                </Button>
              </div>
            </div>

            {/* Copy share link */}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleShareLink}
              style={{ width: "100%", marginBottom: 12, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}
            >
              <Share2 size={13} strokeWidth={1.5} />
              Copy share link
            </Button>

            <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
              Restore destination
            </label>
            <Input
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder={selected.name ?? "destination path"}
              style={{ marginBottom: 8 }}
            />
            <Button onClick={() => void handleRestore(selected, null)} style={{ width: "100%" }}>
              Restore latest
            </Button>
            {restoreProgress !== null && (
              <div style={{ marginTop: 8 }}>
                <Progress value={restoreProgress} aria-label="Restore progress" />
              </div>
            )}
          </div>

          {/* Revisions list */}
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--surface)",
              overflow: "hidden",
            }}
          >
            <p style={{ fontSize: 13, fontWeight: 600, padding: "10px 16px 8px", borderBottom: "1px solid var(--border)", margin: 0 }}>
              Revisions
            </p>
            {revLoading ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)", padding: 16 }}>Loading…</p>
            ) : revisions.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)", padding: 16 }}>No revisions.</p>
            ) : (
              revisions.map((rev, i) => (
                <div
                  key={rev.id}
                  style={{
                    padding: "8px 16px",
                    borderBottom: i < revisions.length - 1 ? "1px solid var(--border)" : "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {rev.modified_time ? formatRelTime(new Date(rev.modified_time).getTime()) : "Unknown date"}
                    </span>
                    {rev.size && (
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {formatBytes(parseInt(rev.size, 10))}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                      <Switch
                        checked={rev.keep_forever ?? false}
                        onCheckedChange={(v) => void handleKeepForever(selected.id, rev.id, v)}
                      />
                      Keep forever
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleRestore(selected, rev.id)}
                    >
                      Restore
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
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
    } catch (e) {
      toast.error(`Failed to restore: ${String(e)}`);
    }
  }

  if (loading) return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>;
  if (items.length === 0) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Trash is empty.</p>;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      {items.map((file, i) => (
        <div
          key={file.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            borderBottom: i < items.length - 1 ? "1px solid var(--border)" : "none",
            minHeight: 36,
          }}
          className="hover:bg-[var(--surface-2)]"
        >
          <FileText size={14} strokeWidth={1.5} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name ?? file.id}
          </span>
          {file.size && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {formatBytes(parseInt(file.size, 10))}
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={() => void handleUntrash(file.id)}>
            Restore
          </Button>
        </div>
      ))}
    </div>
  );
}
