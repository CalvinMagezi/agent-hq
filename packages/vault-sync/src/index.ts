/**
 * VaultSync — The main sync engine orchestrator.
 *
 * Wires together:
 * - FileWatcher (immediate fs event detection)
 * - FullScanner (periodic safety-net scans)
 * - ChangeLog (append-only change journal)
 * - SyncState (file version tracking)
 * - EventBus (typed pub/sub with domain event classification)
 * - LockManager (advisory file locks)
 * - ConflictResolver (deterministic conflict resolution)
 *
 * Lifecycle:
 *   const sync = new VaultSync(config);
 *   await sync.start();
 *   sync.on("job:created", handler);
 *   // ... later
 *   await sync.stop();
 */

import * as path from "path";
import { Database } from "bun:sqlite";
import { FileWatcher } from "./watcher";
import { FullScanner } from "./scanner";
import { ChangeLog } from "./changeLog";
import { SyncState } from "./syncState";
import { EventBus } from "./eventBus";
import { LockManager } from "./lockManager";
import { ConflictResolver } from "./conflictResolver";
import { openSyncDatabase } from "./db";
import { generateDeviceId } from "./utils";
import type {
  VaultSyncConfig,
  VaultEvent,
  VaultEventType,
  VaultEventHandler,
  WatchFilter,
  FileChange,
  FileVersion,
  Conflict,
} from "./types";

export class VaultSync {
  readonly eventBus: EventBus;
  readonly changeLog: ChangeLog;
  readonly syncState: SyncState;
  readonly lockManager: LockManager;
  readonly conflictResolver: ConflictResolver;
  readonly deviceId: string;

  private watcher: FileWatcher;
  private scanner: FullScanner;
  private db: Database;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private lockCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private config: VaultSyncConfig) {
    this.deviceId = config.deviceId ?? generateDeviceId(config.vaultPath);

    // Open sync database
    this.db = openSyncDatabase(config.vaultPath, config.dbPath);

    // Initialize components
    this.changeLog = new ChangeLog(this.db);
    this.syncState = new SyncState(this.db, this.deviceId);
    this.eventBus = new EventBus(config.debug);
    this.lockManager = new LockManager(this.db, this.deviceId);
    this.conflictResolver = new ConflictResolver(
      config.vaultPath,
      this.deviceId,
      config.conflictStrategy ?? "merge-frontmatter",
    );
    this.scanner = new FullScanner(
      config.vaultPath,
      this.syncState,
      this.deviceId,
      config,
    );

    // Wire up watcher to process pipeline
    this.watcher = new FileWatcher(
      { ...config, deviceId: this.deviceId },
      (changes) => this.processChanges(changes),
    );
  }

  /** Start the sync engine: initial scan → watcher → periodic scans. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const debug = this.config.debug;

    // 1. Run initial full scan to catch offline changes
    if (debug) console.log("[vault-sync] Running initial scan...");
    await this.eventBus.emit({
      type: "scan:started",
      path: "/",
      timestamp: Date.now(),
    });

    const offlineChanges = await this.scanner.scan();
    if (offlineChanges.length > 0) {
      await this.processChanges(offlineChanges);
    }

    await this.eventBus.emit({
      type: "scan:completed",
      path: "/",
      timestamp: Date.now(),
      data: { changesDetected: offlineChanges.length },
    });
    if (debug) {
      console.log(
        `[vault-sync] Initial scan complete: ${offlineChanges.length} changes, ${this.syncState.count()} files tracked`,
      );
    }

    // 2. Start file watcher
    this.watcher.start();
    if (debug) console.log("[vault-sync] File watcher started");

    // 3. Start periodic full scan as safety net
    const scanInterval = this.config.fullScanIntervalMs ?? 3_600_000;
    this.scanInterval = setInterval(async () => {
      try {
        await this.eventBus.emit({
          type: "scan:started",
          path: "/",
          timestamp: Date.now(),
        });

        const changes = await this.scanner.scan();
        if (changes.length > 0) {
          await this.processChanges(changes);
        }

        await this.eventBus.emit({
          type: "scan:completed",
          path: "/",
          timestamp: Date.now(),
          data: { changesDetected: changes.length },
        });
      } catch (err: any) {
        if (debug) {
          console.error("[vault-sync] Scan error:", err.message);
        }
      }
    }, scanInterval);

    // 4. Start lock cleanup every 60 seconds
    this.lockCleanupInterval = setInterval(() => {
      this.lockManager.cleanupExpired();
    }, 60_000);
  }

  /** Stop the sync engine. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    this.watcher.stop();
    if (this.scanInterval) clearInterval(this.scanInterval);
    if (this.lockCleanupInterval) clearInterval(this.lockCleanupInterval);
    this.scanInterval = null;
    this.lockCleanupInterval = null;
    this.eventBus.clear();
    this.db.close();
  }

  /** Whether the sync engine is running. */
  get isRunning(): boolean {
    return this.started;
  }

  /** Subscribe to vault events by type. */
  on(
    eventType: VaultEventType | "*",
    handler: VaultEventHandler,
  ): () => void {
    return this.eventBus.on(eventType, handler);
  }

  /** Subscribe with a filter. */
  subscribe(filter: WatchFilter, handler: VaultEventHandler): () => void {
    return this.eventBus.subscribe(filter, handler);
  }

  /** Trigger a manual full scan. */
  async triggerScan(): Promise<number> {
    const changes = await this.scanner.scan();
    if (changes.length > 0) {
      await this.processChanges(changes);
    }
    return changes.length;
  }

  /** Process detected changes through the full pipeline. */
  private async processChanges(changes: FileChange[]): Promise<void> {
    for (const change of changes) {
      // 1. Persist to change log (guaranteed delivery)
      const changeId = this.changeLog.append(change);
      change.changeId = changeId;

      // 2. Update sync state
      if (change.type === "delete") {
        this.syncState.removeFile(change.path);
      } else if (change.type === "rename" && change.oldPath) {
        this.syncState.handleRename(change.oldPath, change.path);
        if (
          change.contentHash &&
          change.size != null &&
          change.mtime != null
        ) {
          this.syncState.recordVersion(
            change.path,
            change.contentHash,
            change.size,
            change.mtime,
          );
        }
      } else if (
        change.contentHash &&
        change.size != null &&
        change.mtime != null
      ) {
        this.syncState.recordVersion(
          change.path,
          change.contentHash,
          change.size,
          change.mtime,
        );
      }

      // 3. Classify into domain event and emit
      const event = this.eventBus.classifyChange(change);
      await this.eventBus.emit(event);
    }
  }

  /**
   * Inject changes received from a remote device into the local pipeline.
   *
   * Used by the sync transport layer to apply remote changes locally.
   * Flow: remote change → conflict check → record in ChangeLog → update SyncState → emit events
   *
   * The caller is responsible for writing actual file content to disk
   * (either via Obsidian API or fs.writeFileSync) BEFORE calling this method.
   */
  async injectRemoteChanges(
    changes: FileChange[],
  ): Promise<{ applied: number; conflicts: Conflict[]; skipped: number }> {
    const results: {
      applied: number;
      conflicts: Conflict[];
      skipped: number;
    } = { applied: 0, conflicts: [], skipped: 0 };

    for (const change of changes) {
      // Skip changes from our own device (echo prevention)
      if (change.deviceId === this.deviceId) {
        results.skipped++;
        continue;
      }

      // Check for conflicts with local state
      const localState = this.syncState.getFileState(change.path);
      if (
        localState &&
        change.contentHash &&
        localState.contentHash !== change.contentHash &&
        change.type !== "delete"
      ) {
        const remoteVersion: FileVersion = {
          path: change.path,
          contentHash: change.contentHash,
          size: change.size ?? 0,
          mtime: change.mtime ?? Date.now(),
          version: localState.version + 1,
          recordedAt: change.detectedAt,
          deviceId: change.deviceId,
        };

        const conflict = this.conflictResolver.detectConflict(
          change.path,
          localState,
          remoteVersion,
        );

        if (conflict) {
          const resolution = await this.conflictResolver.resolve(conflict);
          conflict.resolution = resolution;
          results.conflicts.push(conflict);

          await this.eventBus.emit({
            type: "conflict:detected",
            path: change.path,
            timestamp: Date.now(),
            data: conflict,
          });

          // If local wins, skip applying the remote change
          if (resolution.winner !== "remote") {
            results.skipped++;
            continue;
          }
        }
      }

      // Tag as remote source
      const remoteChange: FileChange = {
        ...change,
        source: "remote",
      };

      // Record in ChangeLog
      const changeId = this.changeLog.append(remoteChange);
      remoteChange.changeId = changeId;

      // Update SyncState
      if (remoteChange.type === "delete") {
        this.syncState.removeFile(remoteChange.path);
      } else if (remoteChange.type === "rename" && remoteChange.oldPath) {
        this.syncState.handleRename(remoteChange.oldPath, remoteChange.path);
        if (
          remoteChange.contentHash &&
          remoteChange.size != null &&
          remoteChange.mtime != null
        ) {
          this.syncState.recordVersion(
            remoteChange.path,
            remoteChange.contentHash,
            remoteChange.size,
            remoteChange.mtime,
          );
        }
      } else if (
        remoteChange.contentHash &&
        remoteChange.size != null &&
        remoteChange.mtime != null
      ) {
        this.syncState.recordVersion(
          remoteChange.path,
          remoteChange.contentHash,
          remoteChange.size,
          remoteChange.mtime,
        );
      }

      // Update peer cursor
      this.changeLog.updatePeerCursor(
        remoteChange.deviceId,
        "received",
        change.changeId,
      );

      // Emit domain event
      const event = this.eventBus.classifyChange(remoteChange);
      await this.eventBus.emit(event);

      results.applied++;
    }

    return results;
  }
}

// ─── SyncedVaultClient ──────────────────────────────────────────────

import { VaultClient } from "@repo/vault-client";
import type { JobStatus } from "@repo/vault-client";

/**
 * SyncedVaultClient — Drop-in replacement for VaultClient with sync.
 *
 * Extends VaultClient to:
 * 1. Provide event subscription API (.on, .subscribe)
 * 2. Use advisory locks for write operations
 * 3. Start/stop sync engine lifecycle
 *
 * 100% backward compatible — consumers upgrade by changing one import.
 */
export class SyncedVaultClient extends VaultClient {
  readonly sync: VaultSync;

  constructor(
    vaultPath: string,
    syncConfig?: Partial<VaultSyncConfig>,
  ) {
    super(vaultPath);
    this.sync = new VaultSync({
      vaultPath: this.vaultPath,
      ...syncConfig,
    });
  }

  /** Start the sync engine. */
  async startSync(): Promise<void> {
    await this.sync.start();
  }

  /** Stop the sync engine. */
  async stopSync(): Promise<void> {
    await this.sync.stop();
  }

  /** Subscribe to vault events. */
  on(
    eventType: VaultEventType | "*",
    handler: VaultEventHandler,
  ): () => void {
    return this.sync.on(eventType, handler);
  }

  /** Subscribe with a filter. */
  subscribe(filter: WatchFilter, handler: VaultEventHandler): () => void {
    return this.sync.subscribe(filter, handler);
  }

  /** Trigger a manual full scan. */
  async triggerScan(): Promise<number> {
    return this.sync.triggerScan();
  }

  // ─── Locked write overrides ──────────────────────────────────

  async updateJobStatus(
    jobId: string,
    status: JobStatus,
    data?: Record<string, any>,
  ): Promise<void> {
    const lockKey = `job:${jobId}`;
    return this.sync.lockManager.withLock(lockKey, () =>
      super.updateJobStatus(jobId, status, data),
    );
  }

  async updateNote(
    notePath: string,
    content?: string,
    frontmatterUpdates?: Record<string, any>,
  ): Promise<void> {
    const relPath = notePath.startsWith("/")
      ? path.relative(this.vaultPath, notePath)
      : notePath;
    return this.sync.lockManager.withLock(relPath, () =>
      super.updateNote(notePath, content, frontmatterUpdates),
    );
  }

  async updateTaskStatus(
    taskId: string,
    status: string,
    result?: string,
    error?: string,
  ): Promise<void> {
    const lockKey = `task:${taskId}`;
    return this.sync.lockManager.withLock(lockKey, () =>
      super.updateTaskStatus(taskId, status as any, result, error),
    );
  }

  async resolveApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    resolvedBy?: string,
    rejectionReason?: string,
  ): Promise<void> {
    const lockKey = `approval:${approvalId}`;
    return this.sync.lockManager.withLock(lockKey, () =>
      super.resolveApproval(approvalId, decision, resolvedBy, rejectionReason),
    );
  }
}

// ─── Re-exports ─────────────────────────────────────────────────────

export type {
  VaultSyncConfig,
  VaultEvent,
  VaultEventType,
  VaultEventHandler,
  WatchFilter,
  FileChange,
  FileVersion,
  Conflict,
  ConflictResolution,
  ConflictStrategy,
  FileLock,
  ChangeType,
} from "./types";

export { ChangeLog } from "./changeLog";
export { SyncState } from "./syncState";
export { EventBus } from "./eventBus";
export { FileWatcher } from "./watcher";
export { FullScanner } from "./scanner";
export { LockManager } from "./lockManager";
export { ConflictResolver } from "./conflictResolver";
export { openSyncDatabase } from "./db";
