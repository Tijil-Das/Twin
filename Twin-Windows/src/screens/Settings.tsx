/**
 * Settings & Preferences Screen
 * Desktop preference panes for Google account, storage quota,
 * concurrency governor, network rules, and background updates.
 */
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "@/store";
import {
  getConfig,
  updateConfig,
  authLogin,
  authLogout,
  authStatus,
  authHasFullScope,
  updateGetState,
  updateCheck,
  updateInstall,
  type UpdateStatePayload,
  type Config,
} from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import gdLogo from "@/assets/gd-icon.png";
import {
  LogOut,
  RefreshCw,
  Sparkles,
  ArrowDownCircle,
  CheckCircle2,
  Save,
  Check,
  Cpu,
  Battery,
  Wifi,
  Shield,
  Layers,
  AlertTriangle,
} from "lucide-react";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

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
  const [hasChanges, setHasChanges] = useState(false);
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [hasFullScope, setHasFullScope] = useState<boolean>(true);
  const [upgradingScope, setUpgradingScope] = useState<boolean>(false);
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
        const [q, full] = await Promise.all([
          invoke<StorageQuota>("get_storage_quota"),
          authHasFullScope(),
        ]);
        setQuota(q);
        setHasFullScope(full);
      } catch {
        // Ignore quota query error
      }
    }

    try {
      const auto = await invoke<boolean>("get_autostart");
      setAutostart(auto);
    } catch {
      // Ignore autostart query error
    }
  }, [setConfig, setAuthed, setUserProfile]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave() {
    if (!local) return;
    setSaving(true);
    try {
      await updateConfig(local);
      const cfg = await getConfig();
      setConfig(cfg);
      setLocal(cfg);
      setHasChanges(false);
      toast.success("Preferences saved successfully");
    } catch (e) {
      toast.error(`Failed to save preferences: ${String(e)}`);
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

  async function handleAutostartToggle(enable: boolean) {
    try {
      await invoke("set_autostart", { enable });
      setAutostart(enable);
      toast.info(enable ? "Twin will start with Windows" : "Windows startup disabled");
    } catch (e) {
      toast.error(`Autostart error: ${String(e)}`);
    }
  }

  async function handleUpgradeScope() {
    setUpgradingScope(true);
    try {
      await authLogin();
      const full = await authHasFullScope();
      setHasFullScope(full);
      toast.success("Google Drive access updated!");
    } catch (e) {
      toast.error(`Re-authorization failed: ${String(e)}`);
    } finally {
      setUpgradingScope(false);
    }
  }

  async function handleCheckUpdate() {
    setCheckingUpdate(true);
    try {
      const res = await updateCheck();
      setUpdateState(res);
      if (res.ready_version) {
        toast.success(`Update v${res.ready_version} Ready`, {
          action: {
            label: "Restart",
            onClick: () => {
              void handleInstallUpdate();
            },
          },
        });
      } else if (res.status.status === "downloading" || res.status.status === "update-available") {
        toast.info(`Downloading update v${(res.status as any).version ?? "available"} in background…`);
      } else if (res.status.status === "up-to-date") {
        toast.info(`Twin is up to date (v${res.current_version})`);
      } else if (res.status.status === "error") {
        toast.error(`Update check error: ${(res.status as any).error}`);
      } else {
        toast.info("Update check completed");
      }
    } catch (e) {
      toast.error(`Update check error: ${String(e)}`);
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleInstallUpdate() {
    setInstallingUpdate(true);
    try {
      toast.info("Applying update and restarting Twin…");
      await updateInstall();
    } catch (e) {
      toast.error(`Failed to apply update: ${String(e)}`);
      setInstallingUpdate(false);
    }
  }

  if (!local) {
    return (
      <div className="p-8 text-center text-[var(--text-muted)] text-sm">
        Loading preferences…
      </div>
    );
  }

  function patchLocal(fn: (c: Config) => Config) {
    setLocal((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      setHasChanges(true);
      return next;
    });
  }

  const quotaPct =
    quota && quota.limit ? Math.min(100, Math.round((quota.usage / quota.limit) * 100)) : 0;

  return (
    <div className="p-7 max-w-3xl w-full mx-auto space-y-7 pb-28">
      {/* Header */}
      <div className="flex items-center justify-between pb-3.5 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-white">
            Preferences
          </h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Manage Google account credentials, concurrency limits, and sync policies.
          </p>
        </div>

        {hasChanges && (
          <Button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2"
          >
            <Save size={14} />
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        )}
      </div>

      {/* 1. Google Account Section */}
      <section className="space-y-2.5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] px-1 flex items-center gap-1.5">
          <img
            src={gdLogo}
            alt="Google Drive"
            style={{ width: 16, height: 16, minWidth: 16, maxWidth: 16 }}
            className="w-4 h-4 object-contain shrink-0"
          />
          <span>Google Account & Drive Storage</span>
        </h2>

        <div className="desktop-card p-5 space-y-4.5">
          {authed ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5 min-w-0">
                  {userProfile?.picture ? (
                    <img
                      src={userProfile.picture}
                      alt={userProfile.name ?? "User"}
                      className="w-10 h-10 rounded-full object-cover border border-white/10 shrink-0"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-blue-600/30 border border-blue-500/30 text-blue-300 font-bold flex items-center justify-center text-sm shrink-0">
                      {userProfile?.name ? userProfile.name[0].toUpperCase() : "G"}
                    </div>
                  )}

                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="font-bold text-sm text-white truncate">
                        {userProfile?.name ?? "Google Account"}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                        <CheckCircle2 size={13} />
                        Connected
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                      {userProfile?.email ?? "Signed in"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2.5">
                  <Button
                    variant="secondary"
                    onClick={handleLogout}
                    className="hover:text-red-400"
                  >
                    <LogOut size={13} />
                    Sign out
                  </Button>
                </div>
              </div>

              {/* Storage Quota */}
              {quota && (
                <div className="pt-3.5 border-t border-[var(--border-subtle)] space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[var(--text-muted)] font-medium flex items-center gap-2">
                      <img
                        src={gdLogo}
                        alt="Google Drive"
                        style={{ width: 14, height: 14, minWidth: 14, maxWidth: 14 }}
                        className="w-3.5 h-3.5 object-contain shrink-0"
                      />
                      Google Drive Storage
                    </span>
                    <span className="code-text text-xs text-white font-semibold">
                      {formatBytes(quota.usage)} of{" "}
                      {quota.limit ? formatBytes(quota.limit) : "Unlimited"} ({quotaPct}%)
                    </span>
                  </div>
                  <Progress value={quotaPct} aria-label="Drive quota" className="h-2" />
                  <div className="flex items-center gap-4 text-xs code-text text-[var(--text-subtle)] pt-0.5">
                    <span>Drive files: {formatBytes(quota.usageInDrive)}</span>
                    <span>Trash: {formatBytes(quota.usageInDriveTrash)}</span>
                  </div>
                </div>
              )}

              {/* Limited Scope Warning & Upgrade Option */}
              {!hasFullScope && authed && (
                <div className="pt-3.5 border-t border-[var(--border-subtle)]">
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-200">
                    <div className="flex items-center gap-2.5 min-w-0 pr-3">
                      <AlertTriangle size={16} className="text-amber-400 shrink-0" />
                      <div className="text-xs">
                        <p className="font-semibold text-amber-300">Limited Drive Scope Active</p>
                        <p className="text-[var(--text-muted)] text-[11px] mt-0.5">
                          Drive folders created outside Twin may be hidden. Upgrade to full Drive scope for seamless folder sync.
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleUpgradeScope}
                      disabled={upgradingScope}
                      className="shrink-0 text-xs font-semibold"
                    >
                      {upgradingScope ? "Authorizing…" : "Upgrade Access"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-bold text-white">
                  Connect Your Google Account
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Sign in with OAuth 2.0 to enable continuous cloud synchronization.
                </p>
              </div>
              <Button onClick={handleLogin}>
                Sign in with Google
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* 2. Concurrency & Performance */}
      <section className="space-y-2.5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Sync Engine & Concurrency
        </h2>

        <div className="desktop-card divide-y divide-[var(--border-subtle)]">
          {/* Autostart */}
          <div className="p-4.5 sm:p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">Launch on System Startup</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Automatically run Twin in the background when logging into Windows.
              </p>
            </div>
            <Switch checked={autostart} onCheckedChange={handleAutostartToggle} />
          </div>

          {/* Parallel Transfers */}
          <div className="p-4.5 sm:p-5 space-y-3">
            <div className="flex items-center justify-between text-xs sm:text-sm">
              <span className="font-semibold text-white flex items-center gap-2">
                <Layers size={15} className="text-[var(--text-subtle)]" />
                Parallel File Workers
              </span>
              <span className="code-text text-xs text-blue-400 font-bold px-2.5 py-1 rounded-md bg-blue-500/10 border border-blue-500/20">
                {local.app.parallel_transfers} concurrent transfers
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={8}
              value={local.app.parallel_transfers}
              onChange={(e) =>
                patchLocal((c) => ({
                  ...c,
                  app: { ...c.app, parallel_transfers: parseInt(e.target.value, 10) },
                }))
              }
              className="w-full h-2 bg-[var(--surface-3)] rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <div className="flex justify-between text-xs code-text text-[var(--text-subtle)]">
              <span>1 (Conservative)</span>
              <span>4 (Recommended)</span>
              <span>8 (Maximum)</span>
            </div>
          </div>

          {/* Bandwidth Limits */}
          <div className="p-4.5 sm:p-5 grid grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold text-white mb-1.5">
                Upload Bandwidth Cap (KB/s)
              </label>
              <Input
                type="number"
                min={0}
                value={local.limits.upload_kbps}
                onChange={(e) =>
                  patchLocal((c) => ({
                    ...c,
                    limits: {
                      ...c.limits,
                      upload_kbps: parseInt(e.target.value, 10) || 0,
                    },
                  }))
                }
                placeholder="0 = Unlimited"
              />
              <span className="text-xs text-[var(--text-subtle)] mt-1.5 block">
                0 = Unlimited transfer speed
              </span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-white mb-1.5">
                Download Bandwidth Cap (KB/s)
              </label>
              <Input
                type="number"
                min={0}
                value={local.limits.download_kbps}
                onChange={(e) =>
                  patchLocal((c) => ({
                    ...c,
                    limits: {
                      ...c.limits,
                      download_kbps: parseInt(e.target.value, 10) || 0,
                    },
                  }))
                }
                placeholder="0 = Unlimited"
              />
              <span className="text-xs text-[var(--text-subtle)] mt-1.5 block">
                0 = Unlimited transfer speed
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 3. System Load & Battery Governor */}
      <section className="space-y-2.5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Power & Governor Rules
        </h2>

        <div className="desktop-card divide-y divide-[var(--border-subtle)]">
          {/* CPU Thresholds */}
          <div className="p-4.5 sm:p-5 grid grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold text-white mb-1.5 flex items-center gap-2">
                <Cpu size={14} className="text-[var(--text-subtle)]" />
                CPU Pause Threshold (%)
              </label>
              <Input
                type="number"
                min={10}
                max={100}
                value={local.governor.cpu_pause_pct}
                onChange={(e) =>
                  patchLocal((c) => ({
                    ...c,
                    governor: {
                      ...c.governor,
                      cpu_pause_pct: parseInt(e.target.value, 10) || 80,
                    },
                  }))
                }
              />
              <span className="text-xs text-[var(--text-subtle)] mt-1.5 block">
                Throttle sync when CPU load exceeds this %
              </span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-white mb-1.5 flex items-center gap-2">
                <Cpu size={14} className="text-[var(--text-subtle)]" />
                CPU Resume Threshold (%)
              </label>
              <Input
                type="number"
                min={10}
                max={100}
                value={local.governor.cpu_resume_pct}
                onChange={(e) =>
                  patchLocal((c) => ({
                    ...c,
                    governor: {
                      ...c.governor,
                      cpu_resume_pct: parseInt(e.target.value, 10) || 50,
                    },
                  }))
                }
              />
              <span className="text-xs text-[var(--text-subtle)] mt-1.5 block">
                Resume sync when CPU drops below this %
              </span>
            </div>
          </div>

          {/* Battery Governor */}
          <div className="p-4.5 sm:p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white flex items-center gap-2">
                <Battery size={15} className="text-[var(--text-subtle)]" />
                Battery Saver Pause
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Pause sync when on battery power below threshold percentage (0 = disable).
              </p>
            </div>
            <div className="w-28">
              <Input
                type="number"
                min={0}
                max={100}
                value={local.governor.battery_pause_pct ?? 0}
                onChange={(e) =>
                  patchLocal((c) => ({
                    ...c,
                    governor: {
                      ...c.governor,
                      battery_pause_pct: parseInt(e.target.value, 10) || 0,
                    },
                  }))
                }
                className="text-center code-text"
              />
            </div>
          </div>

          {/* Metered Network */}
          <div className="p-4.5 sm:p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white flex items-center gap-2">
                <Wifi size={15} className="text-[var(--text-subtle)]" />
                Pause on Metered Connections
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Automatically suspend sync on metered Wi-Fi or cellular connections.
              </p>
            </div>
            <Switch
              checked={local.governor.pause_on_metered}
              onCheckedChange={(v) =>
                patchLocal((c) => ({
                  ...c,
                  governor: { ...c.governor, pause_on_metered: v },
                }))
              }
            />
          </div>
        </div>
      </section>

      {/* 4. Conflict & Deletion Policies */}
      <section className="space-y-2.5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Conflict & Deletion Policy
        </h2>

        <div className="desktop-card p-5 grid grid-cols-2 gap-5">
          <div>
            <label className="block text-xs font-semibold text-white mb-2 flex items-center gap-2">
              <Shield size={14} className="text-[var(--text-subtle)]" />
              Conflict Strategy
            </label>
            <select
              value={local.policy.conflict}
              onChange={(e) =>
                patchLocal((c) => ({
                  ...c,
                  policy: {
                    ...c.policy,
                    conflict: e.target.value as Config["policy"]["conflict"],
                  },
                }))
              }
              className="w-full h-9 px-3 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-xl text-[var(--text)] focus:outline-none focus:border-blue-500/70 cursor-pointer font-medium"
            >
              <option value="newer_wins">Newer Timestamp Wins (Automatic)</option>
              <option value="keep_both">Keep Both (Suffix local file)</option>
              <option value="ask">Interactive Choice (Ask each time)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-white mb-2 flex items-center gap-2">
              <Shield size={14} className="text-[var(--text-subtle)]" />
              Local Deletion Behavior
            </label>
            <select
              value={local.policy.deletion}
              onChange={(e) =>
                patchLocal((c) => ({
                  ...c,
                  policy: {
                    ...c.policy,
                    deletion: e.target.value as Config["policy"]["deletion"],
                  },
                }))
              }
              className="w-full h-9 px-3 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-xl text-[var(--text)] focus:outline-none focus:border-blue-500/70 cursor-pointer font-medium"
            >
              <option value="drive_trash">Move to Google Drive Trash (Safe)</option>
              <option value="ignore">Ignore Remote Deletions</option>
              <option value="delete">Delete Permanently</option>
            </select>
          </div>
        </div>
      </section>

      {/* 5. Application Updates */}
      <section className="space-y-2.5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Software Updates
        </h2>

        <div className="desktop-card p-5 flex items-center justify-between gap-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <span className="font-bold text-sm text-white">
                Twin Desktop v{updateState?.current_version ?? "1.0.0"}
              </span>
              {updateState?.ready_version ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <Sparkles size={13} />
                  v{updateState.ready_version} Ready to Apply
                </span>
              ) : (
                <span className="text-xs code-text px-2 py-0.5 rounded-md bg-[var(--surface-2)] text-[var(--text-subtle)] border border-[var(--border)]">
                  Latest version
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              {updateState?.ready_version
                ? "Update downloaded seamlessly. Click Restart to apply."
                : "Automatic silent background update checks."}
            </p>
          </div>

          <div>
            {updateState?.ready_version ? (
              <Button
                onClick={handleInstallUpdate}
                disabled={installingUpdate}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-2"
              >
                <ArrowDownCircle size={15} />
                {installingUpdate ? "Applying…" : "Restart & Apply"}
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={handleCheckUpdate}
                disabled={checkingUpdate}
                className="flex items-center gap-2"
              >
                <RefreshCw
                  size={14}
                  className={cn("text-[var(--text-muted)]", checkingUpdate && "animate-spin text-blue-400")}
                />
                {checkingUpdate ? "Checking…" : "Check for Updates"}
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Floating Save Banner */}
      {hasChanges && (
        <div className="fixed bottom-7 right-8 z-30 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="shadow-elevation px-5 py-2.5 h-10 text-xs font-bold flex items-center gap-2"
          >
            <Check size={16} strokeWidth={2.5} />
            {saving ? "Saving…" : "Save Preferences"}
          </Button>
        </div>
      )}
    </div>
  );
}
