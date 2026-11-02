/** Left sidebar navigation. */
import { Home, Activity, ArchiveRestore, Settings, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

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
    </nav>
  );
}
