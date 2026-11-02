# P10 UI
Read MASTER.md COMMON RULES and SPEC.md. Frontend only (`src/`). Use shadcn components, Tailwind, Zustand, lucide-react. Calm, minimal design: neutral background, one accent color, rounded-xl cards, system font. Support light/dark by system.
## State (Zustand `store.ts`)
`pairs, activity[], progressByJob{}, batch, govState, auth, conflicts[]`. Subscribe once at app start to events: `transfer://progress`, `governor://state`, `auth://changed`, `sync://conflict`. When the window is hidden (`document.visibilityState`) stop updating progress state (drop events) and refresh from `queue_status` on show.
## Screens (tabs)
1. **Home**: header with big status pill (Idle/Syncing/Paused(reason)/Error) and Pause/Resume + Sync now. List of pair cards: local path -> Drive name, mode badge, last sync time, a real `Progress` bar (bytes_done/bytes_total) with text "x MB of y MB, 12.4 MB/s, ETA 02:31" shown only while that pair transfers. Top batch bar: "Syncing 12 of 340 files, 1.2 GB of 4.8 GB, ETA 06:40". "Add folder" opens dialog: native folder picker via `@tauri-apps/plugin-dialog`? NOT allowed; use a text input with Browse implemented by backend command `pick_folder` (use `rfd`? NOT allowed) -> instead a text input with path validation command `validate_path`. Drive folder: input for folder ID or URL (parse ID from URL), plus a "Browse Drive" dialog using `drive_list`.
2. **Activity**: virtualized-free simple list (max 200), columns time, action, file, result; failed rows have Retry button (`retry_job`); filter All/Failed.
3. **Restore**: breadcrumb Drive browser (`drive_list`), checkbox select, side panel with revisions list for a selected file (date, size, "keep forever" toggle, Restore button), "Trash" sub-tab with Restore. Destination picker text input (default original path). Restore shows its own progress bar + ETA.
4. **Settings**: Account (login/logout, client_id/secret inputs, storage quota bar from `about.get?fields=storageQuota`), General (start with Windows, parallel transfers slider 1-8), collapsed **Advanced**: rules (include/exclude textarea, max size), bandwidth, active hours, conflict & deletion policy dropdowns, governor thresholds, GitHub sync (repo, branch, token input, "Push now", "Pull now", last push time).
5. Conflict dialog when `ask` conflicts arrive: shows both versions (size, date) and 3 buttons.
## Progress rules
Bars bind ONLY to `bytes_done/bytes_total` from events. No indeterminate/fake animation; if total unknown show "Calculating..." text with no bar. ETA formatted mm:ss or h:mm:ss, hidden if None. Do not use CSS animations when idle.
Error toasts only (sonner), never success toasts.
## Done-test
`pnpm tsc --noEmit` clean; with a mock event emitter script (`src/dev/mockEvents.ts`) bars advance exactly with the sent bytes, ETA updates, hidden window drops events; every screen renders without console errors; idle React renders = 0 (verify with React Profiler).
