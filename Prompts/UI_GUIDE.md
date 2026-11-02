# UI GUIDE: Professional Look (applies to P01 and P10, and any UI change)
Goal: calm, precise, utilitarian. Think Linear, Vercel dashboard, 1Password, Windows 11 Settings. Nothing decorative.

## Forbidden
- Glows, neon shadows, glassmorphism, gradients on buttons/cards/text, rainbow accents.
- Bouncy/spring animations, pulsing, shimmer, confetti, emojis in UI text, mascots, decorative illustrations.
- Oversized rounded "pill" buttons, heavy drop shadows, thick borders, ALL CAPS text, gradient progress bars.
- More than one accent color. Colored backgrounds behind whole sections.

## Foundations
- **Font:** `Inter` is NOT bundled (no extra deps); use system stack `"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`. Mono for paths/sizes: `"Cascadia Mono", Consolas, monospace`.
- **Type scale:** 12 (meta), 13 (body/tables), 14 (default), 16 (section title), 20 (page title). Weights 400/500/600 only. Line height 1.4-1.5.
- **Spacing:** 4px grid (4, 8, 12, 16, 24, 32). Page padding 24. Card padding 16. Gap between cards 12.
- **Radius:** 6px for inputs/buttons, 8px for cards/dialogs. Nothing larger.
- **Borders over shadows:** 1px borders; shadows only on popovers/dialogs (`0 4px 16px rgba(0,0,0,.12)`).
- **Icons:** lucide-react, 16px, stroke 1.5, same color as text. No colored icon backgrounds.

## Color tokens (CSS variables; light / dark)
```
--bg:        #FAFAFA / #0F1012
--surface:   #FFFFFF / #17181B
--surface-2: #F4F4F5 / #1E2024
--border:    #E4E4E7 / #2A2C31
--text:      #18181B / #ECECEE
--text-muted:#71717A / #9A9AA3
--accent:    #2563EB / #3B82F6   (single accent: primary buttons, focus ring, progress fill)
--success:   #16A34A / #22C55E   (text/icon only, small dot)
--warning:   #D97706 / #F59E0B
--danger:    #DC2626 / #EF4444
```
Status is shown by a 8px dot + text label ("Syncing", "Paused: high CPU"), never by large colored banners.

## Components
- **Buttons:** primary = solid accent, white text, 32px height, 6px radius, no shadow. Secondary = surface + 1px border. Ghost = text only. Hover = slight background shift (5-8% darker), focus = 2px accent outline offset 2px. Disabled = 50% opacity. No scale/transform effects.
- **Progress bars:** 6px tall, radius 3px, track `--surface-2`, fill `--accent`, flat color, width driven only by real bytes. Under it one muted 12px mono line: `1.2 GB of 4.8 GB  ·  12.4 MB/s  ·  ETA 06:40`. Width transition max 150ms linear.
- **Cards:** surface background, 1px border, no shadow. Header row: title (14/600) left, actions right.
- **Lists/tables:** 36px rows, 1px dividers, hover = `--surface-2`. Right-align numbers. Truncate paths in the middle with full path in title tooltip.
- **Inputs:** 32px, 1px border, 6px radius, label above (12/500 muted). Inline validation text under field in danger color.
- **Dialogs:** max 480px, title + short description + actions right-aligned (secondary then primary). Escape closes.
- **Toasts (sonner):** errors only, bottom-right, flat, 4s, with action button when useful.
- **Empty states:** one muted line + one primary action. No illustrations.
- **Tabs:** underline style, 2px accent underline on active.

## Layout
- Left sidebar 200px (Home, Activity, Restore, Settings), icon+label, active item = `--surface-2` background with 2px accent bar on the left edge. Content max-width 880px.
- Header on Home: status dot + label, then Pause/Resume and Sync now (secondary buttons). Nothing else.
- Settings uses a single column of sections with 1px dividers; **Advanced** is a collapsed section (chevron).
- Dense but breathable: prefer one card per concern, no nested cards.

## Motion
- Only: 150ms fade for dialogs/tabs, 150ms progress width. Respect `prefers-reduced-motion` (disable all). No animation while idle or window hidden.

## Copy
Sentence case. Plain, specific, short: "Couldn't upload report.pdf. Retrying in 30 s." Not "Oops!". No exclamation marks. Numbers use thousand separators; sizes in KB/MB/GB (1024 base shown as MB/GB); times as `14:32` or "2 min ago".

## Accessibility
Contrast >= 4.5:1, visible focus ring, full keyboard navigation, `aria-valuenow/min/max` on progress bars, no information by color alone.

## Done-check (agent must self-verify before finishing any UI work)
[ ] No gradients/glows/emojis  [ ] Only accent color is blue  [ ] Radius <= 8px  [ ] Progress bars bound to real bytes  [ ] Works in light and dark  [ ] Keyboard-navigable  [ ] No animation while idle
