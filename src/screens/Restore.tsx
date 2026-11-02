/**
 * Restore screen — Drive browser, revisions panel, trash sub-tab, restore progress.
 */
import { useState, useEffect } from "react";
import { driveList, listRevisions, restoreFileCmd, listTrash, untrash, keepRevision } from "@/lib/tauri";
import type { DriveFile, Revision, TrashedFile } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { FolderOpen, FileText, ChevronRight } from "lucide-react";
import { formatBytes, formatRelTime } from "@/lib/format";

type Tab = "files" | "trash";

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
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<DriveFile | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revLoading, setRevLoading] = useState(false);
  const [dest, setDest] = useState("");
  const [restoreProgress, setRestoreProgress] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadFolder(folderId: string, name = "Root") {
    setLoading(true);
    try {
      const result = await driveList(folderId);
      setFiles(result);
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

  async function handleSelect(file: DriveFile) {
    const isFolder = file.mime_type === "application/vnd.google-apps.folder";
    if (isFolder) {
      await loadFolder(file.id, file.name ?? file.id);
      return;
    }
    setSelected(file);
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
        {/* Root input */}
        {!rootId && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <Input
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="Drive folder ID"
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
            <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, wordBreak: "break-word" }}>
              {selected.name}
            </p>
            {selected.size && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                {formatBytes(parseInt(selected.size, 10))}
              </p>
            )}

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
