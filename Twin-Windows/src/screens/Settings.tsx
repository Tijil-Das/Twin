/**
 * Settings & Preferences Screen
 * Desktop preference panes for Google account, storage quota,
 * concurrency governor, network rules, and background updates.
 */
import { useState, useEffect, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
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
  registerOverlayExtension,
  restartExplorerShell,
  type OverlayPlacement,
  type DatabaseStats,
  type UpdateStatePayload,
  type Config,
} from "@/lib/tauri";
import { GithubFolderIcon } from "@/components/ui/GithubFolderIcon";
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
  Check,
  Cpu,
  Battery,
  Wifi,
  Shield,
  Layers,
  AlertTriangle,
  Filter,
  Plus,
  X,
  FileCode,
  Database,
} from "lucide-react";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

interface StorageQuota {
  limit: number | null;
  usage: number;
  usageInDrive: number;
  usageInDriveTrash: number;
}

const OVERLAY_PLACEMENTS: {
  id: OverlayPlacement;
  title: string;
  description: string;
}[] = [
  {
    id: "centered",
    title: "Center",
    description: "Badge sits squarely in the center of the corner area.",
  },
  {
    id: "top_right",
    title: "Top-Right",
    description: "Badge is shifted towards the upper-right shoulder.",
  },
  {
    id: "bottom_right",
    title: "Bottom-Right",
    description: "Badge is shifted towards the bottom-right corner.",
  },
];

/**
 * Authentic Windows 11 Explorer Folder with Overlay Badge.
 * Replicates real Windows File Explorer geometry and native Shell overlay placement (bottom-left corner).
 */
function WindowsFolderOverlayPreview({
  badge = "synced",
  className,
  placement = "centered",
}: {
  badge?: "synced" | "syncing";
  className?: string;
  placement?: OverlayPlacement;
}) {
  let cx = 16.0;
  let cy = 43.5;
  const r = 6.2; // Perfectly proportioned, suitable size matching r=0.30

  if (placement === "top_right") {
    cx = 19.5;
    cy = 40.0;
  } else if (placement === "bottom_right") {
    cx = 19.5;
    cy = 46.5;
  } else {
    // centered
    cx = 16.0;
    cy = 43.5;
  }

  const p1 = `${(cx - r * 0.50).toFixed(2)},${(cy + r * 0.05).toFixed(2)}`;
  const p2 = `${(cx - r * 0.16).toFixed(2)},${(cy + r * 0.38).toFixed(2)}`;
  const p3 = `${(cx + r * 0.50).toFixed(2)},${(cy - r * 0.34).toFixed(2)}`;

  return (
    <svg
      viewBox="0 0 70 57"
      className={cn("w-14 h-11 drop-shadow-sm shrink-0 select-none", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`winFolderBack-${badge}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
        <linearGradient id={`winFolderFront-${badge}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffea79" />
          <stop offset="15%" stopColor="#ffd84d" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
        <filter id={`badgeShadow-${badge}`} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="0.8" floodColor="#000" floodOpacity="0.4" />
        </filter>
      </defs>

      {/* Back tab */}
      <path
        d="M 5 11 C 5 8 7 6 10 6 L 24 6 C 26.5 6 28.5 8 30 11.5 L 31.5 15 L 5 15 Z"
        fill={`url(#winFolderBack-${badge})`}
      />

      {/* Front folder body with rounded bottom corners */}
      <path
        d="M 5 15 L 59 15 C 61 15 62.5 16.5 62.5 18.5 L 62.5 44 C 62.5 46.5 60.5 48.5 58 48.5 L 9.5 48.5 C 7 48.5 5 46.5 5 44 Z"
        fill={`url(#winFolderFront-${badge})`}
        stroke="#ca8a04"
        strokeWidth="0.8"
      />

      {/* Front folder top highlight lip */}
      <path
        d="M 6 16 L 58.5 16"
        stroke="#ffffff"
        strokeWidth="0.75"
        strokeOpacity="0.6"
        strokeLinecap="round"
      />

      {/* Status Overlay Badge */}
      <g filter={`url(#badgeShadow-${badge})`}>
        {badge === "synced" ? (
          <>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="#22a338"
              stroke="#15803d"
              strokeWidth="1.1"
            />
            <polyline
              points={`${p1} ${p2} ${p3}`}
              fill="none"
              stroke="#ffffff"
              strokeWidth="2.1"
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
            strokeWidth="1.8"
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
  const [overlayPlacement, setOverlayPlacement] = useState<OverlayPlacement>("top_right");
  const [overlayRegistered, setOverlayRegistered] = useState<boolean>(true);
  const [restartingExplorer, setRestartingExplorer] = useState(false);
  const [registeringOverlay, setRegisteringOverlay] = useState(false);
  const [showRegisterConfirm, setShowRegisterConfirm] = useState(false);

  const loadOverlayStatus = useCallback(async () => {
    try {
      const s = await getOverlayStatus();
      setOverlayEnabled(s.enabled);
      setOverlayPlacement(s.placement);
      setOverlayRegistered(s.is_registered);
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
      await setOverlaySettings(enabled, overlayPlacement);
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

  async function handlePlacementChange(placement: OverlayPlacement) {
    setOverlayPlacement(placement);
    try {
      await setOverlaySettings(overlayEnabled, placement);
      const updatedConfig = await getConfig();
      setConfig(updatedConfig);
      setLocal(updatedConfig);
      toast.success(`Overlay placement set to ${placement.replace('_', ' ')}.`);
    } catch (err) {
      toast.error(`Placement update failed: ${String(err)}`);
    }
  }

  function handleRegisterClick() {
    setShowRegisterConfirm(true);
  }

  async function confirmRegisterOverlay() {
    setShowRegisterConfirm(false);
    setRegisteringOverlay(true);
    try {
      await registerOverlayExtension();
      await restartExplorerShell();
      setOverlayRegistered(true);
      toast.success("Shell overlay identifiers registered and Explorer reloaded");
    } catch (err) {
      toast.error(`Registration failed: ${String(err)}`);
    } finally {
      setRegisteringOverlay(false);
    }
  }

  async function handleRestartExplorer() {
    setRestartingExplorer(true);
    try {
      await restartExplorerShell();
      toast.success("Windows Explorer restarted successfully");
    } catch (err) {
      toast.error(`Explorer restart failed: ${String(err)}`);
    } finally {
      setTimeout(() => setRestartingExplorer(false), 1200);
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
            Manage Google account credentials, concurrency limits, and sync policies.
          </p>
        </div>
      </div>

      {/* 1. Google Account Section */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1 flex items-center gap-1.5">
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
                  <div className="flex items-center justify-between p-3.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-amber-200">
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
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
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
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
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
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
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
              className="w-full h-9 px-3 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-md text-[var(--text)] focus:outline-none focus:border-blue-500/70 cursor-pointer font-medium"
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
              className="w-full h-9 px-3 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-md text-[var(--text)] focus:outline-none focus:border-blue-500/70 cursor-pointer font-medium"
            >
              <option value="drive_trash">Move to Google Drive Trash (Safe)</option>
              <option value="ignore">Ignore Remote Deletions</option>
              <option value="delete">Delete Permanently</option>
            </select>
          </div>
        </div>
      </section>

      {/* 5. Exclude & Ignore Patterns */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Sync Exclude Rules & Filters
        </h2>

        <div className="desktop-card p-5 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-white flex items-center gap-2">
                <Filter size={14} className="text-[#58a6ff]" />
                Ignored File & Folder Patterns (Globs)
              </label>
              <span className="text-[11px] text-[var(--text-subtle)] font-mono">
                {currentExcludes.length} active patterns
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] mb-3">
              Files or directories matching these expressions will be skipped during synchronization.
            </p>

            {/* Pattern Tags */}
            <div className="flex flex-wrap gap-2 mb-3">
              {currentExcludes.map((pattern) => (
                <span
                  key={pattern}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-[#161b22] text-[#c9d1d9] border border-[#30363d]"
                >
                  <FileCode size={12} className="text-[#7d8590]" />
                  <span>{pattern}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveExclude(pattern)}
                    className="text-[#7d8590] hover:text-[#f85149] p-0.5 rounded hover:bg-[#f85149]/10 transition-colors cursor-pointer"
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
                className="flex items-center gap-1.5 text-xs border border-[#30363d]"
              >
                <Plus size={13} />
                Add Pattern
              </Button>
            </div>
          </div>

          <div className="pt-3 border-t border-[var(--border-subtle)] grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-white mb-1.5">
                Max File Size Filter (MB)
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
                Skip files exceeding this size (0 = no limit)
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Windows File Explorer Folder Overlays */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Windows File Explorer Shell Integration
        </h2>

        <div className="desktop-card p-5 space-y-5">
          {/* Main Toggle */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <label className="text-sm font-semibold text-white flex items-center gap-2">
                <GithubFolderIcon className="w-4 h-4 text-[#54aeff]" />
                Show status icon on folders in Explorer
              </label>
              <p className="text-xs text-[var(--text-muted)]">
                Render green checkmark badges on synced local folders and yellow badges during active uploads/downloads.
              </p>
            </div>
            <Switch
              checked={overlayEnabled}
              onCheckedChange={handleToggleOverlay}
            />
          </div>

          {overlayEnabled && (
            <div className="pt-4 border-t border-[var(--border-subtle)] space-y-4 animate-in fade-in duration-200">
              {/* Shell Registration Status & Quick Actions */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-[#0d1117] rounded-lg border border-[#30363d]/60 text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full",
                      overlayRegistered ? "bg-emerald-400" : "bg-amber-400"
                    )}
                  />
                  <span className="text-[#c9d1d9]">
                    {overlayRegistered ? "Shell Extension Registered" : "Registration Pending"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {!overlayRegistered && (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={handleRegisterClick}
                      className="text-xs bg-[#238636] hover:bg-[#2ea043] text-white"
                    >
                      Register Extension
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleRestartExplorer}
                    disabled={restartingExplorer}
                    className="text-xs bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] border border-[#30363d] flex items-center gap-1.5"
                  >
                    <RefreshCw size={12} className={cn(restartingExplorer && "animate-spin")} />
                    {restartingExplorer ? "Restarting Explorer…" : "Restart Explorer"}
                  </Button>
                </div>
              </div>

              {/* Icon Placement Options */}
              <div>
                <label className="block text-xs font-semibold text-white mb-2">
                  Icon Placement
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {OVERLAY_PLACEMENTS.map((opt) => {
                    const isSelected = overlayPlacement === opt.id;
                    return (
                      <div
                        key={opt.id}
                        onClick={() => handlePlacementChange(opt.id)}
                        className={cn(
                          "relative rounded-lg p-3.5 border transition-all cursor-pointer flex flex-col justify-between",
                          isSelected
                            ? "bg-[#1f2937]/50 border-[#58a6ff] ring-1 ring-[#58a6ff]/40 shadow-sm"
                            : "bg-[#161b22]/70 border-[#30363d] hover:bg-[#161b22] hover:border-[#484f58]"
                        )}
                      >
                        {/* Interactive Folder Preview */}
                        <div className="flex items-center justify-center py-2.5 mb-2 bg-[#0d1117] rounded-md border border-[#30363d]/60">
                          <WindowsFolderOverlayPreview badge="synced" placement={opt.id} className="w-12 h-9" />
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold text-[#e6edf3]">
                              {opt.title}
                            </span>
                            {isSelected && (
                              <CheckCircle2 size={13} className="text-[#58a6ff] shrink-0" />
                            )}
                          </div>
                          <p className="text-[11px] text-[#7d8590] leading-snug">
                            {opt.description}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Explorer Folder Badge Preview */}
              <div>
                <div className="mb-2.5">
                  <label className="block text-xs font-semibold text-white">
                    Windows Explorer Folder Status Badges
                  </label>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Badges appear on the native Windows Shell corner of synced pair folders, matching OneDrive and Dropbox.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Done / Synced Card */}
                  <div className="rounded-lg p-3.5 border bg-[#161b22]/70 border-[#30363d] flex flex-col justify-between">
                    <div className="flex items-center justify-center py-3 mb-2 bg-[#0d1117] rounded-md border border-[#30363d]/60">
                      <WindowsFolderOverlayPreview badge="synced" placement={overlayPlacement} className="w-14 h-11" />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-[#7ee787]">
                          Synced & Up to Date
                        </span>
                        <Check size={13} className="text-[#7ee787]" />
                      </div>
                      <p className="text-[11px] text-[#7d8590] leading-snug">
                        Green checkmark indicates all files in this pair are completely backed up.
                      </p>
                    </div>
                  </div>

                  {/* Active / Syncing Card */}
                  <div className="rounded-lg p-3.5 border bg-[#161b22]/70 border-[#30363d] flex flex-col justify-between">
                    <div className="flex items-center justify-center py-3 mb-2 bg-[#0d1117] rounded-md border border-[#30363d]/60">
                      <WindowsFolderOverlayPreview badge="syncing" placement={overlayPlacement} className="w-14 h-11" />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-[#facc15]">
                          Syncing Active
                        </span>
                        <RefreshCw size={12} className="text-[#facc15]" />
                      </div>
                      <p className="text-[11px] text-[#7d8590] leading-snug">
                        Yellow badge indicates files are currently uploading or downloading.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Informational Dialog: Registration Confirmation before UAC */}
        <Dialog.Root open={showRegisterConfirm} onOpenChange={(open) => { if (!open) setShowRegisterConfirm(false); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 animate-in fade-in duration-150" />
            <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] max-w-[92vw] bg-[#0d1117] border border-[#30363d] rounded-xl p-6 z-[60] shadow-2xl animate-in zoom-in-95 duration-150 text-[#e6edf3]">
              <div className="flex items-start gap-3.5 mb-4">
                <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <Shield size={20} className="text-amber-400" />
                </div>
                <div>
                  <Dialog.Title className="text-base font-semibold text-[#e6edf3]">
                    Administrator Approval Required
                  </Dialog.Title>
                  <Dialog.Description className="text-xs text-[#7d8590] mt-1.5 leading-relaxed">
                    Windows Explorer requires registration under HKLM to display status overlays on folders.
                    <br /><br />
                    A Windows Administrator approval (UAC) prompt will appear to register the extension, followed by an Explorer reload.
                  </Dialog.Description>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-[#30363d]">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowRegisterConfirm(false)}
                  className="text-xs text-[#7d8590] hover:text-[#e6edf3] hover:bg-[#21262d]"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={confirmRegisterOverlay}
                  disabled={registeringOverlay}
                  className="text-xs bg-[#238636] hover:bg-[#2ea043] text-white flex items-center gap-1.5"
                >
                  {registeringOverlay ? (
                    <>
                      <RefreshCw size={12} className="animate-spin" />
                      Registering…
                    </>
                  ) : (
                    "OK, Continue to UAC"
                  )}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </section>

      {/* 7. SQLite Database Storage & Maintenance */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Database Storage & Maintenance
        </h2>

        <div className="desktop-card p-5 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-white flex items-center gap-2">
                <Database size={14} className="text-[#58a6ff]" />
                SQLite Activity Ledger & Sync Cache
              </span>
              <p className="text-xs text-[var(--text-muted)]">
                Local database indexing tracked files, real-time sync states, and transfer audit history. Automatically pruned on startup.
              </p>
            </div>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handlePruneDb}
              disabled={pruningDb}
              className="flex items-center gap-1.5 text-xs border border-[#30363d] cursor-pointer"
            >
              <RefreshCw size={13} className={cn(pruningDb && "animate-spin text-blue-400")} />
              <span>{pruningDb ? "Vacuuming…" : "Vacuum & Prune Database"}</span>
            </Button>
          </div>

          <div className="pt-3 border-t border-[var(--border-subtle)] grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg bg-[var(--surface-2)]/60 border border-[var(--border-subtle)]">
              <span className="text-[11px] text-[var(--text-subtle)] block">Disk Size</span>
              <span className="text-sm font-bold text-white font-mono mt-0.5 block">
                {dbStats ? formatBytes(dbStats.file_size_bytes) : "–"}
              </span>
            </div>
            <div className="p-3 rounded-lg bg-[var(--surface-2)]/60 border border-[var(--border-subtle)]">
              <span className="text-[11px] text-[var(--text-subtle)] block">Tracked Files</span>
              <span className="text-sm font-bold text-white font-mono mt-0.5 block">
                {dbStats ? dbStats.total_files.toLocaleString() : "–"}
              </span>
            </div>
            <div className="p-3 rounded-lg bg-[var(--surface-2)]/60 border border-[var(--border-subtle)]">
              <span className="text-[11px] text-[var(--text-subtle)] block">Activity Events</span>
              <span className="text-sm font-bold text-white font-mono mt-0.5 block">
                {dbStats ? dbStats.activity_count.toLocaleString() : "–"}
              </span>
            </div>
            <div className="p-3 rounded-lg bg-[var(--surface-2)]/60 border border-[var(--border-subtle)]">
              <span className="text-[11px] text-[var(--text-subtle)] block">Completed Jobs</span>
              <span className="text-sm font-bold text-emerald-400 font-mono mt-0.5 block">
                {dbStats ? dbStats.completed_jobs.toLocaleString() : "–"}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 8. Application Updates */}
      <section className="space-y-2.5">
        <h2 className="text-xs sm:text-[13px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
          Software Updates
        </h2>

        <div className="desktop-card p-5 flex items-center justify-between gap-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <span className="font-bold text-sm text-white">
                Twin Desktop v{updateState?.current_version ?? "1.1.7"}
              </span>
              {updateState?.ready_version ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <Sparkles size={13} />
                  v{updateState.ready_version} Ready to Apply
                </span>
              ) : downloadingUpdate ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">
                  <RefreshCw size={12} className="animate-spin" />
                  Downloading {downloadingUpdate.version ? `v${downloadingUpdate.version} ` : "update"}… {downloadingUpdate.pct && downloadingUpdate.pct > 0 ? `(${downloadingUpdate.pct}%)` : ""}
                </span>
              ) : checkingUpdate ? (
                <span className="text-xs code-text px-2 py-0.5 rounded-md bg-[var(--surface-2)] text-[var(--text-subtle)] border border-[var(--border)] flex items-center gap-1.5">
                  <RefreshCw size={11} className="animate-spin text-blue-400" />
                  Checking for updates…
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
                : downloadingUpdate
                ? `Downloading update ${downloadingUpdate.version ? `v${downloadingUpdate.version} ` : ""}in the background…`
                : checkingUpdate
                ? "Checking for new releases on GitHub…"
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
            ) : downloadingUpdate ? (
              <Button
                variant="secondary"
                disabled
                className="flex items-center gap-2 cursor-wait opacity-85"
              >
                <RefreshCw size={14} className="animate-spin text-blue-400" />
                Downloading update… {downloadingUpdate.pct && downloadingUpdate.pct > 0 ? `${downloadingUpdate.pct}%` : ""}
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
                {checkingUpdate ? "Checking for updates…" : "Check for Updates"}
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
