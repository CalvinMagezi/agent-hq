/**
 * Plugin-local types for the Obsidian vault sync plugin.
 */

export interface VaultSyncSettings {
  /** WebSocket server URL (ws:// or wss://) */
  serverUrl: string;
  /** Human-readable device name */
  deviceName: string;
  /** E2E encryption passphrase */
  encryptionPassphrase: string;
  /** Auto-start sync on plugin load */
  autoSync: boolean;
  /** Fallback poll interval (ms) */
  syncIntervalMs: number;
  /** Conflict resolution strategy */
  conflictStrategy: "newer-wins" | "merge-frontmatter" | "manual";
  /** Enable E2E encryption */
  enableE2E: boolean;
  /** Debug logging to console */
  debug: boolean;

  // ─── Persisted state (not user-editable) ──────────────────
  /** Stable device ID (generated on first load) */
  deviceId?: string;
  /** Device auth token from server */
  deviceToken?: string;
  /** Last synced changeId (our cursor) */
  lastSyncChangeId?: number;
  /** Tracked file hashes: path → contentHash */
  fileHashes?: Record<string, string>;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: "ws://127.0.0.1:18800",
  deviceName: "",
  encryptionPassphrase: "",
  autoSync: true,
  syncIntervalMs: 30_000,
  conflictStrategy: "merge-frontmatter",
  enableE2E: true,
  debug: false,
};

export type SyncStatus =
  | "disconnected"
  | "connecting"
  | "syncing"
  | "synced"
  | "error";
