# updater-cli — JioTv Max Release CLI

An interactive, pro-grade release CLI that coordinates the entire app-update release in one place.

---

## 30-Second Quickstart

```powershell
# From the repository root:
.\release.cmd

# Or from inside updater-cli:
cd updater-cli
npm start
```

### Authentication
No manual token setup is needed if you are logged into Git on Windows—the CLI automatically pulls authentication from your **Git Credential Manager** (`git credential fill`). Alternatively, you can explicitly set `GITHUB_TOKEN` or `GH_TOKEN` in your environment.

That's it. The wizard guides you through everything:
- Version bump with live preview
- Release notes review (opens in editor if you want)
- Pre-flight checks with fix hints
- Summary card — nothing irreversible before you confirm
- Live GitHub Actions dashboard in your terminal
- Automated post-release verification (installer, delta `.blockmap`, and `latest.yml`)

---

## Commands

| Command | What it does |
|---------|--------------|
| `.\release.cmd` | **Full end-to-end release workflow** (bump → push → live build progress → delta blockmap → verification) |
| `.\release.cmd status` | Check version, published release assets, and update health |
| `.\release.cmd token` | Configure or update stored GitHub token in `~/.jiotv-max-updater.json` |
| `.\release.cmd --help` | Full flags reference |

> **Note**: Progress monitoring and delta blockmaps are **not separate opt-in tasks**. When you initiate a release, the CLI automatically streams the live GitHub Actions progress bars in your terminal and automatically verifies and uploads the delta `.blockmap`.

### Flags (non-interactive)

| Flag | Description |
|------|-------------|
| `--bump patch\|minor\|major\|prerelease\|<semver>` | Skip bump prompt |
| `--yes` | Skip all confirmation prompts |
| `--dry-run` | Print all actions without executing anything |
| `--simulate` | Replay a fake GitHub Actions run (UI demo, no push needed) |
| `--no-banner` | Skip the ASCII art banner |
| `--verbose` | Show full stack traces on errors |

---

## How the Dashboard Works

After the tag is pushed, the CLI:

1. **Finds the run** — polls `GET /repos/{owner}/{repo}/actions/runs?head_sha=<sha>` until GitHub registers the new run (up to 60s).
2. **Polls every 3s** — fetches run status and per-job details using ETag conditional requests to respect rate limits.
3. **Renders in-place** — `log-update` overwrites the same terminal lines each poll cycle. No scroll spam.
4. **Computes ETA** — averages the last 5 successful run durations from the API.
5. **Per-job progress** — calculated from completed steps / total steps with 0.5× weight for in-progress steps.
6. **Ctrl+C** — detaches the dashboard (run continues on GitHub), restores cursor, prints the URL.

Example output:

```
 Release v1.0.1 · run #42 · 01:48 elapsed · ETA ~03:10
 ✔ install-deps    ████████████████████ 100%  Install dependencies      0:18
 ◐ release         ████████░░░░░░░░░░░░  41%  Run TypeScript typecheck  0:56
 Overall           ████████░░░░░░░░░░░░  41%
```

---

## Auth

The CLI reads your GitHub token in this order:
1. `GITHUB_TOKEN` environment variable
2. `GH_TOKEN` environment variable
3. _(no fallback — you get a clear message with instructions)_

The token is **never printed or logged**, even with `--verbose`.

**Required token scopes:** `repo` (to read releases and workflow runs).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `GitHub authentication failed` | Set `GITHUB_TOKEN` env var (needs `repo` scope) |
| `Timed out waiting for workflow run` | Check if the push triggered correctly at `github.com/{owner}/{repo}/actions` |
| `Push failed` | The local commit + tag are automatically rolled back. Fix (e.g. pull) and retry. |
| `Tag already exists` | Delete it first: `git tag -d v1.x.x && git push origin :refs/tags/v1.x.x` |
| Dashboard shows wrong ETA | Normal on first run — averages improve after a few successful releases |
| Cursor stuck after crash | Run `printf '\033[?25h'` (Unix) or restart the terminal |
| npm runs fail on Windows | Try `run.cmd` directly from CMD instead of PowerShell if script execution is restricted |

---

## What Is NOT Automated

- Editing `release.yml` — the CLI will show a proposed diff and ask before touching it
- macOS / Linux builds — only Windows is configured in the workflow and `package.json` build
- Force pushing or `git reset --hard` — explicitly forbidden

---

## Tests

```powershell
npm test
```

Covers: semver bump logic, YAML parsing, step progress calculation, ETA math, git-root detection, rollback behavior.
