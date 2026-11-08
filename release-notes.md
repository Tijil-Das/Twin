# Twin v1.1.4

UI refinement and updater polish eliminating duplicate notification cards when a new update is ready to install.

---

### ✨ What's New in v1.1.4

#### 🎨 Eliminated Duplicate Update Notification Cards
- **Consolidated UI**: Removed the redundant Sonner toast listener that rendered directly on top of the dedicated floating **UpdateBanner** card.
- **Single Polished Banner**: When a background update finishes downloading, only the official floating card (`Update vX.Y.Z Ready`) appears at the bottom-right with the styled `Restart` action and `X` dismiss control.
- **Immediate State Feedback**: Clicking `Restart` transitions the button to `Applying…` with an active spinner, preventing duplicate clicks while the update applies.
