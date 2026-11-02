/**
 * Settings screen — Account, General, Advanced (collapsed).
 */
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "@/store";
import {
  getConfig, updateConfig,
  authLogin, authLogout, authStatus,
  authSetClientId, authSetClientSecret, authClearCredentials,
} from "@/lib/tauri";
import type { Config } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatBytes } from "@/lib/format";

interface StorageQuota {
  limit: number | null;
  usage: number;
  usageInDrive: number;
  usageInDriveTrash: number;
}

export function SettingsScreen() {
  const setConfig = useStore((s) => s.setConfig);
  const setAuthed = useStore((s) => s.setAuthed);
  const authed = useStore((s) => s.authed);
  const config = useStore((s) => s.config);

  const [local, setLocal] = useState<Config | null>(config);
  const [saving, setSaving] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [autostart, setAutostart] = useState(false);

  const refresh = useCallback(async () => {
    const [cfg, a] = await Promise.all([getConfig(), authStatus()]);
    setConfig(cfg);
    setLocal(cfg);
    setAuthed(a);

    if (a) {
      try {
        const q = await invoke<StorageQuota>("get_storage_quota");
        setQuota(q);
      } catch {
        // Ignore quota error if offline
      }
    }

    try {
      const auto = await invoke<boolean>("get_autostart");
      setAutostart(auto);
    } catch {
      // Ignore autostart query error
    }
  }, [setConfig, setAuthed]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleSave() {
    if (!local) return;
    setSaving(true);
    try {
      await updateConfig(local);
      const cfg = await getConfig();
      setConfig(cfg);
      setLocal(cfg);
    } catch (e) {
      toast.error(`Failed to save settings: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleLogin() {
    try {
      await authLogin();
      setAuthed(true);
    } catch (e) {
      toast.error(`Login failed: ${String(e)}`);
    }
  }

  async function handleLogout() {
    try {
      await authLogout();
      setAuthed(false);
    } catch (e) {
      toast.error(`Logout failed: ${String(e)}`);
    }
  }

  async function handleSetClientId() {
    try {
      await authSetClientId(clientId.trim());
      toast.error(""); // clear errors
    } catch (e) {
      toast.error(`Failed: ${String(e)}`);
    }
  }

  async function handleSetClientSecret() {
    try {
      await authSetClientSecret(clientSecret.trim());
    } catch (e) {
      toast.error(`Failed: ${String(e)}`);
    }
  }

  async function handleClearCreds() {
    try {
      await authClearCredentials();
      toast.error("Credentials cleared.");
    } catch (e) {
      toast.error(`Failed: ${String(e)}`);
    }
  }

  async function handleAutostartToggle(enable: boolean) {
    try {
      await invoke("set_autostart", { enable });
      setAutostart(enable);
    } catch (e) {
      toast.error(`Autostart error: ${String(e)}`);
    }
  }

  if (!local) return <p style={{ padding: 24, color: "var(--text-muted)" }}>Loading…</p>;

  function patchLocal(fn: (c: Config) => Config) {
    setLocal((prev) => prev ? fn(prev) : prev);
  }

  const divider = <div style={{ height: 1, background: "var(--border)", margin: "20px 0" }} />;

  return (
    <div style={{ padding: 24, maxWidth: 640, width: "100%" }}>
      <h1 style={{ fontSize: 16, fontWeight: 600, marginBottom: 20 }}>Settings</h1>

      {/* Account */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Account</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13 }}>
              {authed ? "Signed in to Google" : "Not signed in"}
            </span>
            {authed ? (
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="secondary" size="sm" onClick={handleLogout}>Sign out</Button>
                <Button variant="secondary" size="sm" onClick={handleClearCreds}>Clear credentials</Button>
              </div>
            ) : (
              <Button size="sm" onClick={handleLogin}>Sign in</Button>
            )}
          </div>

          <FieldGroup label="OAuth Client ID">
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                type="password"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Paste client ID"
                style={{ flex: 1 }}
              />
              <Button variant="secondary" size="sm" onClick={handleSetClientId}>Save</Button>
            </div>
          </FieldGroup>

          <FieldGroup label="OAuth Client Secret">
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Paste client secret"
                style={{ flex: 1 }}
              />
              <Button variant="secondary" size="sm" onClick={handleSetClientSecret}>Save</Button>
            </div>
          </FieldGroup>
        </div>
      </section>

      {divider}

      {/* General */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>General</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {quota && (
            <FieldGroup label="Google Drive storage quota">
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span>{formatBytes(quota.usage)} of {quota.limit ? formatBytes(quota.limit) : "Unlimited"}</span>
                  <span>{quota.limit ? `${Math.round((quota.usage / quota.limit) * 100)}%` : ""}</span>
                </div>
                <div style={{ height: 8, width: "100%", background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${quota.limit ? Math.min(100, Math.round((quota.usage / quota.limit) * 100)) : 0}%`,
                      background: "var(--accent)",
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--text-muted)" }}>
                  <span>Drive: {formatBytes(quota.usageInDrive)}</span>
                  <span>Trash: {formatBytes(quota.usageInDriveTrash)}</span>
                </div>
              </div>
            </FieldGroup>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <span style={{ fontSize: 13, display: "block" }}>Start with Windows</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Launch minimized to tray upon login</span>
            </div>
            <Switch
              checked={autostart}
              onCheckedChange={handleAutostartToggle}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <span style={{ fontSize: 13, display: "block" }}>Dry-run mode</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Simulate transfers without disk or Drive writes</span>
            </div>
            <Switch
              checked={Boolean((local.app as unknown as Record<string, unknown>).dry_run)}
              onCheckedChange={(v) => patchLocal((c) => ({ ...c, app: { ...c.app, dry_run: v } as unknown as typeof c.app }))}
            />
          </div>

          <FieldGroup label={`Parallel transfers: ${local.app.parallel_transfers}`}>
            <input
              type="range"
              min={1}
              max={8}
              value={local.app.parallel_transfers}
              onChange={(e) =>
                patchLocal((c) => ({ ...c, app: { ...c.app, parallel_transfers: parseInt(e.target.value, 10) } }))
              }
              style={{ width: "100%", accentColor: "var(--accent)" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-muted)" }}>
              <span>1</span><span>8</span>
            </div>
          </FieldGroup>
        </div>
      </section>

      {divider}

      {/* Advanced (collapsed) */}
      <section>
        <button
          onClick={() => setAdvOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 14,
            fontWeight: 600,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text)",
            padding: 0,
            marginBottom: advOpen ? 16 : 0,
          }}
          aria-expanded={advOpen}
        >
          {advOpen ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
          Advanced
        </button>

        {advOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <FieldGroup label="Include patterns (one per line)">
              <textarea
                rows={3}
                value={(((local as unknown as Record<string, unknown>).rules as Record<string, string[]>)?.include || []).join("\n")}
                onChange={(e) => {
                  const lines = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                  patchLocal((c) => {
                    const r = ((c as unknown as Record<string, unknown>).rules as Record<string, unknown>) || { exclude: [], max_file_mb: 0 };
                    return {
                      ...c,
                      rules: {
                        ...r,
                        include: lines,
                      },
                    } as unknown as typeof c;
                  });
                }}
                placeholder="*.md&#10;*.txt"
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  fontSize: 12,
                  fontFamily: '"Cascadia Mono", Consolas, monospace',
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--surface)",
                  color: "var(--text)",
                  resize: "vertical",
                }}
              />
            </FieldGroup>

            <FieldGroup label="Exclude patterns (one per line)">
              <textarea
                rows={3}
                value={(((local as unknown as Record<string, unknown>).rules as Record<string, string[]>)?.exclude || []).join("\n")}
                onChange={(e) => {
                  const lines = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                  patchLocal((c) => {
                    const r = ((c as unknown as Record<string, unknown>).rules as Record<string, unknown>) || { include: [], max_file_mb: 0 };
                    return {
                      ...c,
                      rules: {
                        ...r,
                        exclude: lines,
                      },
                    } as unknown as typeof c;
                  });
                }}
                placeholder=".git&#10;node_modules&#10;*.tmp"
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  fontSize: 12,
                  fontFamily: '"Cascadia Mono", Consolas, monospace',
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--surface)",
                  color: "var(--text)",
                  resize: "vertical",
                }}
              />
            </FieldGroup>

            <FieldGroup label="Upload limit (KB/s, 0 = unlimited)">
              <Input
                type="number"
                min={0}
                value={local.limits.upload_kbps}
                onChange={(e) =>
                  patchLocal((c) => ({ ...c, limits: { ...c.limits, upload_kbps: parseInt(e.target.value, 10) || 0 } }))
                }
              />
            </FieldGroup>

            <FieldGroup label="Download limit (KB/s, 0 = unlimited)">
              <Input
                type="number"
                min={0}
                value={local.limits.download_kbps}
                onChange={(e) =>
                  patchLocal((c) => ({ ...c, limits: { ...c.limits, download_kbps: parseInt(e.target.value, 10) || 0 } }))
                }
              />
            </FieldGroup>

            <FieldGroup label="Active hours (e.g. 08:00-18:00, blank = always)">
              <Input
                value={local.limits.active_hours ?? ""}
                onChange={(e) =>
                  patchLocal((c) => ({ ...c, limits: { ...c.limits, active_hours: e.target.value || null } }))
                }
                placeholder="08:00-18:00"
              />
            </FieldGroup>

            <FieldGroup label="Conflict policy">
              <select
                value={local.policy.conflict}
                onChange={(e) =>
                  patchLocal((c) => ({ ...c, policy: { ...c.policy, conflict: e.target.value as Config["policy"]["conflict"] } }))
                }
                style={selectStyle}
              >
                <option value="newer_wins">Newer wins</option>
                <option value="keep_both">Keep both</option>
                <option value="ask">Ask</option>
              </select>
            </FieldGroup>

            <FieldGroup label="Deletion policy">
              <select
                value={local.policy.deletion}
                onChange={(e) =>
                  patchLocal((c) => ({ ...c, policy: { ...c.policy, deletion: e.target.value as Config["policy"]["deletion"] } }))
                }
                style={selectStyle}
              >
                <option value="ignore">Ignore</option>
                <option value="drive_trash">Move to Drive trash</option>
                <option value="delete">Delete permanently</option>
              </select>
            </FieldGroup>

            <FieldGroup label="CPU pause threshold (%)">
              <Input
                type="number"
                min={10}
                max={100}
                value={local.governor.cpu_pause_pct}
                onChange={(e) =>
                  patchLocal((c) => ({ ...c, governor: { ...c.governor, cpu_pause_pct: parseInt(e.target.value, 10) || 80 } }))
                }
              />
            </FieldGroup>

            <FieldGroup label="CPU resume threshold (%)">
              <Input
                type="number"
                min={10}
                max={100}
                value={local.governor.cpu_resume_pct}
                onChange={(e) =>
                  patchLocal((c) => ({ ...c, governor: { ...c.governor, cpu_resume_pct: parseInt(e.target.value, 10) || 50 } }))
                }
              />
            </FieldGroup>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13 }}>Pause on metered network</span>
              <Switch
                checked={local.governor.pause_on_metered}
                onCheckedChange={(v) =>
                  patchLocal((c) => ({ ...c, governor: { ...c.governor, pause_on_metered: v } }))
                }
              />
            </div>

            {divider}

            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>GitHub sync</h3>
            <FieldGroup label="Repository (owner/repo)">
              <Input
                value={local.github.repo}
                onChange={(e) => patchLocal((c) => ({ ...c, github: { ...c.github, repo: e.target.value } }))}
                placeholder="you/repo"
              />
            </FieldGroup>
            <FieldGroup label="Branch">
              <Input
                value={local.github.branch}
                onChange={(e) => patchLocal((c) => ({ ...c, github: { ...c.github, branch: e.target.value } }))}
                placeholder="main"
              />
            </FieldGroup>
          </div>
        )}
      </section>

      {divider}

      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </Button>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  height: 32,
  padding: "0 8px",
  fontSize: 13,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text)",
};

