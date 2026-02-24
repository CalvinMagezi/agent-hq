/**
 * Agent-HQ Vault Sync — Obsidian plugin for secure cross-device vault synchronization.
 *
 * Architecture:
 * - ChangeDetector: Hooks Obsidian vault events → SyncChangeEntry
 * - SyncTransport: WebSocket connection to relay server, E2E encryption
 * - SyncEngine: Orchestrates local changes, remote changes, conflicts
 * - FileAdapter: Reads/writes files via Obsidian API (desktop + mobile)
 */

import { Plugin, Notice, addIcon } from "obsidian";
import { generateDeviceId } from "@repo/vault-sync-protocol";
import { SyncEngine } from "./syncEngine";
import { StatusBarWidget } from "./statusBar";
import { VaultSyncSettingTab } from "./settings";
import { ConflictModal } from "./conflictModal";
import { DeviceModal } from "./deviceModal";
import type { VaultSyncSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

// Sync icon for the ribbon
const SYNC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;
  syncEngine!: SyncEngine;
  private statusBar!: StatusBarWidget;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Generate device ID on first load
    if (!this.settings.deviceId) {
      // Use a platform-independent device identifier
      const hostname =
        typeof require !== "undefined"
          ? require("os").hostname?.() ?? "obsidian-device"
          : "obsidian-mobile";
      const vaultName = this.app.vault.getName();
      this.settings.deviceId = await generateDeviceId(hostname, vaultName);
      await this.saveSettings();
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
