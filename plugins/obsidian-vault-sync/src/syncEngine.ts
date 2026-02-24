/**
 * SyncEngine — Core orchestrator for the Obsidian vault sync plugin.
 *
 * Bridges the ChangeDetector (local Obsidian events), Transport (WebSocket),
 * FileAdapter (Obsidian vault I/O), and ConflictHandler.
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import type {
  SyncMessage,
  SyncChangeEntry,
  DeltaPushMessage,
  IndexResponseMessage,
  FileResponseMessage,
  DeviceListMessage,
  HelloAckMessage,
} from "@repo/vault-sync-protocol";
import { hashContent, IGNORE_PATTERNS } from "@repo/vault-sync-protocol";
import { ChangeDetector } from "./changeDetector";
import { SyncTransport } from "./transport";
import { FileAdapter } from "./fileAdapter";
import { ConflictHandler } from "./conflictHandler";
import type { VaultSyncSettings, SyncStatus } from "./types";

export type SyncStatusCallback = (status: SyncStatus) => void;

export class SyncEngine {
  private transport: SyncTransport;
  private changeDetector: ChangeDetector;
  private fileAdapter: FileAdapter;
  private conflictHandler: ConflictHandler;
  private offlineQueue: SyncChangeEntry[] = [];
  private fileHashes: Map<string, string>;
  private connectedDevices: string[] = [];
  private _status: SyncStatus = "disconnected";
  private statusCallbacks: SyncStatusCallback[] = [];
  private pendingFileRequests = new Map<
    string,
    { resolve: (content: string) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private app: App,
    private settings: VaultSyncSettings,
  ) {
    this.transport = new SyncTransport(settings);
    this.changeDetector = new ChangeDetector(
      app,
      settings.deviceId!,
    );
    this.fileAdapter = new FileAdapter(app);
    this.conflictHandler = new ConflictHandler(app, settings);
    this.fileHashes = new Map(
      Object.entries(settings.fileHashes ?? {}),
    );
  }

  /**
   * Start the sync engine.
   */
  async start(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.deviceId) {
      if (this.settings.debug) {
        console.log("[vault-sync] Cannot start: missing serverUrl or deviceId");
      }
      return;
    }

    // Set up transport handlers
    this.transport.onMessages((msg) => this.handleServerMessage(msg));
    this.transport.onStatusChange((status) => this.setStatus(status));

    // Start detecting local changes
    this.changeDetector.start((change) => this.handleLocalChange(change));

    // Connect to server
    await this.transport.connect();
  }

  /**
   * Stop the sync engine.
   */
  async stop(): Promise<void> {
    this.changeDetector.stop();
    this.transport.disconnect();
    this.setStatus("disconnected");

    // Persist file hashes
    this.settings.fileHashes = Object.fromEntries(this.fileHashes);
  }

  /**
   * Trigger a manual sync.
   */
  async triggerSync(): Promise<void> {
    if (!this.transport.isConnected) {
      new Notice("Not connected to sync server");
      return;
    }

    this.setStatus("syncing");

    // Drain offline queue
    for (const change of this.offlineQueue) {
      await this.transport.pushChange(change);
    }
    this.offlineQueue = [];

    // Request catchup from peers
    await this.transport.requestIndex(
      this.settings.lastSyncChangeId ?? 0,
    );

    new Notice("Sync triggered");
  }

  /**
   * Get current sync status.
   */
  get status(): SyncStatus {
    return this._status;
  }

  /**
   * Subscribe to status changes.
   */
  onStatusChange(callback: SyncStatusCallback): void {
    this.statusCallbacks.push(callback);
  }

  /**
   * Get connected device IDs.
   */
  getConnectedDevices(): string[] {
    return [...this.connectedDevices];
  }

  /**
   * Get conflict count.
   */
  get conflictCount(): number {
    return this.conflictHandler.conflictCount;
  }

  /**
   * Get list of conflicts.
   */
  getConflicts() {
    return this.conflictHandler.getConflicts();
  }

  // ─── Local Change Handling ────────────────────────────────

  private async handleLocalChange(change: SyncChangeEntry): Promise<void> {
    // Update local hash cache
    if (change.contentHash) {
      this.fileHashes.set(change.path, change.contentHash);
    } else if (change.changeType === "delete") {
      this.fileHashes.delete(change.path);
    }

    if (this.transport.isConnected) {
      await this.transport.pushChange(change);
    } else {
      // Queue for later
      this.offlineQueue.push(change);
      // Keep queue bounded
      if (this.offlineQueue.length > 1000) {
        this.offlineQueue.shift();
      }
    }
  }

  // ─── Server Message Handling ──────────────────────────────

  private async handleServerMessage(msg: SyncMessage): Promise<void> {
    switch (msg.type) {
      case "hello-ack":
        await this.handleHelloAck(msg as HelloAckMessage);
        break;
      case "delta-push":
        await this.handleDeltaPush(msg as DeltaPushMessage);
        break;
      case "index-response":
        await this.handleIndexResponse(msg as IndexResponseMessage);
        break;
      case "file-response":
        this.handleFileResponse(msg as FileResponseMessage);
        break;
      case "device-list":
        this.handleDeviceList(msg as DeviceListMessage);
        break;
      case "error":
        if (this.settings.debug) {
          console.error("[vault-sync] Server error:", msg);
        }
        break;
    }
  }

  private async handleHelloAck(msg: HelloAckMessage): Promise<void> {
    this.connectedDevices = msg.connectedDevices;

    // Save token for fast re-auth
    if (msg.assignedToken) {
      this.settings.deviceToken = msg.assignedToken;
    }

    // Drain offline queue
    if (this.offlineQueue.length > 0) {
      this.setStatus("syncing");
      for (const change of this.offlineQueue) {
        await this.transport.pushChange(change);
      }
      this.offlineQueue = [];
    }

    // Request catchup
    await this.transport.requestIndex(
      this.settings.lastSyncChangeId ?? 0,
    );

    this.setStatus("synced");
  }

  private async handleDeltaPush(msg: DeltaPushMessage): Promise<void> {
    const change = msg.change;

    // Skip our own changes (echo prevention)
    if (change.deviceId === this.settings.deviceId) return;

    // Skip ignored paths
    if (this.shouldIgnore(change.path)) return;

    await this.applyRemoteChange(change);
  }

  private async handleIndexResponse(msg: IndexResponseMessage): Promise<void> {
    if (msg.changes.length === 0) return;

    this.setStatus("syncing");

    for (const change of msg.changes) {
      // Skip own device
      if (change.deviceId === this.settings.deviceId) continue;
      if (this.shouldIgnore(change.path)) continue;

      await this.applyRemoteChange(change);
    }

    // Update cursor
    this.settings.lastSyncChangeId = msg.latestChangeId;

    // Request more if available
    if (msg.hasMore) {
      await this.transport.requestIndex(
        msg.latestChangeId,
      );
    } else {
      this.setStatus("synced");
    }
  }

  private handleFileResponse(msg: FileResponseMessage): void {
    const key = `${msg.path}:${msg.contentHash}`;
    const pending = this.pendingFileRequests.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(atob(msg.content));
      this.pendingFileRequests.delete(key);
    }
  }

  private handleDeviceList(msg: DeviceListMessage): void {
    this.connectedDevices = msg.devices
      .filter((d) => d.status === "online" && d.deviceId !== this.settings.deviceId)
      .map((d) => d.deviceId);
  }

  // ─── Remote Change Application ────────────────────────────

  private async applyRemoteChange(change: SyncChangeEntry): Promise<void> {
    try {
      switch (change.changeType) {
        case "create":
        case "modify":
          await this.applyCreateOrModify(change);
          break;
        case "delete":
          await this.applyDelete(change);
          break;
        case "rename":
          await this.applyRename(change);
          break;
      }
    } catch (err) {
      if (this.settings.debug) {
        console.error(`[vault-sync] Failed to apply change to ${change.path}:`, err);
      }
    }
  }

  private async applyCreateOrModify(change: SyncChangeEntry): Promise<void> {
    const localHash = this.fileHashes.get(change.path) ?? null;

    // Check for conflict
    const { isConflict, shouldApply } =
      await this.conflictHandler.checkAndResolve(change, localHash);

    if (!shouldApply) return;

    // Request file content from the originating device
    const content = await this.requestFileContent(
      change.path,
      change.contentHash!,
      change.deviceId,
    );

    if (content === null) {
      if (this.settings.debug) {
        console.warn(`[vault-sync] Could not get content for ${change.path}`);
      }
      return;
    }

    // Suppress local change detection while we write
    this.changeDetector.suppressPath(change.path);
    try {
      const hash = await this.fileAdapter.writeFile(change.path, content);
      this.fileHashes.set(change.path, hash);
    } finally {
      // Un-suppress after a short delay (let Obsidian process the write)
      setTimeout(() => {
        this.changeDetector.unsuppressPath(change.path);
      }, 500);
    }

    if (isConflict) {
      new Notice(`Sync conflict resolved for ${change.path}`);
    }
  }

  private async applyDelete(change: SyncChangeEntry): Promise<void> {
    const localHash = this.fileHashes.get(change.path) ?? null;

    // Only delete if local hasn't been modified
    // (If local was modified, the delete is effectively a conflict)
    if (localHash && change.contentHash && localHash !== change.contentHash) {
      if (this.settings.debug) {
        console.log(
          `[vault-sync] Skipping delete of ${change.path} — locally modified`,
        );
      }
      return;
    }

    this.changeDetector.suppressPath(change.path);
    try {
      await this.fileAdapter.deleteFile(change.path);
      this.fileHashes.delete(change.path);
    } finally {
      setTimeout(() => {
        this.changeDetector.unsuppressPath(change.path);
      }, 500);
    }
  }

  private async applyRename(change: SyncChangeEntry): Promise<void> {
    if (!change.oldPath) return;

    this.changeDetector.suppressPath(change.path);
    this.changeDetector.suppressPath(change.oldPath);
    try {
      await this.fileAdapter.renameFile(change.oldPath, change.path);
      const oldHash = this.fileHashes.get(change.oldPath);
      if (oldHash) {
        this.fileHashes.delete(change.oldPath);
        this.fileHashes.set(change.path, oldHash);
      }
    } finally {
      setTimeout(() => {
        this.changeDetector.unsuppressPath(change.path);
        this.changeDetector.unsuppressPath(change.oldPath!);
      }, 500);
    }
  }

  // ─── File Content Request ─────────────────────────────────

  private requestFileContent(
    path: string,
    contentHash: string,
    fromDeviceId: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const key = `${path}:${contentHash}`;

      // Timeout after 10 seconds
      const timer = setTimeout(() => {
        this.pendingFileRequests.delete(key);
        resolve(null);
      }, 10_000);

      this.pendingFileRequests.set(key, { resolve, timer });
      this.transport.requestFile(path, contentHash, fromDeviceId);
    });
  }

  // ─── Helpers ──────────────────────────────────────────────

  private shouldIgnore(path: string): boolean {
    for (const pattern of IGNORE_PATTERNS) {
      if (path.includes(pattern)) return true;
    }
    return !path.endsWith(".md");
  }

  private setStatus(status: SyncStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const cb of this.statusCallbacks) {
      cb(status);
    }
  }
}
