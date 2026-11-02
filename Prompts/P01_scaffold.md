# P01 Scaffold
Read MASTER.md COMMON RULES and SPEC.md.
## Do
1. `pnpm create tauri-app tether --template react-ts --manager pnpm`. Tauri 2.
2. Add Tailwind CSS (official Vite guide) and init shadcn/ui; add components: button, card, progress, tabs, switch, input, dialog, toast(sonner) only.
3. Add Rust deps ONLY: tauri (features: tray-icon), tauri-plugin-single-instance, tauri-plugin-autostart, tauri-plugin-notification, serde, serde_json, tokio (rt-multi-thread, macros, sync, time, fs), tracing, tracing-subscriber.
4. `src-tauri/src/error.rs`: hand-written `enum AppError { Io(String), Config(String), Auth(String), Db(String), Network(String), Drive(String), Other(String) }` implementing Display, Error, From<std::io::Error>, and Serialize (as string).
5. Tray: icon with 4 states (idle=green, syncing=blue, paused=amber, error=red) generated as 32x32 PNGs placed in `src-tauri/icons/tray/`. Function `set_tray_state(app:&AppHandle, s:TrayState)`. Menu: Open, Pause/Resume, Sync now, Quit. Left-click opens window.
6. Closing the window HIDES it (app keeps running in tray). Start hidden if arg `--hidden`.
7. Single instance: second launch focuses the existing window.
8. Main window 900x600, min 700x480. Placeholder React page "Tether" with a Tailwind card.
9. Set process priority BELOW_NORMAL at startup using windows-sys `SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)` (add windows-sys with features Win32_System_Threading, Win32_Foundation).
10. tracing logs to stdout only, level info.
## Done-test
`pnpm tauri dev` shows window; closing hides it; tray menu works; launching twice keeps one process; Task Manager shows Below normal priority; idle CPU 0%. `cargo clippy -- -D warnings` clean.
