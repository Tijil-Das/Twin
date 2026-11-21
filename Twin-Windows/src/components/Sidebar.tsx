/**
 * Desktop Sidebar Navigation
 * Refined, native-feeling shell navigation with live engine telemetry,
 * notification indicators, and authenticated Google identity badge.
 * Supports smooth collapsible icon-rail mode (toggle button & Ctrl+B).
 */
import { useState, useEffect, useCallback } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Activity as ActivityIcon,
  Settings as SettingsIcon,
  Layers,
  type LucideIcon,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import appLogo from "@/assets/icon.png";
import gdLogo from "@/assets/gd-icon.png";

export type Screen = "home" | "activity" | "settings";

interface SidebarProps {
  active: Screen;
  onNavigate: (s: Screen) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

interface NavItem {
  id: Screen;
  label: string;
  Icon: LucideIcon;
  badge?: number | null;
}

export function Sidebar({
  active,
  onNavigate,
  collapsed: propCollapsed,
  onToggleCollapse,
}: SidebarProps) {
  const [appVersion, setAppVersion] = useState("1.1.7");
  const authed = useStore((s) => s.authed);
  const userProfile = useStore((s) => s.userProfile);
  const gov = useStore((s) => s.gov);
  const queueStatus = useStore((s) => s.queueStatus);
  const pairs = useStore((s) => s.pairs);

  const [internalCollapsed, setInternalCollapsed] = useState(() => {
    try {
      return localStorage.getItem("twin_sidebar_collapsed") === "true";
    } catch {
      return false;
    }
  });

  const isControlled = propCollapsed !== undefined;
  const collapsed = isControlled ? propCollapsed : internalCollapsed;

  const toggleCollapse = useCallback(() => {
    if (onToggleCollapse) {
      onToggleCollapse();
    }
    if (!isControlled) {
      setInternalCollapsed((prev) => {
        const next = !prev;
        try {
          localStorage.setItem("twin_sidebar_collapsed", String(next));
        } catch {}
        return next;
      });
    }
  }, [isControlled, onToggleCollapse]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleCollapse();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleCollapse]);

  useEffect(() => {
    void getVersion()
      .then((v) => {
        if (v) setAppVersion(v);
      })
      .catch(() => {});
  }, []);

  const items: NavItem[] = [
    { id: "home", label: "Overview", Icon: Layers },
    {
      id: "activity",
      label: "Activity",
      Icon: ActivityIcon,
      badge: queueStatus.failed > 0 ? queueStatus.failed : null,
    },
    { id: "settings", label: "Settings", Icon: SettingsIcon },
  ];

  const govKind = String(gov.kind ?? gov.state ?? "running").toLowerCase();

  const govMeta: Record<
    string,
    { label: string; dotClass: string; bgClass: string; textClass: string }
  > = {
    running: {
      label: "Engine Active",
      dotClass: "bg-emerald-400",
      bgClass: "bg-emerald-500/10 border-emerald-500/20",
      textClass: "text-emerald-400",
    },
    throttled: {
      label: "Throttled",
      dotClass: "bg-amber-400",
      bgClass: "bg-amber-500/10 border-amber-500/20",
      textClass: "text-amber-400",
    },
    scheduled: {
      label: "Scheduled",
      dotClass: "bg-blue-400",
      bgClass: "bg-blue-500/10 border-blue-500/20",
      textClass: "text-blue-400",
    },
    user_paused: {
      label: "Engine Paused",
      dotClass: "bg-zinc-400",
      bgClass: "bg-zinc-500/10 border-zinc-500/20",
      textClass: "text-zinc-400",
    },
    paused: {
      label: "Engine Paused",
      dotClass: "bg-zinc-400",
      bgClass: "bg-zinc-500/10 border-zinc-500/20",
      textClass: "text-zinc-400",
    },
  };

  const currentGov = govMeta[govKind] ?? govMeta.running;
  const activePairCount = pairs.filter((p) => p.enabled).length;

  return (
    <aside
      className={cn(
        "h-screen bg-[var(--surface)] border-r border-[var(--border)] flex flex-col justify-between select-none z-20 shrink-0 transition-[width] duration-200 ease-in-out overflow-hidden",
        collapsed
          ? "w-[clamp(52px,6vw,68px)] min-w-[52px] max-w-[68px]"
          : "w-64 min-w-[16rem]"
      )}
      aria-label="Application sidebar"
    >
      {/* Brand Header */}
      <div>
        {collapsed ? (
          <div className="h-16 flex items-center justify-center border-b border-[var(--border)] px-1 sm:px-2">
            <button
              type="button"
              onClick={toggleCollapse}
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)] transition-all cursor-pointer relative group border border-transparent hover:border-[var(--border)]"
              title="Expand sidebar (Ctrl+B)"
              aria-label="Expand sidebar"
            >
              <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-md overflow-hidden border border-white/10 bg-[#1e222b] flex items-center justify-center shadow-sm relative shrink-0">
                <img
                  src={appLogo}
                  alt="Twin"
                  className="w-full h-full object-cover transition-opacity duration-150 group-hover:opacity-15"
                />
                <PanelLeftOpen
                  size={15}
                  className="absolute inset-0 m-auto text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                />
              </div>
            </button>
          </div>
        ) : (
          <div className="h-16 px-3.5 flex items-center justify-between border-b border-[var(--border)]">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg overflow-hidden border border-white/10 shrink-0 bg-[#1e222b] flex items-center justify-center shadow-sm">
                <img
                  src={appLogo}
                  alt="Twin"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-sm tracking-tight text-white truncate">
                    Twin
                  </span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-[5px] text-[10.5px] font-semibold text-slate-200 bg-white/[0.07] border border-white/[0.12] shadow-sm font-numeric tracking-tight select-none">
                    v{appVersion}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5 font-medium truncate">
                  Perfect Cloud Sync
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={toggleCollapse}
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)] transition-colors cursor-pointer shrink-0 ml-1"
              title="Collapse sidebar (Ctrl+B)"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
        )}

        {/* Navigation list */}
        {collapsed ? (
          <nav className="p-1.5 sm:p-2 space-y-1.5 flex flex-col items-center">
            {items.map(({ id, label, Icon, badge }) => {
              const isActive = active === id;
              return (
                <button
                  key={id}
                  onClick={() => onNavigate(id)}
                  title={badge ? `${label} (${badge})` : label}
                  className={cn(
                    "w-9 h-9 sm:w-10 sm:h-10 md:w-11 md:h-11 rounded-md flex items-center justify-center transition-all duration-150 group cursor-pointer relative",
                    isActive
                      ? "bg-white/[0.08] text-white shadow-sm font-semibold"
                      : "text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)]/70"
                  )}
                  aria-label={label}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon
                    size={19}
                    strokeWidth={isActive ? 2.2 : 1.8}
                    className={cn(
                      "transition-colors",
                      isActive
                        ? "text-blue-400"
                        : "text-[var(--text-subtle)] group-hover:text-white"
                    )}
                  />
                  {badge !== null && badge !== undefined && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-3.5 px-0.5 rounded-full bg-red-500 text-white text-[9.5px] font-bold flex items-center justify-center border border-[var(--surface)] shadow-sm">
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        ) : (
          <nav className="p-3 space-y-1.5">
            {items.map(({ id, label, Icon, badge }) => {
              const isActive = active === id;
              return (
                <button
                  key={id}
                  onClick={() => onNavigate(id)}
                  className={cn(
                    "w-full flex items-center justify-between px-3.5 py-2.5 rounded-md text-sm font-medium transition-all duration-150 group cursor-pointer",
                    isActive
                      ? "bg-white/[0.08] text-white shadow-sm font-semibold"
                      : "text-[var(--text-muted)] hover:text-white hover:bg-[var(--surface-2)]/70"
                  )}
                  aria-current={isActive ? "page" : undefined}
                >
                  <div className="flex items-center gap-3">
                    <Icon
                      size={18}
                      strokeWidth={isActive ? 2.2 : 1.8}
                      className={cn(
                        "transition-colors",
                        isActive
                          ? "text-blue-400"
                          : "text-[var(--text-subtle)] group-hover:text-white"
                      )}
                    />
                    <span>{label}</span>
                  </div>

                  {badge !== null && badge !== undefined && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        )}
      </div>

      {/* Footer Area: Engine Status & User Identity */}
      {collapsed ? (
        <div className="p-1.5 sm:p-2 border-t border-[var(--border)] space-y-2 flex flex-col items-center">
          {/* Engine Status Dot Widget */}
          <div
            className={cn(
              "w-9 h-8 sm:w-10 sm:h-9 md:w-11 md:h-9 rounded-md border flex items-center justify-center transition-colors cursor-default",
              currentGov.bgClass
            )}
            title={`${currentGov.label} (${activePairCount} pair${activePairCount === 1 ? "" : "s"})`}
          >
            <span
              className={cn(
                "w-2.5 h-2.5 rounded-full shrink-0",
                currentGov.dotClass,
                govKind === "running" && "animate-pulse"
              )}
            />
          </div>

          {/* Authenticated Google Account / Connect Button */}
          {authed ? (
            <button
              type="button"
              onClick={() => onNavigate("settings")}
              className="w-9 h-9 sm:w-10 sm:h-10 md:w-11 md:h-11 rounded-md hover:bg-[var(--surface-2)] transition-all border border-transparent hover:border-[var(--border)] cursor-pointer flex items-center justify-center group relative"
              title={`Connected: ${userProfile?.name ?? "Google User"} (${userProfile?.email ?? "Google Drive"})`}
            >
              {userProfile?.picture ? (
                <img
                  src={userProfile.picture}
                  alt={userProfile.name ?? "User"}
                  className="w-7 h-7 sm:w-8 sm:h-8 rounded-full object-cover border border-white/10 shrink-0"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-blue-600/30 border border-blue-500/30 text-blue-300 font-semibold flex items-center justify-center text-xs shrink-0">
                  {userProfile?.name ? userProfile.name[0].toUpperCase() : "G"}
                </div>
              )}
              <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-[#14171d] border border-white/15 flex items-center justify-center shadow-sm">
                <img
                  src={gdLogo}
                  alt=""
                  style={{ width: 10, height: 10 }}
                  className="w-2 sm:w-2.5 h-2 sm:h-2.5 object-contain"
                />
              </div>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate("settings")}
              className="w-9 h-9 sm:w-10 sm:h-10 md:w-11 md:h-11 rounded-md bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 border border-blue-500/25 flex items-center justify-center transition-colors cursor-pointer"
              title="Connect Google Drive"
            >
              <img
                src={gdLogo}
                alt="Google Drive"
                style={{ width: 18, height: 18, minWidth: 16, maxWidth: 18 }}
                className="w-4 h-4 sm:w-[18px] sm:h-[18px] object-contain shrink-0"
              />
            </button>
          )}
        </div>
      ) : (
        <div className="p-3.5 border-t border-[var(--border)] space-y-2.5">
          {/* Subtle Engine Status Widget */}
          <div
            className={cn(
              "px-3.5 py-2.5 rounded-md border flex items-center justify-between text-xs transition-colors",
              currentGov.bgClass
            )}
          >
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  "w-2.5 h-2.5 rounded-full shrink-0",
                  currentGov.dotClass,
                  govKind === "running" && "animate-pulse"
                )}
              />
              <span className={cn("font-semibold text-xs", currentGov.textClass)}>
                {currentGov.label}
              </span>
            </div>
            <span className="text-xs text-[var(--text-subtle)] code-text">
              {activePairCount} pair{activePairCount === 1 ? "" : "s"}
            </span>
          </div>

          {/* Authenticated Google Account Pill */}
          {authed ? (
            <div
              onClick={() => onNavigate("settings")}
              className="p-2.5 rounded-md hover:bg-[var(--surface-2)] transition-all border border-transparent hover:border-[var(--border)] cursor-pointer flex items-center gap-3 group"
              title="Google Account Settings"
            >
              {userProfile?.picture ? (
                <img
                  src={userProfile.picture}
                  alt={userProfile.name ?? "User"}
                  className="w-9 h-9 rounded-full object-cover border border-white/10 shrink-0"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-blue-600/30 border border-blue-500/30 text-blue-300 font-semibold flex items-center justify-center text-sm shrink-0">
                  {userProfile?.name ? userProfile.name[0].toUpperCase() : "G"}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate leading-tight">
                  {userProfile?.name ?? "Google User"}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <img
                    src={gdLogo}
                    alt="Google Drive"
                    style={{ width: 14, height: 14, minWidth: 14, maxWidth: 14 }}
                    className="w-3.5 h-3.5 object-contain shrink-0"
                  />
                  <p className="text-xs text-[var(--text-muted)] truncate leading-tight">
                    {userProfile?.email ?? "Connected"}
                  </p>
                </div>
              </div>
              <ChevronRight
                size={15}
                className="text-[var(--text-subtle)] group-hover:text-white shrink-0 transition-transform group-hover:translate-x-0.5"
              />
            </div>
          ) : (
            <button
              onClick={() => onNavigate("settings")}
              className="w-full py-2.5 px-3.5 rounded-md bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 border border-blue-500/25 text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <img
                src={gdLogo}
                alt="Google Drive"
                style={{ width: 15, height: 15, minWidth: 15, maxWidth: 15 }}
                className="w-[15px] h-[15px] object-contain shrink-0"
              />
              Connect Google Drive
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
