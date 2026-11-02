# Twin

> **Real-Time Bidirectional Google Drive Sync for Windows**  
> Lightweight, transparent, developer-grade file synchronization built with Tauri v2, Rust, and React.

---

## Architecture & Repository Layout

Following the multi-platform segregation convention (matching JioTV Max and Aurix), the repository is organized into dedicated platform modules:

```
Twin/
├── Twin-Windows/          # Windows Desktop Application
│   ├── src/               # React 18 frontend (TypeScript + Tailwind CSS + Lucide)
│   ├── src-tauri/         # Rust core engine (Tauri v2 + SQLite WAL + Tokio)
│   │   ├── src/           # Drive client, sync engine, resource governor, watcher
│   │   └── tests/         # Comprehensive test & torture suites (T1–T12)
│   ├── config/            # Default pair mappings & runtime config
│   └── scripts/           # Verification scripts (test ratio, canary, soak, governor)
├── Website/               # Official Twin showcase & landing site
├── Icon-Pack/             # Production application and tray iconography
└── Prompts/               # Architecture specs, UI guide, and testing directives
```

---

## Key Capabilities

- **Zero-Friction Consumer Experience**: One-click Google Sign-In with loopback OAuth (`http://127.0.0.1:<port>`). Non-technical users never need to generate or paste API keys, client secrets, or GitHub tokens.
- **Hidden Cloud Config Sync**: App settings and sync pair manifests are automatically synchronized to Google Drive's private `appDataFolder` (`twin-config.toml` and per-device manifests `device-{hostname}.json`), keeping your Drive root clean.
- **Micro Resource Footprint**: Autonomous **Resource Governor** guarantees `< 50 MB` idle RAM, `< 0.1%` idle CPU, and automatically throttles during heavy system load or battery operation.
- **Crash & Partition Resilient**: Atomic transactions, SQLite Write-Ahead Logging (WAL), SHA-256 integrity verification, and automatic exponential backoff.
- **Conflict Safe**: Concurrent file modifications are automatically preserved as non-destructive forks (`.conflict-YYYYMMDD-HHMMSS-{hostname}`) with zero silent data loss.

---

## Development & Building

### Prerequisites
- [Rust](https://rustup.rs/) (stable toolchain)
- [Node.js](https://nodejs.org/) & [pnpm](https://pnpm.io/)
- Windows 10/11 with WebView2 runtime

### Running Tests
All stress tests, simulation suites, and unit tests live under `Twin-Windows/src-tauri`:

```powershell
cd Twin-Windows
cargo test
```

To run the verification scripts:
```powershell
powershell -ExecutionPolicy Bypass -File Twin-Windows/scripts/test_ratio.ps1
powershell -ExecutionPolicy Bypass -File Twin-Windows/scripts/canary.ps1
```

---

## License
MIT License. See [LICENSE](LICENSE) for details.
