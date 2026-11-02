/**
 * Settings screen — Account, General, Advanced (collapsed).
 */
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "@/store";
import {
  getConfig, updateConfig,
  authLogin, authLogout, authStatus,
  appdataSyncNow,
  updateGetState, updateCheck, updateInstall,
  type UpdateStatePayload,
} from "@/lib/tauri";
import type { Config } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, ShieldCheck, LogOut, RefreshCw, Sparkles, ArrowDownCircle } from "lucide-react";
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
  const userProfile = useStore((s) => s.userProfile);
  const setUserProfile = useStore((s) => s.setUserProfile);
  const config = useStore((s) => s.config);

  const [local, setLocal] = useState<Config | null>(config);
  const [saving, setSaving] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [syncingAppData, setSyncingAppData] = useState(false);
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);

  const refresh = useCallback(async () => {
    const [cfg, a, uState] = await Promise.all([
      getConfig(),
      authStatus(),
      updateGetState().catch(() => null),
    ]);
    setConfig(cfg);
    setLocal(cfg);
    setAuthed(a.logged_in);
    setUserProfile(a.user ?? null);
    if (uState) setUpdateState(uState);

    if (a.logged_in) {
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
  }, [setConfig, setAuthed, setUserProfile]);

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
      const a = await authStatus();
      setAuthed(a.logged_in);
      setUserProfile(a.user ?? null);
      toast.success("Signed in with Google");
    } catch (e) {
      toast.error(`Login failed: ${String(e)}`);
    }
  }

  async function handleLogout() {
    try {
      await authLogout();
      setAuthed(false);
      setUserProfile(null);
      setQuota(null);
      toast.success("Signed out");
    } catch (e) {
      toast.error(`Logout failed: ${String(e)}`);
    }
  }

  async function handleAppDataSync() {
    setSyncingAppData(true);
    try {
      await appdataSyncNow();
      toast.success("Settings synchronized with Google Drive AppData.");
    } catch (e) {
      toast.error(`Sync failed: ${String(e)}`);
    } finally {
      setSyncingAppData(false);
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

  async function handleCheckUpdate() {
    setCheckingUpdate(true);
    try {
      const res = await updateCheck();
      setUpdateState(res);
      if (res.ready_version) {
        toast.success(`Twin v${res.ready_version} is ready to install!`);
      } else if (res.status.status === "up-to-date") {
        toast.info("Twin is up to date.");
      }
    } catch (e) {
      toast.error(`Update check failed: ${String(e)}`);
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleInstallUpdate() {
    setInstallingUpdate(true);
    try {
      toast.info("Applying update and restarting Twin...");
      await updateInstall();
    } catch (e) {
      toast.error(`Failed to install update: ${String(e)}`);
      setInstallingUpdate(false);
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
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 18px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            gap: 16,
          }}>
            {authed ? (
              <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
                {userProfile?.picture ? (
                  <img
                    src={userProfile.picture}
                    alt={userProfile.name ?? "User"}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: "50%",
                      objectFit: "cover",
                      border: "1px solid var(--border)",
                      flexShrink: 0,
                    }}
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div style={{
                    width: 44,
                    height: 44,
                    borderRadius: "50%",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 600,
                    fontSize: 16,
                    color: "var(--accent)",
                    flexShrink: 0,
                  }}>
                    {userProfile?.name ? userProfile.name[0].toUpperCase() : (userProfile?.email ? userProfile.email[0].toUpperCase() : "G")}
                  </div>
                )}

                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#FFFFFF" }}>
                      {userProfile?.name ?? "Google Account"}
                    </span>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: "rgba(34, 197, 94, 0.14)",
                      color: "#4ADE80",
                      border: "1px solid rgba(34, 197, 94, 0.35)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ADE80" }} />
                      Connected
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {userProfile?.email ?? "Signed in"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                    <ShieldCheck size={12} color="#4ADE80" />
                    <span>Privacy-first scopes: <code>drive.file</code> + <code>drive.appdata</code></span>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <span style={{ fontSize: 14, fontWeight: 600, display: "block" }}>
                  Connect Google Account
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, display: "block" }}>
                  Sign in to synchronize files securely using restricted <code>drive.file</code> permissions
                </span>
              </div>
            )}

            {authed ? (
              <Button variant="secondary" size="sm" onClick={handleLogout}>
                <LogOut size={13} style={{ marginRight: 6 }} />
                Sign out
              </Button>
            ) : (
              <Button size="sm" onClick={handleLogin}>Sign in with Google</Button>
            )}
          </div>
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

      {/* Application Updates (JioTV Max pattern) */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Application Updates</h2>

        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 18px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          gap: 16,
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#FFFFFF" }}>
                Twin v{updateState?.current_version ?? "0.1.0"}
              </span>
              {updateState?.ready_version ? (
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "rgba(34, 197, 94, 0.14)",
                  color: "#4ADE80",
                  border: "1px solid rgba(34, 197, 94, 0.35)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}>
                  <Sparkles size={11} />
                  v{updateState.ready_version} Ready
                </span>
              ) : (
                <span style={{
                  fontSize: 11,
                  fontWeight: 500,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "var(--surface-2)",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border)",
                }}>
                  64-bit Windows
                </span>
              )}
            </div>
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, display: "block" }}>
              {updateState?.ready_version
                ? `Version ${updateState.ready_version} has been downloaded in the background. Restart to apply immediately with zero re-install.`
                : updateState?.status.status === "checking" || checkingUpdate
                ? "Checking for new releases..."
                : "Silent in-place background updates enabled (checked every 20m)."}
            </span>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {updateState?.ready_version ? (
              <Button
                size="sm"
                onClick={handleInstallUpdate}
                disabled={installingUpdate}
                style={{ background: "#22C55E", color: "#000", fontWeight: 600 }}
              >
                <ArrowDownCircle size={14} style={{ marginRight: 6 }} />
                {installingUpdate ? "Restarting..." : "Restart & Apply Update"}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCheckUpdate}
                disabled={checkingUpdate}
              >
                <RefreshCw size={13} style={{ marginRight: 6 }} className={checkingUpdate ? "animate-spin" : ""} />
                {checkingUpdate ? "Checking…" : "Check for updates"}
              </Button>
            )}
          </div>
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

            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Cloud Settings Sync</h3>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
              <div>
                <span style={{ fontSize: 13, display: "block" }}>Google Drive AppData</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Settings and device states sync automatically & privately to your Google Drive</span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={syncingAppData || !authed}
                onClick={handleAppDataSync}
              >
                {syncingAppData ? "Syncing…" : "Sync Now"}
              </Button>
            </div>
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

