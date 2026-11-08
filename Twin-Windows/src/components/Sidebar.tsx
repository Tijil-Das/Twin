/**
 * Desktop Sidebar Navigation
 * Refined, native-feeling shell navigation with live engine telemetry,
 * notification indicators, and authenticated Google identity badge.
 */
import {
  Activity as ActivityIcon,
  Settings as SettingsIcon,
  Cloud,
  Layers,
  type LucideIcon,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import appLogo from "@/assets/icon.png";
import gdLogo from "@/assets/gd-icon.png";

export type Screen = "home" | "activity" | "settings";

interface SidebarProps {
  active: Screen;
  onNavigate: (s: Screen) => void;
}

interface NavItem {
  id: Screen;
  label: string;
  Icon: LucideIcon;
  badge?: number | null;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  const authed = useStore((s) => s.authed);
  const userProfile = useStore((s) => s.userProfile);
  const gov = useStore((s) => s.gov);
  const queueStatus = useStore((s) => s.queueStatus);
  const pairs = useStore((s) => s.pairs);

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
      className="w-64 min-w-[16rem] h-screen bg-[var(--surface)] border-r border-[var(--border)] flex flex-col justify-between select-none z-20 shrink-0"
      aria-label="Application sidebar"
    >
      {/* Brand Header */}
      <div>
        <div className="h-16 px-4 flex items-center justify-between border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl overflow-hidden border border-white/10 shrink-0 bg-[#1e222b] flex items-center justify-center shadow-sm">
              <img
                src={appLogo}
                alt="Twin"
                className="w-full h-full object-cover"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm tracking-tight text-white">
                  Twin
                </span>
                <span className="text-xs text-[var(--text-subtle)] font-mono px-1.5 py-0.2 rounded bg-white/5 border border-white/5">
                  v1.1
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)] leading-tight mt-0.5">
                Continuous Drive Sync
              </p>
            </div>
          </div>
        </div>

        {/* Navigation list */}
        <nav className="p-3 space-y-1.5">
          {items.map(({ id, label, Icon, badge }) => {
            const isActive = active === id;
            return (
              <button
                key={id}
                onClick={() => onNavigate(id)}
                className={cn(
                  "w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group cursor-pointer",
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
      </div>

      {/* Footer Area: Engine Status & User Identity */}
      <div className="p-3.5 border-t border-[var(--border)] space-y-2.5">
        {/* Subtle Engine Status Widget */}
        <div
          className={cn(
            "px-3.5 py-2.5 rounded-xl border flex items-center justify-between text-xs transition-colors",
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
            className="p-2.5 rounded-xl hover:bg-[var(--surface-2)] transition-all border border-transparent hover:border-[var(--border)] cursor-pointer flex items-center gap-3 group"
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
            className="w-full py-2.5 px-3.5 rounded-xl bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 border border-blue-500/25 text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Cloud size={15} />
            Connect Google Drive
          </button>
        )}
      </div>
    </aside>
  );
}
