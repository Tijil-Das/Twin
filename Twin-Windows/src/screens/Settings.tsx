/**
 * Settings & Preferences Screen
 * Desktop preference panes for Google account, storage quota,
 * concurrency governor, network rules, and background updates.
 */
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  getDatabaseStats,
  runDatabaseMaintenance,
  getOverlayStatus,
  setOverlaySettings,
  driveSetFolderColorizerEnabled,
  type DatabaseStats,
  type UpdateStatePayload,
  type Config,
} from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import gdLogo from "@/assets/gd-icon.png";
import {
  LogOut,
  RefreshCw,
  Sparkles,
  ArrowDownCircle,
  CheckCircle2,
  Check,
  Cpu,
  Battery,
  Wifi,
  Shield,
  AlertTriangle,
  Plus,
  X,
  FileCode,
  Database,
  ArrowUp,
  ArrowDown,
  Activity,
  HardDrive,
  Files,
  Copy,
  AlertCircle,
  Trash2,
  Sliders,
  Power,
  Layers,
  Palette,
} from "lucide-react";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

interface StorageQuota {
  limit: number | null;
  usage: number;
  usageInDrive: number;
  usageInDriveTrash: number;
}



/**
 * Windows 11 Explorer Folder with Overlay Badge preview.
 * Uses the exact Windows 11 Fluent folder icon from Twin/Icon-Pack/folder.svg
 * with the overlay badge positioned precisely at the bottom-left corner
 * matching the Windows Shell (IShellIconOverlayIdentifier) composited layout.
 */
function WindowsFolderOverlayPreview({
  badge = "synced",
  className,
}: {
  badge?: "synced" | "syncing";
  className?: string;
}) {
  // Bottom-left shell overlay coordinates aligned with folder.svg
  const cx = 27;
  const cy = 72.5;
  const r = 13;

  const p1 = `${(cx - r * 0.40).toFixed(1)},${(cy + r * 0.04).toFixed(1)}`;
  const p2 = `${(cx - r * 0.12).toFixed(1)},${(cy + r * 0.35).toFixed(1)}`;
  const p3 = `${(cx + r * 0.44).toFixed(1)},${(cy - r * 0.28).toFixed(1)}`;

  return (
    <svg
      viewBox="10 12 94 77"
      className={cn("w-16 h-13 drop-shadow-sm shrink-0 select-none", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter id={`badgeShadow-${badge}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="1.0" floodColor="#000000" floodOpacity="0.45" />
        </filter>
      </defs>

      {/* Windows 11 Fluent Folder Paths from Twin/Icon-Pack/folder.svg */}
      <g id="folder-paths">
        <path fill="#ffd769" d="M70.81 28.05c7.01 -1.53 14.18 -1.2 21.23 -0.63c3.28 -0.08 4.59 0.36 6.79 2.76c0.4 4.86 0.06 9.91 0.16 14.79c-3 3.37 -6.23 4.67 -9.35 7.7c-3.3 2.43 -7.86 4.61 -11.38 6.91c-4.68 2.6 -9.2 5.48 -13.81 8.2c-4.25 2.83 -8.75 5.03 -12.91 8.01c-3.55 2.72 -7.91 4.07 -11.63 6.61c-6.11 0.32 -12.88 0.2 -18.97 0.2c-3 0.08 -3.95 -0.63 -5.85 -2.8c-0.17 -1.88 -0.08 -3.71 -0.09 -5.59c5.23 -2.93 9.05 -6.7 14.18 -9.29c10.77 -6.08 21.35 -12.59 31.79 -19.23c3.75 -2.35 7.74 -4 11.37 -6.64c3.56 -2.57 7.52 -4.32 11.3 -6.64c2.96 -2.29 6.14 -1.34 9.43 -2.82c-6 -0.81 -11.19 0.19 -17.16 0.04c-1.91 0.36 -3.71 0.29 -5.1 -1.58z" />
        <path fill="#ffdd7d" d="M17.89 32.85c4.87 -1.58 10.1 -1.07 15.11 -1.15c4.17 -0.25 9.41 0.7 13.3 -0.77c2.87 -0.79 4.82 -4 7.77 -3.95c5.39 0.02 11.37 -0.41 16.74 1.07c1.79 0.6 3.24 0.84 5.13 0.89c5.96 0.14 11.72 -0.38 17.7 0.59c-3.28 1.48 -6.71 1.06 -9.68 3.35c-3.45 2.79 -7.5 4.43 -11.06 7c-3.62 2.64 -7.66 4.31 -11.41 6.67c-10.44 6.63 -21.06 13.16 -31.82 19.25c-5.14 2.59 -9.02 6.75 -14.67 8.41l0 -36.04c2.06 -3.01 3 -4.86 6.96 -4.58c6.69 -0.01 13.38 -0.1 20.07 -0.18c2.02 0.11 3.1 -0.63 5.36 0.21c-2.34 0.82 -3.24 0.14 -5.33 0.33c-8.06 0.02 -16.1 0.17 -24.17 -1.1z" />
        <path fill="#ffd35a" d="M98.99 44.97c0.03 6 -0.02 11.99 0 17.99c-3.86 2.99 -7.33 5.88 -11.52 7.9c-3.43 1.65 -6.4 4.34 -10.11 5.59c-5.14 2.97 -7.74 6.46 -14.3 6.15c-7.66 -0.2 -15.81 0.57 -23.35 -0.75c3.49 -2.84 7.77 -4.05 11.32 -6.77c4.06 -3.12 8.64 -5.32 12.89 -8.14c4.61 -2.73 9.14 -5.61 13.82 -8.21c3.52 -2.3 7.97 -4.4 11.27 -6.83c3.12 -3.03 6.3 -4.71 9.98 -6.93z" />
        <path fill="#fbbb1a" d="M15.09 35.21c-0.04 -2.42 -0.1 -4.85 -0.09 -7.28c0.18 -5.3 -1.44 -10.46 5.91 -10.21c6.35 0.05 12.84 0.04 19.19 0.01c6.65 -0.28 8.58 4.51 12.21 8.99c12.56 0.09 25.16 0.01 37.73 0.05c1.79 0 3.58 0 5.36 -0.04c1.98 0.96 2.66 1.33 3.43 3.45c-2.58 -1.85 -3.51 -2.34 -6.79 -2.26c-7.05 0.1 -14.19 -0.07 -21.23 0.13c-5.41 -0.15 -11.31 -0.05 -16.7 -0.07c-2.95 -0.05 -4.59 3.09 -7.45 3.88c-3.89 1.47 -9.48 0.59 -13.66 0.84c-5 0.08 -10.12 -0.1 -15.11 0.15c-0.31 1.78 -0.97 2.5 -2.8 2.36z" />
        <path fill="#ffcb3c" d="M98.99 62.96c0.05 4.69 -0.01 9.4 0.03 14.09c-0.05 2.89 -0.05 4.32 -2.39 6.19c-1.99 0.52 -2.83 0.27 -4.54 0.26c-22.35 0.21 -44.72 0.19 -67.07 0.01c-2.71 0.01 -4.64 -0.02 -7.56 -0.18c-1.54 -1.2 -1.92 -1.6 -2.37 -3.53c2.29 1.6 2.86 2.37 5.86 2.29c6.1 -0.1 12.65 0.08 18.76 -0.24c7.6 0.67 15.68 0.06 23.35 0.26c6.56 0.25 8.89 -3.15 14.03 -6.12c3.4 -1.78 6.49 -4.37 9.92 -6.02c4.19 -2.02 7.55 -5.23 11.98 -7.01z" />
        <path fill="#b18424" d="M17.46 83.33c2.64 -0.88 4.86 -0.62 7.56 -0.63c22.36 -0.07 44.72 -0.01 67.07 -0.13c1.71 0.01 2.94 0.01 4.54 0.67c-3.68 1.53 -8.66 0.41 -12.63 0.74l-61.1 0.05c-2.12 -0.04 -3.46 0.23 -5.44 -0.7z" />
        <path fill="#ffedb6" d="M17.89 32.85c8.05 -0.07 16.11 0.12 24.16 0.1c2.1 -0.19 3.29 0.19 5.34 0.67c-1.96 0.46 -3.32 0.9 -5.34 0.79c-6.69 0.08 -13.39 0.17 -20.08 0.18c-3.95 -0.28 -4.1 1.63 -6.97 3.58l0.09 -2.96c0.93 -0.85 1.72 -1.68 2.8 -2.36z" />
      </g>

      {/* Status Overlay Badge */}
      <g filter={`url(#badgeShadow-${badge})`}>
        {badge === "synced" ? (
          <>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="#22c55e"
              stroke="#15803d"
              strokeWidth="1.4"
            />
            <polyline
              points={`${p1} ${p2} ${p3}`}
              fill="none"
              stroke="#ffffff"
              strokeWidth="2.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="#facc15"
            stroke="#5c2605"
            strokeWidth="1.4"
          />
        )}
      </g>
    </svg>
  );
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
  const [downloadingUpdate, setDownloadingUpdate] = useState<{ version: string; pct?: number } | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [newExcludePattern, setNewExcludePattern] = useState("");
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(null);
  const [pruningDb, setPruningDb] = useState(false);
  const [overlayEnabled, setOverlayEnabled] = useState<boolean>(true);

  const loadOverlayStatus = useCallback(async () => {
    try {
      const s = await getOverlayStatus();
      setOverlayEnabled(s.enabled);
    } catch {
      // Ignored if unavailable
    }
  }, []);

  const loadDbStats = useCallback(async () => {
    try {
      const stats = await getDatabaseStats();
      setDbStats(stats);
    } catch (e) {
      console.warn("Failed to get db stats:", e);
    }
  }, []);

  useEffect(() => {
    void loadDbStats();
    void loadOverlayStatus();
  }, [loadDbStats, loadOverlayStatus]);

  async function handleToggleOverlay(enabled: boolean) {
    setOverlayEnabled(enabled);
    try {
      await setOverlaySettings(enabled, "bottom_right");
      const updatedConfig = await getConfig();
      setConfig(updatedConfig);
      setLocal(updatedConfig);
      toast.success(
        enabled
          ? "Explorer folder status icon overlays enabled"
          : "Explorer folder status icon overlays disabled"
      );
    } catch (err) {
      toast.error(`Overlay update failed: ${String(err)}`);
    }
  }

  async function handlePruneDb() {
    setPruningDb(true);
    try {
      const res = await runDatabaseMaintenance(30, 5000);
      toast.success(
        `Database vacuumed! ${res.activity_rows_removed} activity logs pruned, ${res.jobs_removed} dead jobs cleared.`
      );
      void loadDbStats();
    } catch (e) {
      toast.error(`Database maintenance failed: ${String(e)}`);
    } finally {
      setPruningDb(false);
    }
  }

  const defaultExcludes = ["*.tmp", "node_modules/**", ".git/**", "~$*", "Thumbs.db"];
  const currentExcludes = local?.rules?.exclude ?? defaultExcludes;
  const maxFileMb = local?.rules?.max_file_mb ?? 0;

  function handleAddExclude() {
    const p = newExcludePattern.trim();
    if (!p) return;
    if (currentExcludes.includes(p)) {
      toast.error(`"${p}" is already in the exclude list`);
      return;
    }
    patchLocal((c) => ({
      ...c,
      rules: {
        exclude: [...(c.rules?.exclude ?? defaultExcludes), p],
        include: c.rules?.include ?? [],
        max_file_mb: c.rules?.max_file_mb ?? 0,
      },
    }));
    setNewExcludePattern("");
    toast.success(`Added "${p}" to ignored patterns`);
  }

  function handleRemoveExclude(pattern: string) {
    patchLocal((c) => ({
      ...c,
      rules: {
        exclude: (c.rules?.exclude ?? defaultExcludes).filter((x) => x !== pattern),
        include: c.rules?.include ?? [],
        max_file_mb: c.rules?.max_file_mb ?? 0,
      },
    }));
  }

  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;
    let unlistenReady: (() => void) | undefined;

    void listen<{ status: string; version?: string; progress_pct?: number; error?: string }>(
      "update://status",
      (ev) => {
        if (ev.payload.status === "checking") {
          setCheckingUpdate(true);
          setDownloadingUpdate(null);
        } else if (ev.payload.status === "downloading") {
          setCheckingUpdate(false);
          setDownloadingUpdate({
            version: ev.payload.version ?? "",
            pct: ev.payload.progress_pct ?? 0,
          });
        } else if (ev.payload.status === "ready") {
          setCheckingUpdate(false);
          setDownloadingUpdate(null);
          if (ev.payload.version) {
            setUpdateState((prev) => ({
              status: { status: "ready", version: ev.payload.version! },
              current_version: prev?.current_version ?? "1.1.7",
              ready_version: ev.payload.version!,
              release_notes: prev?.release_notes ?? null,
              last_checked: new Date().toISOString(),
            }));
          }
        } else if (
          ev.payload.status === "up-to-date" ||
          ev.payload.status === "idle" ||
          ev.payload.status === "error"
        ) {
          setCheckingUpdate(false);
          setDownloadingUpdate(null);
        }
      }
    ).then((u) => {
      unlistenStatus = u;
    });

    void listen<{ version: string; notes?: string }>("update://ready", (ev) => {
      setCheckingUpdate(false);
      setDownloadingUpdate(null);
      setUpdateState((prev) => ({
        status: { status: "ready", version: ev.payload.version },
        current_version: prev?.current_version ?? "1.1.7",
        ready_version: ev.payload.version,
        release_notes: prev?.release_notes ?? null,
        last_checked: new Date().toISOString(),
      }));
    }).then((u) => {
      unlistenReady = u;
    });

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenReady) unlistenReady();
    };
  }, []);

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

  async function handleToggleColorDriveFolders(enable: boolean) {
    patchLocal((c) => ({
      ...c,
      app: {
        ...c.app,
        color_drive_folders: enable,
      },
    }));
    try {
      await driveSetFolderColorizerEnabled(enable);
      if (enable) {
        toast.info("Colourizing Google Drive folders for sync pairs…");
      }
    } catch (e) {
      console.warn("Failed to update folder colorizer:", e);
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
    setDownloadingUpdate(null);
    try {
      const res = await updateCheck();
      setUpdateState(res);
      setDownloadingUpdate(null);
      if (res.ready_version) {
        // Update ready to apply: UI transitions immediately to "Restart & Apply".
        // No duplicate toast info balloon!
      } else if (res.status.status === "up-to-date") {
        toast.info(`Twin is up to date (v${res.current_version})`);
      } else if (res.status.status === "error") {
        toast.error(`Update check error: ${(res.status as any).error}`);
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
    <div className="p-6 sm:p-8 w-full max-w-[880px] mx-auto space-y-7 pb-28">
      {/* Header */}
      <div className="flex items-center justify-between pb-3.5 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white">
            Preferences
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-1">
            Manage your account, sync speed, and preferences.
          </p>
        </div>
      </div>

      {/* 1. Google Account Section */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Google Account & Storage
        </h2>

        <div className="desktop-card p-4 sm:p-5">
          {authed ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                {/* Left: User Profile */}
                <div className="flex items-center gap-3 shrink-0">
                  {userProfile?.picture ? (
                    <img
                      src={userProfile.picture}
                      alt={userProfile.name ?? "User"}
                      className="w-10 h-10 rounded-full object-cover border border-blue-500/30 ring-2 ring-blue-500/10 shrink-0"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-300 font-bold flex items-center justify-center text-sm shrink-0">
                      {userProfile?.name ? userProfile.name[0].toUpperCase() : "G"}
                    </div>
                  )}

                  <div className="shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-white">
                        {userProfile?.name ?? "Google Account"}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                        <CheckCircle2 size={11} />
                        Connected
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      {userProfile?.email ?? "Signed in"}
                    </p>
                  </div>
                </div>

                {/* Right: Storage Quota + Sign Out */}
                <div className="flex items-center gap-3 sm:gap-4 shrink-0">
                  {quota && (
                    <div className="flex items-center gap-1.5 sm:gap-2 text-xs shrink-0" title={`Drive Storage: ${quotaPct}% used`}>
                      <img
                        src={gdLogo}
                        alt="Google Drive"
                        style={{ width: 14, height: 14, minWidth: 14, maxWidth: 14 }}
                        className="w-3.5 h-3.5 object-contain shrink-0"
                      />
                      <div className="hidden md:block w-20 lg:w-28 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden shrink-0">
                        <div
                          className="h-full bg-blue-500 rounded-full"
                          style={{ width: `${Math.min(100, Math.max(0, quotaPct))}%` }}
                        />
                      </div>
                      <span className="font-numeric text-xs text-white font-semibold shrink-0">
                        {quotaPct}%
                      </span>
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleLogout}
                    className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 hover:text-white transition-all shadow-sm font-semibold gap-1.5 shrink-0"
                  >
                    <LogOut size={13} className="text-red-400 shrink-0" />
                    <span>Sign out</span>
                  </Button>
                </div>
              </div>

              {/* Limited Scope Warning & Upgrade Option */}
              {!hasFullScope && authed && (
                <div className="pt-3.5 border-t border-[var(--border-subtle)]">
                  <div className="flex items-center justify-between p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-200">
                    <div className="flex items-center gap-2.5 min-w-0 pr-3">
                      <AlertTriangle size={16} className="text-amber-400 shrink-0" />
                      <div className="text-xs">
                        <p className="font-semibold text-amber-300">Limited Drive Access</p>
                        <p className="text-[var(--text-muted)] text-[11px] mt-0.5">
                          Some Drive folders may not appear. Grant full access for seamless folder sync.
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleUpgradeScope}
                      disabled={upgradingScope}
                      className="shrink-0 text-xs font-semibold border-amber-500/30 text-amber-300 hover:bg-amber-500/15"
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
                  Sign in with Google to start syncing your files.
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
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1 flex items-center gap-2">
          <span className="w-5 h-5 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
            <Sliders size={12} />
          </span>
          <span>Sync Speed & Performance</span>
        </h2>

        <div className="desktop-card divide-y divide-[var(--border-subtle)]">
          {/* Autostart */}
          <div className="p-4.5 sm:p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
                <Power size={15} />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Launch on System Startup</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Automatically run Twin in the background when logging into Windows.
                </p>
              </div>
            </div>
            <Switch checked={autostart} onCheckedChange={handleAutostartToggle} />
          </div>

          {/* Parallel File Workers */}
          <div className="p-4.5 sm:p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0">
                <Layers size={15} />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Simultaneous Transfers</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Number of files to transfer at the same time.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5 shadow-sm">
                <button
                  type="button"
                  onClick={() =>
                    patchLocal((c) => ({
                      ...c,
                      app: {
                        ...c.app,
                        parallel_transfers: Math.max(1, (c.app.parallel_transfers || 4) - 1),
                      },
                    }))
                  }
                  disabled={local.app.parallel_transfers <= 1}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-3)] active:bg-[var(--surface-1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-bold text-sm cursor-pointer"
                  aria-label="Decrease simultaneous transfers"
                >
                  −
                </button>
                <span className="w-8 text-center font-numeric text-xs font-bold text-blue-400">
                  {local.app.parallel_transfers}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    patchLocal((c) => ({
                      ...c,
                      app: {
                        ...c.app,
                        parallel_transfers: Math.min(8, (c.app.parallel_transfers || 4) + 1),
                      },
                    }))
                  }
                  disabled={local.app.parallel_transfers >= 8}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-3)] active:bg-[var(--surface-1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-bold text-sm cursor-pointer"
                  aria-label="Increase simultaneous transfers"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {/* Colourize Drive Folders while Syncing */}
          <div className="p-4.5 sm:p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-pink-500/10 border border-pink-500/20 text-pink-400 flex items-center justify-center shrink-0">
                <Palette size={15} />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Colourize Drive Folders while Syncing</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Assigns bright, distinct colors to Google Drive pair folders and subfolders without repeating sibling colors.
                </p>
              </div>
            </div>
            <Switch
              checked={local.app.color_drive_folders ?? true}
              onCheckedChange={handleToggleColorDriveFolders}
            />
          </div>

          {/* Bandwidth Limits */}
          <div className="p-4.5 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-white flex items-center gap-2">
                <span className="w-5 h-5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                  <ArrowUp size={12} />
                </span>
                <span>Upload Speed Limit (KB/s)</span>
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
                className="font-numeric"
              />
              <span className="text-xs text-[var(--text-subtle)] block">
                Set to 0 for unlimited speed
              </span>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-white flex items-center gap-2">
                <span className="w-5 h-5 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center shrink-0">
                  <ArrowDown size={12} />
                </span>
                <span>Download Speed Limit (KB/s)</span>
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
                className="font-numeric"
              />
              <span className="text-xs text-[var(--text-subtle)] block">
                Set to 0 for unlimited speed
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 3. System Load & Battery Governor */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Performance & Battery Saver
        </h2>

        <div className="desktop-card divide-y divide-[var(--border-subtle)]">
          {/* CPU Thresholds */}
          <div className="p-4.5 sm:p-5 grid grid-cols-2 gap-5">
            <div>
              <label className="text-xs font-semibold text-white mb-1.5 flex items-center gap-1.5">
                <Cpu size={13} className="text-rose-400" />
                <span>Pause Above CPU Load (%)</span>
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
                Temporarily pause sync during heavy PC usage
              </span>
            </div>

            <div>
              <label className="text-xs font-semibold text-white mb-1.5 flex items-center gap-1.5">
                <Cpu size={13} className="text-emerald-400" />
                <span>Resume Below CPU Load (%)</span>
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
                Resume sync once CPU usage drops below this
              </span>
            </div>
          </div>

          {/* Battery Governor */}
          <div className="p-4.5 sm:p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
                <Battery size={15} />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Pause on Low Battery</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Pause sync when laptop battery falls below this % (0 to disable).
                </p>
              </div>
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
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0">
                <Wifi size={15} />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Pause on Metered Connections</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Save data by pausing sync on metered Wi-Fi or cellular networks.
                </p>
              </div>
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
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Sync Conflicts & Deleted Files
        </h2>

        <div className="desktop-card p-5 grid grid-cols-2 gap-5">
          <div>
            <label className="text-xs font-semibold text-white mb-2 flex items-center gap-1.5">
              <Shield size={13} className="text-emerald-400" />
              <span>When Files Conflict</span>
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
              className="w-full h-9 px-3 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-md text-[var(--text)] focus:outline-none focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20 transition-all cursor-pointer font-medium"
            >
              <option value="newer_wins">Keep Newer File (Automatic)</option>
              <option value="keep_both">Keep Both Copies (Rename)</option>
              <option value="ask">Ask Me Each Time</option>
            </select>
            <div className="mt-2 text-[11px]">
              {local.policy.conflict === "newer_wins" && (
                <span className="text-emerald-400/90 flex items-center gap-1.5">
                  <CheckCircle2 size={12} className="shrink-0" />
                  Keeps the newest version automatically
                </span>
              )}
              {local.policy.conflict === "keep_both" && (
                <span className="text-blue-400/90 flex items-center gap-1.5">
                  <Copy size={12} className="shrink-0" />
                  Saves both copies so nothing is lost
                </span>
              )}
              {local.policy.conflict === "ask" && (
                <span className="text-amber-400/90 flex items-center gap-1.5">
                  <AlertCircle size={12} className="shrink-0" />
                  Asks you which version to keep when conflicts occur
                </span>
              )}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-white mb-2 flex items-center gap-1.5">
              <Trash2 size={13} className="text-amber-400" />
              <span>When a Local File is Deleted</span>
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
              className="w-full h-9 px-3 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-md text-[var(--text)] focus:outline-none focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20 transition-all cursor-pointer font-medium"
            >
              <option value="drive_trash">Move to Google Drive Trash (Recommended)</option>
              <option value="ignore">Keep Cloud Copy (Do not delete)</option>
              <option value="delete">Delete Permanently from Google Drive</option>
            </select>
            <div className="mt-2 text-[11px]">
              {local.policy.deletion === "drive_trash" && (
                <span className="text-emerald-400/90 flex items-center gap-1.5">
                  <CheckCircle2 size={12} className="shrink-0" />
                  Safely moves cloud files to Google Drive Trash
                </span>
              )}
              {local.policy.deletion === "ignore" && (
                <span className="text-amber-400/90 flex items-center gap-1.5">
                  <AlertTriangle size={12} className="shrink-0" />
                  Keeps cloud files even when deleted on this PC
                </span>
              )}
              {local.policy.deletion === "delete" && (
                <span className="text-rose-400/90 flex items-center gap-1.5">
                  <AlertCircle size={12} className="shrink-0" />
                  Permanently deletes cloud files immediately
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 5. Exclude & Ignore Patterns */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Ignored Files & Filters
        </h2>

        <div className="desktop-card p-5 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-white flex items-center gap-2">
                <FileCode size={14} className="text-purple-400" />
                Ignored Files & Folders
              </label>
              <span className="text-[11px] text-purple-300/80 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded-full font-mono">
                {currentExcludes.length} rules
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] mb-3">
              Files and folders matching these patterns will be skipped during sync.
            </p>

            {/* Pattern Tags */}
            <div className="flex flex-wrap gap-2 mb-3">
              {currentExcludes.map((pattern) => (
                <span
                  key={pattern}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-purple-500/[0.08] text-purple-200 border border-purple-500/20 hover:border-purple-500/40 transition-colors"
                >
                  <FileCode size={12} className="text-purple-400" />
                  <span>{pattern}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveExclude(pattern)}
                    className="text-purple-400/70 hover:text-rose-400 p-0.5 rounded hover:bg-rose-500/10 transition-colors cursor-pointer"
                    title={`Remove ${pattern}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>

            {/* Add Pattern Input */}
            <div className="flex items-center gap-2">
              <Input
                value={newExcludePattern}
                onChange={(e) => setNewExcludePattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddExclude();
                  }
                }}
                placeholder="e.g. *.log, dist/**, .env"
                className="font-mono text-xs max-w-sm"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleAddExclude}
                disabled={!newExcludePattern.trim()}
                className="flex items-center gap-1.5 text-xs border border-purple-500/30 hover:bg-purple-500/10 text-purple-300"
              >
                <Plus size={13} />
                Add Pattern
              </Button>
            </div>
          </div>

          <div className="pt-3 border-t border-[var(--border-subtle)] grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-white mb-1.5 flex items-center gap-1.5">
                <HardDrive size={13} className="text-purple-400" />
                <span>Maximum File Size (MB)</span>
              </label>
              <Input
                type="number"
                min={0}
                value={maxFileMb}
                onChange={(e) =>
                  patchLocal((c) => ({
                    ...c,
                    rules: {
                      exclude: c.rules?.exclude ?? defaultExcludes,
                      include: c.rules?.include ?? [],
                      max_file_mb: parseInt(e.target.value, 10) || 0,
                    },
                  }))
                }
                placeholder="0 = Unlimited"
              />
              <span className="text-xs text-[var(--text-subtle)] mt-1.5 block">
                Skip files larger than this (0 for no limit)
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Windows File Explorer Folder Overlays */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Windows File Explorer Badges
        </h2>

        <div className="desktop-card p-5 space-y-5">
          {/* Main Toggle */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <label className="text-sm font-semibold text-white">
                Show status icon on folders in Explorer
              </label>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Shows green checkmarks on synced folders and yellow badges while syncing.
              </p>
            </div>
            <Switch
              checked={overlayEnabled}
              onCheckedChange={handleToggleOverlay}
            />
          </div>

          {overlayEnabled && (
            <div className="pt-4 border-t border-[var(--border-subtle)] animate-in fade-in duration-200">
              <div className="grid grid-cols-2 gap-3.5">
                {/* Done Graphic */}
                <div className="rounded-xl p-3.5 border bg-gradient-to-b from-emerald-500/[0.04] to-transparent border-emerald-500/20 hover:border-emerald-500/35 transition-colors flex flex-col items-center justify-center gap-2.5 shadow-sm">
                  <div className="w-full flex items-center justify-center py-3.5 bg-[#0b0f14] rounded-lg border border-emerald-500/15">
                    <WindowsFolderOverlayPreview badge="synced" className="w-16 h-13" />
                  </div>
                  <span className="text-xs font-semibold text-emerald-400">Done</span>
                </div>

                {/* Active Graphic */}
                <div className="rounded-xl p-3.5 border bg-gradient-to-b from-amber-500/[0.04] to-transparent border-amber-500/20 hover:border-amber-500/35 transition-colors flex flex-col items-center justify-center gap-2.5 shadow-sm">
                  <div className="w-full flex items-center justify-center py-3.5 bg-[#0b0f14] rounded-lg border border-amber-500/15">
                    <WindowsFolderOverlayPreview badge="syncing" className="w-16 h-13" />
                  </div>
                  <span className="text-xs font-semibold text-amber-400">Active</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 7. SQLite Database Storage & Maintenance */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Local Storage & Cache
        </h2>

        <div className="desktop-card p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-lg bg-sky-500/10 border border-sky-500/25 text-sky-400 flex items-center justify-center shrink-0 shadow-sm shadow-sky-950/20">
                <Database size={16} />
              </div>
              <div className="space-y-1 min-w-0 flex-1">
                <span className="text-sm font-semibold text-white tracking-tight">
                  Sync History & Cache
                </span>
                <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                  Stores your sync history and local file index on this PC.
                </p>
              </div>
            </div>

            <Button
              type="button"
              variant="secondary"
              onClick={handlePruneDb}
              disabled={pruningDb}
              className="shrink-0 self-start sm:self-center flex items-center gap-2 text-xs font-semibold border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 text-sky-200 hover:text-white transition-all shadow-sm h-10 px-4 rounded-lg cursor-pointer"
            >
              <RefreshCw size={13} className={cn("text-sky-400", pruningDb && "animate-spin")} />
              <span>{pruningDb ? "Cleaning…" : "Clean Up Database"}</span>
            </Button>
          </div>

          <div className="pt-3.5 border-t border-[var(--border-subtle)] grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Disk Size */}
            <div className="relative overflow-hidden rounded-xl bg-[var(--surface-2)]/60 border border-[var(--border-subtle)] p-3 sm:p-3.5 transition-all duration-200 hover:border-cyan-500/35 hover:bg-[var(--surface-2)] group flex flex-col justify-between min-w-0">
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent opacity-40 group-hover:opacity-100 transition-opacity" />
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] group-hover:text-slate-300 transition-colors truncate">
                  Disk Size
                </span>
                <div className="w-6 h-6 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center shrink-0">
                  <HardDrive size={13} />
                </div>
              </div>
              <div className="mt-2.5 min-w-0">
                <span className="text-lg sm:text-xl font-bold text-white font-numeric tracking-tight block truncate">
                  {dbStats ? formatBytes(dbStats.file_size_bytes) : "–"}
                </span>
                <span className="text-[11px] text-[var(--text-subtle)] mt-0.5 block truncate">
                  Used on disk
                </span>
              </div>
            </div>

            {/* Tracked Files */}
            <div className="relative overflow-hidden rounded-xl bg-[var(--surface-2)]/60 border border-[var(--border-subtle)] p-3 sm:p-3.5 transition-all duration-200 hover:border-blue-500/35 hover:bg-[var(--surface-2)] group flex flex-col justify-between min-w-0">
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-blue-500/40 to-transparent opacity-40 group-hover:opacity-100 transition-opacity" />
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] group-hover:text-slate-300 transition-colors truncate">
                  Tracked Files
                </span>
                <div className="w-6 h-6 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
                  <Files size={13} />
                </div>
              </div>
              <div className="mt-2.5 min-w-0">
                <span className="text-lg sm:text-xl font-bold text-white font-numeric tracking-tight block truncate">
                  {dbStats ? dbStats.total_files.toLocaleString() : "–"}
                </span>
                <span className="text-[11px] text-[var(--text-subtle)] mt-0.5 block truncate">
                  Across synced folders
                </span>
              </div>
            </div>

            {/* Activity Log */}
            <div className="relative overflow-hidden rounded-xl bg-[var(--surface-2)]/60 border border-[var(--border-subtle)] p-3 sm:p-3.5 transition-all duration-200 hover:border-amber-500/35 hover:bg-[var(--surface-2)] group flex flex-col justify-between min-w-0">
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-500/40 to-transparent opacity-40 group-hover:opacity-100 transition-opacity" />
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] group-hover:text-slate-300 transition-colors truncate">
                  Activity Log
                </span>
                <div className="w-6 h-6 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
                  <Activity size={13} />
                </div>
              </div>
              <div className="mt-2.5 min-w-0">
                <span className="text-lg sm:text-xl font-bold text-white font-numeric tracking-tight block truncate">
                  {dbStats ? dbStats.activity_count.toLocaleString() : "–"}
                </span>
                <span className="text-[11px] text-[var(--text-subtle)] mt-0.5 block truncate">
                  Total log entries
                </span>
              </div>
            </div>

            {/* Completed Syncs */}
            <div className="relative overflow-hidden rounded-xl bg-[var(--surface-2)]/60 border border-[var(--border-subtle)] p-3 sm:p-3.5 transition-all duration-200 hover:border-emerald-500/35 hover:bg-[var(--surface-2)] group flex flex-col justify-between min-w-0">
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent opacity-40 group-hover:opacity-100 transition-opacity" />
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] group-hover:text-slate-300 transition-colors truncate">
                  Completed Syncs
                </span>
                <div className="w-6 h-6 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                  <CheckCircle2 size={13} />
                </div>
              </div>
              <div className="mt-2.5 min-w-0">
                <span className="text-lg sm:text-xl font-bold text-white font-numeric tracking-tight block truncate">
                  {dbStats ? dbStats.completed_jobs.toLocaleString() : "–"}
                </span>
                <span className="text-[11px] text-[var(--text-subtle)] mt-0.5 block truncate">
                  Successful transfers
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 8. Application Updates */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Software Updates
        </h2>

        <div className="desktop-card p-4 sm:p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <Sparkles size={16} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-white whitespace-nowrap">
                  Twin Desktop
                </span>
                <span className="text-xs font-numeric font-medium text-emerald-400/90 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded-md shrink-0">
                  v{updateState?.current_version ?? "1.1.7"}
                </span>
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-1.5 truncate">
                {updateState?.ready_version ? (
                  <span className="text-emerald-400 font-medium flex items-center gap-1 shrink-0">
                    <Sparkles size={12} />
                    v{updateState.ready_version} ready to install
                  </span>
                ) : downloadingUpdate ? (
                  <span className="text-blue-400 font-medium flex items-center gap-1 shrink-0">
                    <RefreshCw size={11} className="animate-spin" />
                    Downloading update {downloadingUpdate.pct ? `(${downloadingUpdate.pct}%)` : ""}…
                  </span>
                ) : checkingUpdate ? (
                  <span className="text-blue-400 font-medium flex items-center gap-1 shrink-0">
                    <RefreshCw size={11} className="animate-spin" />
                    Checking for updates…
                  </span>
                ) : (
                  <>
                    <span className="text-emerald-400 font-medium flex items-center gap-1 shrink-0">
                      <Check size={12} />
                      Up to date
                    </span>
                    <span className="text-[var(--text-subtle)]">•</span>
                    <span className="truncate">Automatic background checks</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="shrink-0">
            {updateState?.ready_version ? (
              <Button
                onClick={handleInstallUpdate}
                disabled={installingUpdate}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center justify-center gap-1.5 h-8 px-3 text-xs"
              >
                <ArrowDownCircle size={14} />
                {installingUpdate ? "Applying…" : "Restart & Apply"}
              </Button>
            ) : downloadingUpdate ? (
              <Button
                variant="secondary"
                disabled
                className="flex items-center justify-center gap-1.5 cursor-wait opacity-85 h-8 px-3 text-xs"
              >
                <RefreshCw size={13} className="animate-spin text-blue-400" />
                Downloading…
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={handleCheckUpdate}
                disabled={checkingUpdate}
                className="flex items-center justify-center gap-1.5 border border-emerald-500/25 hover:bg-emerald-500/10 text-emerald-300 h-8 px-3 rounded-lg font-semibold text-xs"
              >
                <RefreshCw
                  size={13}
                  className={cn("text-emerald-400", checkingUpdate && "animate-spin")}
                />
                {checkingUpdate ? "Checking…" : "Check for Updates"}
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Floating Save Banner */}
      {hasChanges && (
        <div
          className="fixed bottom-7 right-8 z-40 animate-in fade-in duration-150"
          style={{ transform: "none" }}
        >
          <Button
            onClick={handleSave}
            disabled={saving}
            className="shadow-lg shadow-black/50 px-5 py-2.5 h-10 text-[13px] font-semibold flex items-center gap-2 border border-blue-400/40 rounded-lg text-white bg-[#1d4ed8] hover:bg-[#1e40af] active:bg-[#1e3a8a]"
            style={{
              textRendering: "geometricPrecision",
              transform: "none",
            }}
          >
            <Check size={16} strokeWidth={2.5} className="shrink-0 text-white" />
            <span className="text-white tracking-wide">{saving ? "Saving…" : "Save Preferences"}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
