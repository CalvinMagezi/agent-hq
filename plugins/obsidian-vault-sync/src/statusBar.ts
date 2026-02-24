/**
 * StatusBar — Shows sync state in Obsidian's status bar.
 */

import type { Plugin } from "obsidian";
import type { SyncEngine } from "./syncEngine";
import type { SyncStatus } from "./types";

const STATUS_ICONS: Record<SyncStatus, string> = {
  disconnected: "\u2716", // ✖
  connecting: "\u21BB",   // ↻
  syncing: "\u21C4",      // ⇄
  synced: "\u2714",       // ✔
  error: "\u26A0",        // ⚠
};

const STATUS_LABELS: Record<SyncStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting...",
  syncing: "Syncing...",
  synced: "Synced",
  error: "Sync Error",
};

export class StatusBarWidget {
  private el: HTMLElement;

  constructor(
    plugin: Plugin,
    private syncEngine: SyncEngine,
  ) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass("vault-sync-status");

    // Set initial state
    this.update("disconnected");

    // Listen for changes
    syncEngine.onStatusChange((status) => this.update(status));
  }

  private update(status: SyncStatus): void {
    const icon = STATUS_ICONS[status];
    const label = STATUS_LABELS[status];
    const conflicts = this.syncEngine.conflictCount;

    let text = `${icon} ${label}`;
    if (conflicts > 0) {
      text += ` (${conflicts} conflict${conflicts > 1 ? "s" : ""})`;
    }

    this.el.setText(text);
    this.el.className = `vault-sync-status vault-sync-status-${status}`;
  }
}
