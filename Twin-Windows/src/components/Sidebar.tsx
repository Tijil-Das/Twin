/**
 * Pro Sidebar Navigation — Brand header, live engine status pill, 
 * navigation links with badge counts, and connected Google account card.
 */
import {
  FolderSync,
  Activity as ActivityIcon,
  ArchiveRestore,
  Settings as SettingsIcon,
  Cloud,
  Layers,
  CheckCircle2,
  AlertCircle,
  PauseCircle,
  type LucideIcon,
  ChevronRight,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

export type Screen = "home" | "activity" | "restore" | "settings";

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
    { id: "restore", label: "Drive & Restore", Icon: ArchiveRestore },
    { id: "settings", label: "Settings", Icon: SettingsIcon },
  ];

  const govColors: Record<string, { bg: string; dot: string; label: string }> = {
    Running: {
      bg: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
      dot: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]",
      label: "Engine Active",
    },
    Throttled: {
      bg: "bg-amber-500/10 border-amber-500/20 text-amber-400",
      dot: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]",
      label: "Throttled",
    },
    Paused: {
      bg: "bg-zinc-500/10 border-zinc-500/20 text-zinc-400",
      dot: "bg-zinc-400",
      label: "Engine Paused",
    },
  };

  const currentGov = govColors[gov.state] ?? govColors.Running;

  return (
    <aside
      className="w-56 min-w-[14rem] h-screen bg-[var(--surface)] border-r border-[var(--border)] flex flex-col justify-between select-none z-20"
      aria-label="Main application sidebar"
    >
      {/* Top Brand Header */}
      <div>
        <div className="px-4 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img
              src="/32x32.png"
              alt="Twin"
              className="w-8 h-8 rounded-lg shadow-md shadow-emerald-500/10 border border-white/10 shrink-0 object-cover"
            />
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-sm tracking-tight text-[var(--text)]">Twin</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.2 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20">
                  Pro
                </span>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] leading-none mt-0.5">
                Drive Sync Engine
              </p>
            </div>
          </div>
        </div>

        {/* Navigation list */}
        <nav className="p-2 space-y-1 mt-2">
          {items.map(({ id, label, Icon, badge }) => {
            const isActive = active === id;
            return (
              <button
                key={id}
                onClick={() => onNavigate(id)}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150 group",
                  isActive
                    ? "bg-blue-600/15 text-blue-400 border border-blue-500/25 shadow-sm"
                    : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] border border-transparent"
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <div className="flex items-center gap-2.5">
                  <Icon
                    size={16}
                    strokeWidth={isActive ? 2 : 1.75}
                    className={cn(
                      "transition-colors",
                      isActive ? "text-blue-400" : "text-[var(--text-muted)] group-hover:text-[var(--text)]"
                    )}
                  />
                  <span>{label}</span>
                </div>

                {badge !== null && badge !== undefined && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer Area: Live Status Pill & Account Card */}
      <div className="p-3 border-t border-[var(--border)] space-y-2">
        {/* Engine status mini card */}
        <div
          className={cn(
            "px-2.5 py-2 rounded-lg border flex items-center justify-between text-xs transition-colors",
            currentGov.bg
          )}
        >
          <div className="flex items-center gap-2">
            <span className={cn("w-2 h-2 rounded-full", currentGov.dot)} />
            <span className="font-medium text-[11px]">{currentGov.label}</span>
          </div>
          <span className="text-[10px] text-[var(--text-muted)] font-mono">
            {pairs.filter((p) => p.enabled).length} pairs
          </span>
        </div>

        {/* Google Account Profile or Connect Banner */}
        {authed ? (
          <div
            onClick={() => onNavigate("settings")}
            className="p-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors border border-transparent hover:border-[var(--border)] cursor-pointer flex items-center gap-2.5 group"
            title="Google Account Settings"
          >
            {userProfile?.picture ? (
              <img
                src={userProfile.picture}
                alt={userProfile.name ?? "User"}
                className="w-7 h-7 rounded-full object-cover border border-white/10 shrink-0"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-semibold flex items-center justify-center text-xs shrink-0 shadow-sm">
                {userProfile?.name ? userProfile.name[0].toUpperCase() : "G"}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-[var(--text)] truncate leading-tight">
                {userProfile?.name ?? "Google User"}
              </p>
              <p className="text-[10px] text-[var(--text-muted)] truncate leading-tight">
                {userProfile?.email ?? "Connected"}
              </p>
            </div>
            <ChevronRight size={13} className="text-[var(--text-muted)] group-hover:text-[var(--text)] shrink-0 transition-transform group-hover:translate-x-0.5" />
          </div>
        ) : (
          <button
            onClick={() => onNavigate("settings")}
            className="w-full py-1.5 px-2.5 rounded-lg bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 border border-blue-500/20 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <Cloud size={13} />
            Connect Google Drive
          </button>
        )}
      </div>
    </aside>
  );
}
