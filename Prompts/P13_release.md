# P13 GitHub Actions Release
Read MASTER.md COMMON RULES and SPEC.md. Touch only `.github/workflows/`, `README.md`, `.gitignore`.
## Do
1. `.github/workflows/release.yml`: trigger on tag `v*`. Runner `windows-latest`. Steps: checkout, setup pnpm + Node 20, install Rust stable, cache cargo (`Swatinem/rust-cache`) and pnpm, `pnpm install --frozen-lockfile`, `pnpm tauri build`, upload `.msi`/`.exe` NSIS bundle to a GitHub Release via `softprops/action-gh-release`.
2. `.github/workflows/ci.yml` on PR/push: `cargo clippy -- -D warnings`, `cargo test`, `pnpm tsc --noEmit`.
3. `tauri.conf.json` bundle: NSIS target only, `installMode: perUser` (no admin), WebView2 `downloadBootstrapper`.
4. `.gitignore`: `config/config.local.toml`, `data/`, `target/`, `node_modules/`, `*.log`. Keep `config/config.toml` and `config/sync-state.json` tracked.
5. `README.md`: new machine setup in 5 steps: (1) `git clone`, (2) install release exe OR `pnpm install && pnpm tauri build`, (3) run, put exe beside the repo `config/` folder (app finds config via its own folder, or `TETHER_HOME` env var), (4) Settings -> add Google client id/secret, login, (5) Settings -> GitHub token, Pull now, map local paths in `config.local.toml`.
## Done-test
Pushing tag `v0.1.0` produces a Release with installer; installer runs without admin; app launches and finds `config/` next to it.
