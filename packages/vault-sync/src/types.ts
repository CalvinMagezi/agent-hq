/**
 * Core types for the vault-sync engine.
 */

// ─── File Change Types ─────────────────────────────────────────────

export type ChangeType = "create" | "modify" | "delete" | "rename";

export interface FileChange {
  /** Unique monotonic ID for ordering (set by ChangeLog on persist) */
  changeId: number;
  /** Relative path from vault root (forward slashes) */
  path: string;
  /** For renames, the previous path */
  oldPath?: string;
  /** Type of change detected */
  type: ChangeType;
  /** SHA-256 hash of file content after change (null for deletes) */
  contentHash: string | null;
  /** File size in bytes (null for deletes) */
  size: number | null;
  /** File mtime as Unix epoch ms */
  mtime: number | null;
  /** When the change was detected (wall clock) */
  detectedAt: number;
  /** Detection source */
  source: "watcher" | "scan" | "api" | "remote";
  /** Device ID for multi-device dedup */
  deviceId: string;
}

// ─── Version Tracking ──────────────────────────────────────────────

export interface FileVersion {
  /** Relative path from vault root */
  path: string;
  /** SHA-256 of full file content */
  contentHash: string;
  /** File size in bytes */
  size: number;
  /** File mtime as Unix epoch ms */
  mtime: number;
  /** Monotonically increasing version number per file */
  version: number;
  /** When this version was recorded */
  recordedAt: number;
  /** Which device recorded this version */
  deviceId: string;
}

// ─── Conflict Types ────────────────────────────────────────────────

export type ConflictStrategy =
  | "newer-wins"
  | "merge-frontmatter"
  | "manual";

export interface Conflict {
  conflictId: string;
  path: string;
  localVersion: FileVersion;
  remoteVersion: FileVersion;
  strategy: ConflictStrategy;
  resolution?: ConflictResolution;
  detectedAt: number;
}

export interface ConflictResolution {
  winner: "local" | "remote";
  loserPath: string;
  resolvedAt: number;
  resolvedBy: "auto" | "manual";
}

// ─── Event Bus ─────────────────────────────────────────────────────

export type VaultEventType =
  | "file:created"
  | "file:modified"
  | "file:deleted"
  | "file:renamed"
  | "job:created"
  | "job:claimed"
  | "job:status-changed"
  | "task:created"
  | "task:claimed"
  | "task:completed"
  | "task:cancelled"
  | "task:status-changed"
  | "note:created"
  | "note:modified"
  | "note:deleted"
  | "system:modified"
  | "approval:created"
  | "approval:resolved"
  | "conflict:detected"
  | "conflict:resolved"
  | "scan:started"
  | "scan:completed";

export interface VaultEvent<T = unknown> {
  type: VaultEventType;
  /** Relative path from vault root */
  path: string;
  /** The underlying file change, if applicable */
  change?: FileChange;
  /** Additional event-specific data */
  data?: T;
  /** Event timestamp */
  timestamp: number;
}

export type VaultEventHandler<T = unknown> = (
  event: VaultEvent<T>,
) => void | Promise<void>;

// ─── Subscription Filters ──────────────────────────────────────────

export interface WatchFilter {
  /** Only events of these types */
  eventTypes?: VaultEventType[];
  /** Only files in these vault subdirectories (prefix match) */
  directories?: string[];
}

// ─── Sync Engine Config ────────────────────────────────────────────

export interface VaultSyncConfig {
  /** Absolute path to .vault/ directory */
  vaultPath: string;
  /** Unique device identifier (auto-generated if not provided) */
  deviceId?: string;
  /** Path to sync state database (default: {vaultPath}/_embeddings/sync.db) */
  dbPath?: string;
  /** Debounce window for file watcher events in ms (default: 300) */
  debounceMs?: number;
  /** Stability threshold: wait after last write before processing in ms (default: 1000) */
  stabilityMs?: number;
  /** Full scan interval in ms (default: 3600000 = 1 hour) */
  fullScanIntervalMs?: number;
  /** Additional patterns to ignore */
  ignorePatterns?: string[];
  /** Conflict resolution strategy (default: "merge-frontmatter") */
  conflictStrategy?: ConflictStrategy;
  /** Enable debug logging */
  debug?: boolean;
}

// ─── Lock Types ────────────────────────────────────────────────────

export interface FileLock {
  path: string;
  holder: string;
  acquiredAt: number;
  expiresAt: number;
}
