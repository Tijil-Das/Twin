/**
 * Typed wrappers around Tauri `invoke` for all backend commands.
 */
import { invoke } from "@tauri-apps/api/core";

// ── Config types ───────────────────────────────────────────────────────────────

export type PairMode = "upload" | "two_way" | "mirror";

export interface PairEntry {
  id: string;
  local: string;
  drive_folder_id: string;
  mode: PairMode;
  enabled: boolean;
  deletion?: "ignore" | "drive_trash" | "delete";
}

export interface PolicyConfig {
  conflict: "newer_wins" | "keep_both" | "ask";
  deletion: "ignore" | "drive_trash" | "delete";
}

export interface LimitsConfig {
  upload_kbps: number;
  download_kbps: number;
  parallel_transfers: number;
  active_hours: string | null;
}

export interface GovernorConfig {
  cpu_pause_pct: number;
  cpu_resume_pct: number;
  battery_pause_pct: number;
  pause_on_metered: boolean;
}

export interface AppConfig {
  parallel_transfers: number;
  autostart: boolean;
  color_drive_folders?: boolean;
}

export interface GitHubConfig {
  repo: string;
  branch: string;
  last_push: string | null;
}

export interface Config {
  pairs?: PairEntry[];
  pair?: PairEntry[];
  policy: PolicyConfig;
  limits: LimitsConfig;
  governor: GovernorConfig;
  app: AppConfig;
  github: GitHubConfig;
}

// ── DB types ───────────────────────────────────────────────────────────────────

export interface Activity {
  id: number | null;
  ts_ms: number;
  pair_id: string;
  kind: string;
  rel_path: string;
  result: string;
  detail: string | null;
}

// ── Drive types ────────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string | null;
  size: string | null;
  modified_time: string | null;
  modifiedTime?: string | null;
  mime_type: string | null;
  mimeType?: string | null;
  parents: string[] | null;
  shared?: boolean | null;
  folderColorRgb?: string | null;
  folder_color_rgb?: string | null;
}

export interface Revision {
  id: string;
  modified_time: string | null;
  size: string | null;
  keep_forever: boolean | null;
  original_filename: string | null;
}

export interface TrashedFile {
  id: string;
  name: string | null;
  trashed_time: string | null;
  size: string | null;
}

// ── Governor ───────────────────────────────────────────────────────────────────

export type GovStateKind = "running" | "throttled" | "scheduled" | "user_paused";

export interface GovStatePayload {
  kind?: GovStateKind;
  state?: string;
  reason?: string | null;
  concurrency?: number;
}

// ── Sync ───────────────────────────────────────────────────────────────────────

export interface CycleReport {
  uploads_queued: number;
  downloads_queued: number;
  conflicts: number;
  deletes_queued: number;
  errors: string[];
}

// ── Queue & Per-Pair Status ───────────────────────────────────────────────────

export interface QueueStatus {
  queued: number;
  running: number;
  done?: number;
  failed: number;
}

export interface ActiveJobSummary {
  id: number;
  kind: string;
  rel_path: string;
  status: string;
}

export interface PairSyncStatus {
  pair_id: string;
  queued: number;
  running: number;
  failed: number;
  dirty: number;
  conflict: number;
  synced: number;
  total: number;
  is_synced: boolean;
  deleted?: number;
  last_sync_ms?: number | null;
  active_jobs?: ActiveJobSummary[];
  last_activity?: Activity | null;
}

// ── Invokes ───────────────────────────────────────────────────────────────────

export const getConfig = () => invoke<Config>("get_config");
export const updateConfig = (cfg: Config) => invoke<Config>("update_config", { patch: cfg });
export const addPair = (pair: PairEntry) => invoke<void>("add_pair", { pair });
export const removePair = (id: string) => invoke<void>("remove_pair", { id });

export interface GoogleUserProfile {
  email: string;
  name?: string | null;
  picture?: string | null;
}

export interface AuthStatus {
  logged_in: boolean;
  client_id_set: boolean;
  client_secret_set: boolean;
  user?: GoogleUserProfile | null;
}

export const authLogin = () => invoke<void>("auth_login");
export const authLogout = () => invoke<void>("auth_logout");
export const authStatus = () => invoke<AuthStatus>("auth_status");
export const authGetUser = () => invoke<GoogleUserProfile | null>("auth_get_user");
export const authSetClientId = (id: string) => invoke<void>("auth_set_client_id", { id });
export const authSetClientSecret = (secret: string) => invoke<void>("auth_set_client_secret", { secret });
export const authClearCredentials = () => invoke<void>("auth_clear_credentials");

export const getActivity = (limit: number) => invoke<Activity[]>("get_activity", { limit });
export const retryJob = (id: number) => invoke<void>("retry_job", { id });
export const retryAllFailed = () => invoke<number>("retry_all_failed");
export const dbCheckpointWal = () => invoke<void>("db_checkpoint_wal");

export const govState = () => invoke<GovStatePayload>("gov_state");
export const govPause = () => invoke<void>("gov_pause");
export const govResume = () => invoke<void>("gov_resume");

export const syncNow = () => invoke<void>("sync_now");
export const queueStatus = () => invoke<QueueStatus>("queue_status");
export const getPairStatuses = () =>
  invoke<Record<string, PairSyncStatus>>("get_pair_statuses");

export const driveList = (folderId: string) => invoke<DriveFile[]>("drive_list", { folderId });
export const driveListSubfolders = (parentId: string) =>
  invoke<DriveFile[]>("drive_list_subfolders", { parentId });
export const driveGetFolderMeta = (folderId: string) =>
  invoke<DriveFile>("drive_get_folder_meta", { folderId });
export const driveGetFolders = () => invoke<DriveFile[]>("drive_get_folders");
export const driveGetSharedFolders = () => invoke<DriveFile[]>("drive_get_shared_folders");
export const driveCreateFolder = (parentId: string, name: string) =>
  invoke<string>("drive_create_folder", { parentId, name });
export const driveColorFolders = (color?: string) =>
  invoke<void>("drive_color_folders", { color: color ?? null });
export const driveSetFolderColor = (folderId: string, color?: string | null) =>
  invoke<void>("drive_set_folder_color", { folderId, colorRgb: color ?? null });
export const driveSetFoldersColor = (folderIds: string[], color?: string | null) =>
  invoke<void>("drive_set_folders_color", { folderIds, colorRgb: color ?? null });
export const authHasFullScope = () => invoke<boolean>("auth_has_full_scope").catch(() => true);
export const pickFolder = () => invoke<string | null>("pick_folder");
export const openLocalPath = (path: string) => invoke<void>("open_local_path", { path });
export const openUrlExternal = (url: string) => invoke<void>("open_url_external", { url });
export const listSharedDrives = () => invoke<{ id: string; name: string }[]>("list_shared_drives").catch(() => []);
export const driveSearch = (query: string, mime?: string) =>
  invoke<DriveFile[]>("drive_search", { query, mime: mime ?? null, after: null });
export const listRevisions = (fileId: string) => invoke<Revision[]>("list_revisions", { fileId });
export const restoreFileCmd = (fileId: string, revId: string | null, dest: string) =>
  invoke<void>("restore_file_cmd", { fileId, revId, dest });
export const restoreFolderCmd = (folderId: string, dest: string, pairId: string) =>
  invoke<void>("restore_folder_cmd", { folderId, dest, pairId });
export const listTrash = (parentId?: string) =>
  invoke<TrashedFile[]>("list_trash", { parentId: parentId ?? null });
export const untrash = (fileId: string) => invoke<void>("untrash", { fileId });
export const untrashAll = () => invoke<number>("untrash_all");
export const keepRevision = (fileId: string, revId: string, keep: boolean) =>
  invoke<void>("keep_revision", { fileId, revId, keep });

export const runSyncCycle = (pairId: string) =>
  invoke<CycleReport>("run_sync_cycle", { pairId });
export const resolveConflict = (pairId: string, relPath: string, choice: string) =>
  invoke<void>("resolve_conflict", { pairId, relPath, choice });
export const validatePath = (path: string) =>
  invoke<boolean>("validate_path", { path }).catch(() => false);
export const appdataSyncNow = () => invoke<void>("appdata_sync_now");

// ── Updater types & invokes ──────────────────────────────────────────────────

export type UpdateStatusKind =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "ready"
  | "installing"
  | "up-to-date"
  | "error";

export interface UpdateStatePayload {
  status: { status: UpdateStatusKind; [key: string]: unknown };
  current_version: string;
  ready_version?: string | null;
  release_notes?: string | null;
  last_checked?: string | null;
}

export const updateGetState = () => invoke<UpdateStatePayload>("update_get_state");
export const updateCheck = () => invoke<UpdateStatePayload>("update_check");
export const updateInstall = () => invoke<void>("update_install");
export const updateClearPending = () => invoke<void>("update_clear_pending");

