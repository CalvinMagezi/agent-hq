/**
 * Agent-HQ Vault Sync — Obsidian plugin for secure cross-device vault synchronization.
 *
 * Architecture:
 * - ChangeDetector: Hooks Obsidian vault events → SyncChangeEntry
 * - SyncTransport: WebSocket connection to relay server, E2E encryption
 * - SyncEngine: Orchestrates local changes, remote changes, conflicts
 * - FileAdapter: Reads/writes files via Obsidian API (desktop + mobile)
 *
 * Settings storage split:
 * - data.json (iCloud-synced): shared config — serverUrl, passphrase, autoSync, etc.
 * - localStorage: device-local state — deviceId, deviceToken, fileHashes, lastSyncChangeId
 *   These must NOT sync across devices or they corrupt each other's identity.
 */

import { Plugin, Notice, addIcon } from "obsidian";

import { SyncEngine } from "./syncEngine";
import { StatusBarWidget } from "./statusBar";
import { VaultSyncSettingTab } from "./settings";
import { ConflictModal } from "./conflictModal";
import { DeviceModal } from "./deviceModal";
import type { VaultSyncSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

// Sync icon for the ribbon
const SYNC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;

// ─── Device-local state (localStorage) ────────────────────
// These fields are per-device and must NOT be synced via iCloud.
const LOCAL_PREFIX = "agent-hq-vault-sync:";

function loadLocalState(): Partial<VaultSyncSettings> {
  try {
    const state: Partial<VaultSyncSettings> = {};

    const deviceId = localStorage.getItem(LOCAL_PREFIX + "deviceId");
    if (deviceId) state.deviceId = deviceId;

    const deviceToken = localStorage.getItem(LOCAL_PREFIX + "deviceToken");
    if (deviceToken) state.deviceToken = deviceToken;

    const lastSyncChangeId = localStorage.getItem(LOCAL_PREFIX + "lastSyncChangeId");
    if (lastSyncChangeId) state.lastSyncChangeId = parseInt(lastSyncChangeId, 10);

    const fileHashes = localStorage.getItem(LOCAL_PREFIX + "fileHashes");
    if (fileHashes) state.fileHashes = JSON.parse(fileHashes);

    return state;
  } catch {
    return {};
  }
}

function saveLocalState(settings: VaultSyncSettings): void {
  try {
    if (settings.deviceId) {
      localStorage.setItem(LOCAL_PREFIX + "deviceId", settings.deviceId);
    }
    if (settings.deviceToken) {
      localStorage.setItem(LOCAL_PREFIX + "deviceToken", settings.deviceToken);
    } else {
      localStorage.removeItem(LOCAL_PREFIX + "deviceToken");
    }
    if (settings.lastSyncChangeId !== undefined) {
      localStorage.setItem(LOCAL_PREFIX + "lastSyncChangeId", String(settings.lastSyncChangeId));
    }
    if (settings.fileHashes) {
      localStorage.setItem(LOCAL_PREFIX + "fileHashes", JSON.stringify(settings.fileHashes));
    }
  } catch {
    // localStorage may not be available in all contexts
  }
}

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;
  syncEngine!: SyncEngine;
  private statusBar!: StatusBarWidget;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Generate device ID on first load for THIS device — stored in localStorage, not data.json
    if (!this.settings.deviceId) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
      this.settings.deviceId = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      saveLocalState(this.settings);
    }

    // Initialize sync engine
    this.syncEngine = new SyncEngine(this.app, this.settings);

    // Settings tab
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    // Status bar
    this.statusBar = new StatusBarWidget(this, this.syncEngine);

    // Ribbon icon
    addIcon("vault-sync", SYNC_ICON);
    this.addRibbonIcon("vault-sync", "Vault Sync", () => {
      this.syncEngine.triggerSync();
    });

    // Commands
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncEngine.triggerSync(),
    });

    this.addCommand({
      id: "view-conflicts",
      name: "View sync conflicts",
      callback: () => {
        const conflicts = this.syncEngine.getConflicts();
        new ConflictModal(this.app, conflicts, (path, action) => {
          if (this.settings.debug) {
            console.log(`[vault-sync] Conflict resolved: ${path} → ${action}`);
          }
        }).open();
      },
    });

    this.addCommand({
      id: "manage-devices",
      name: "Manage paired devices",
      callback: () => {
        new DeviceModal(
          this.app,
          this.syncEngine.getConnectedDevices(),
        ).open();
      },
    });

    // Auto-start sync (with delay for Obsidian to finish loading)
    if (this.settings.autoSync && this.settings.serverUrl) {
      this.registerInterval(
        window.setTimeout(() => {
          this.syncEngine.start().catch((err) => {
            if (this.settings.debug) {
              console.error("[vault-sync] Auto-start failed:", err);
            }
          });
        }, 2000) as any,
      );
    }
  }

  async onunload(): Promise<void> {
    await this.syncEngine.stop();
    await this.saveSettings();
  }

  async loadSettings(): Promise<void> {
    // Load shared config from data.json (iCloud-synced)
    const shared = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Load device-local state from localStorage (NOT synced) and merge on top
    const local = loadLocalState();

    // Migrate: if data.json still has a deviceId (old format), move it to localStorage
    // then strip it from the shared config to avoid it syncing to other devices
    if (shared.deviceId && !local.deviceId) {
      local.deviceId = shared.deviceId;
    }
    if (shared.deviceToken && !local.deviceToken) {
      local.deviceToken = shared.deviceToken;
    }
    if (shared.fileHashes && !local.fileHashes) {
      local.fileHashes = shared.fileHashes;
    }
    if (shared.lastSyncChangeId !== undefined && local.lastSyncChangeId === undefined) {
      local.lastSyncChangeId = shared.lastSyncChangeId;
    }

    this.settings = { ...shared, ...local };
  }

  async saveSettings(): Promise<void> {
    // Save only shared config to data.json — strip device-local fields
    // so they don't get synced via iCloud to other devices
    const {
      deviceId: _deviceId,
      deviceToken: _deviceToken,
      lastSyncChangeId: _lastSyncChangeId,
      fileHashes: _fileHashes,
      ...sharedConfig
    } = this.settings;

    await this.saveData(sharedConfig);

    // Save device-local state to localStorage
    saveLocalState(this.settings);
  }
}
