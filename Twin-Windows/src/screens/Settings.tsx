/**
 * Pro Settings Screen — Google Account & Drive Quota, Governor controls,
 * Bandwidth & Sync Rules, and JioTV Max Autonomous In-Place Updater.
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
  appdataSyncNow,
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
import {
  LogOut,
  RefreshCw,
  Sparkles,
  ArrowDownCircle,
  CheckCircle2,
  Save,
  Check,
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
      toast.success("Settings saved and reloaded live");
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
      toast.success("Settings synchronized with Google Drive AppData");
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
      toast.info(enable ? "Twin will start with Windows" : "Windows startup disabled");
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
        toast.success(`Twin v${res.ready_version} is downloaded and ready to apply!`);
      } else if (res.status.status === "up-to-date") {
        toast.info("Twin is up to date");
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
      toast.info("Applying update and restarting Twin...");
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
    <div className="p-6 max-w-3xl w-full mx-auto space-y-7 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-[var(--text)]">Preferences</h1>
          <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
            Configure Google Drive account, bandwidth thresholds, and governor rules.
          </p>
        </div>

        {hasChanges && (
          <Button
            onClick={handleSave}
            disabled={saving}
            size="sm"
            className="bg-blue-600 hover:bg-blue-500 flex items-center gap-1.5"
          >
            <Save size={13} />
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        )}
      </div>

      {/* 1. Account Section */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Google Cloud Account
        </h2>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          {authed ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  {userProfile?.picture ? (
                    <img
                      src={userProfile.picture}
                      alt={userProfile.name ?? "User"}
                      className="w-10 h-10 rounded-full object-cover border border-[var(--border)] shrink-0"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-bold flex items-center justify-center text-sm shrink-0">
                      {userProfile?.name ? userProfile.name[0].toUpperCase() : "G"}
                    </div>
                  )}

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[13.5px] text-[var(--text)] truncate">
                        {userProfile?.name ?? "Google Account"}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <CheckCircle2 size={11} />
                        Connected
                      </span>
                    </div>
                    <p className="text-[12px] text-[var(--text-muted)] truncate">
                      {userProfile?.email ?? "Signed in"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleAppDataSync}
                    disabled={syncingAppData}
                    title="Sync preferences with Google Drive AppData folder"
                  >
                    <RefreshCw size={13} className={cn("mr-1.5 text-blue-400", syncingAppData && "animate-spin")} />
                    {syncingAppData ? "Syncing…" : "Sync AppData"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleLogout}
                    className="hover:text-red-400"
                  >
                    <LogOut size={13} className="mr-1.5" />
                    Sign out
                  </Button>
                </div>
              </div>

              {/* Storage Quota bar */}
              {quota && (
                <div className="pt-3 border-t border-[var(--border)] space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[var(--text-muted)]">Google Drive Storage</span>
                    <span className="font-mono text-[var(--text)]">
                      {formatBytes(quota.usage)} of{" "}
                      {quota.limit ? formatBytes(quota.limit) : "Unlimited"} ({quotaPct}%)
                    </span>
                  </div>
                  <Progress value={quotaPct} aria-label="Drive quota" />
                  <div className="flex items-center gap-4 text-[11px] text-[var(--text-muted)] pt-0.5">
                    <span>Drive: {formatBytes(quota.usageInDrive)}</span>
                    <span>Trash: {formatBytes(quota.usageInDriveTrash)}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-[13px] font-semibold text-[var(--text)]">
                  Connect Your Google Account
                </p>
                <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
                  Sign in with OAuth 2.0 for continuous two-way Google Drive synchronization.
                </p>
              </div>
              <Button onClick={handleLogin} size="sm" className="bg-blue-600 hover:bg-blue-500">
                Sign in with Google
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* 2. Autonomous Background Updater (JioTV Max Pattern) */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Application Updates
        </h2>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[13.5px] text-[var(--text)]">
                Twin Desktop v{updateState?.current_version ?? "1.0.0"}
              </span>
              {updateState?.ready_version ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <Sparkles size={11} />
                  v{updateState.ready_version} Downloaded & Ready
                </span>
              ) : (
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-[var(--surface-2)] text-[var(--text-muted)] border border-[var(--border)]">
                  Up to date
                </span>
              )}
            </div>
            <p className="text-[12px] text-[var(--text-muted)]">
              {updateState?.ready_version
                ? "Update downloaded silently in background. Click below to restart and apply instantly."
                : "Continuous in-place updates. Checks GitHub releases automatically in the background."}
            </p>
          </div>

          <div>
            {updateState?.ready_version ? (
              <Button
                size="sm"
                onClick={handleInstallUpdate}
                disabled={installingUpdate}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1.5"
              >
                <ArrowDownCircle size={14} />
                {installingUpdate ? "Applying..." : "Restart & Apply"}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCheckUpdate}
                disabled={checkingUpdate}
                className="flex items-center gap-1.5"
              >
                <RefreshCw size={13} className={cn("text-blue-400", checkingUpdate && "animate-spin")} />
                {checkingUpdate ? "Checking…" : "Check for Updates"}
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* 3. System & Concurrency */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          System & Engine Governor
        </h2>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)] shadow-sm">
          {/* Autostart */}
          <div className="p-4 flex items-center justify-between">
            <div>
              <p className="text-[13px] font-medium text-[var(--text)]">Launch with Windows</p>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Automatically start Twin minimized in the system tray when logging in.
              </p>
            </div>
            <Switch checked={autostart} onCheckedChange={handleAutostartToggle} />
          </div>

          {/* Parallel Transfers */}
          <div className="p-4 space-y-2">
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-medium text-[var(--text)]">
                Parallel Transfers: {local.app.parallel_transfers}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                Max concurrent file workers
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
              className="w-full h-1.5 bg-[var(--surface-2)] rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <div className="flex justify-between text-[11px] font-mono text-[var(--text-muted)]">
              <span>1 worker</span>
              <span>4</span>
              <span>8 workers</span>
            </div>
          </div>

          {/* Bandwidth Limits */}
          <div className="p-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-medium text-[var(--text)] mb-1">
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
              <span className="text-[10.5px] text-[var(--text-muted)] mt-1 block">
                0 = Unlimited
              </span>
            </div>

            <div>
              <label className="block text-[12px] font-medium text-[var(--text)] mb-1">
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
              <span className="text-[10.5px] text-[var(--text-muted)] mt-1 block">
                0 = Unlimited
              </span>
            </div>
          </div>

          {/* CPU Governor Thresholds */}
          <div className="p-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-medium text-[var(--text)] mb-1">
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
              <span className="text-[10.5px] text-[var(--text-muted)] mt-1 block">
                Pause sync when system CPU exceeds this %
              </span>
            </div>

            <div>
              <label className="block text-[12px] font-medium text-[var(--text)] mb-1">
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
              <span className="text-[10.5px] text-[var(--text-muted)] mt-1 block">
                Resume sync when CPU drops below this %
              </span>
            </div>
          </div>

          {/* Metered Network */}
          <div className="p-4 flex items-center justify-between">
            <div>
              <p className="text-[13px] font-medium text-[var(--text)]">
                Pause on Metered Connections
              </p>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Automatically suspend sync when connected to cellular or metered Wi-Fi.
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
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Conflict & Deletion Policy
        </h2>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[12px] font-medium text-[var(--text)] mb-1.5">
              Conflict Resolution
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
              className="w-full h-9 px-3 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-blue-500/60"
            >
              <option value="newer_wins">Newer Timestamp Wins (Automatic)</option>
              <option value="keep_both">Keep Both (Suffix with Conflict)</option>
              <option value="ask">Interactive Prompt (Ask User)</option>
            </select>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-[var(--text)] mb-1.5">
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
              className="w-full h-9 px-3 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-blue-500/60"
            >
              <option value="drive_trash">Move to Google Drive Trash (Safe)</option>
              <option value="ignore">Ignore Remote Deletions</option>
              <option value="delete">Delete Permanently</option>
            </select>
          </div>
        </div>
      </section>

      {/* Floating Save Button if changes exist */}
      {hasChanges && (
        <div className="fixed bottom-6 right-8 z-30">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-500 shadow-xl px-5 py-2.5 h-auto text-[13px] font-medium flex items-center gap-2"
          >
            <Check size={15} strokeWidth={2.5} />
            {saving ? "Saving Changes…" : "Save Preferences"}
          </Button>
        </div>
      )}
    </div>
  );
}
