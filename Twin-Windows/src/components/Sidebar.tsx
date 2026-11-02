/** Left sidebar navigation. */
import { Home, Activity, ArchiveRestore, Settings, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

export type Screen = "home" | "activity" | "restore" | "settings";

interface SidebarProps {
  active: Screen;
  onNavigate: (s: Screen) => void;
}

const items: { id: Screen; label: string; Icon: LucideIcon }[] = [
  { id: "home",     label: "Home",     Icon: Home },
  { id: "activity", label: "Activity", Icon: Activity },
  { id: "restore",  label: "Restore",  Icon: ArchiveRestore },
  { id: "settings", label: "Settings", Icon: Settings },
];

export function Sidebar({ active, onNavigate }: SidebarProps) {
  const authed = useStore((s) => s.authed);
  const userProfile = useStore((s) => s.userProfile);

  return (
    <nav
      style={{
        width: 200,
        minWidth: 200,
        borderRight: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        paddingTop: 16,
        gap: 2,
      }}
      aria-label="Main navigation"
    >
      {items.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => onNavigate(id)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm text-left w-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset",
            active === id
              ? "bg-[var(--surface-2)] text-[var(--text)] font-medium border-l-2 border-[var(--accent)]"
              : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] border-l-2 border-transparent"
          )}
          style={{ borderRadius: 0 }}
          aria-current={active === id ? "page" : undefined}
        >
          <Icon size={16} strokeWidth={1.5} />
          {label}
        </button>
      ))}

      {authed && (
        <div
          onClick={() => onNavigate("settings")}
          style={{
            marginTop: "auto",
            padding: "12px 14px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            cursor: "pointer",
          }}
          className="hover:bg-[var(--surface-2)] transition-colors"
          title="Account Settings"
        >
          {userProfile?.picture ? (
            <img
              src={userProfile.picture}
              alt={userProfile.name ?? "User"}
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                objectFit: "cover",
                border: "1px solid var(--border)",
                flexShrink: 0,
              }}
              referrerPolicy="no-referrer"
            />
          ) : (
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--accent)",
                flexShrink: 0,
              }}
            >
              {userProfile?.name ? userProfile.name[0].toUpperCase() : (userProfile?.email ? userProfile.email[0].toUpperCase() : "G")}
            </div>
          )}
          <div style={{ minWidth: 0, overflow: "hidden", lineHeight: 1.2 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {userProfile?.name ?? "Google Account"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {userProfile?.email ?? "Connected"}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
