/**
 * Settings tab for the vault sync plugin.
 */

import { PluginSettingTab, Setting, type App } from "obsidian";
import type VaultSyncPlugin from "./main";

export class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSyncPlugin;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ─── Connection ─────────────────────────────────────────
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("WebSocket URL of the sync relay server (ws:// or wss://)")
      .addText((text) =>
        text
          .setPlaceholder("ws://127.0.0.1:18800")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Device Name")
      .setDesc("A human-readable name for this device")
      .addText((text) =>
        text
          .setPlaceholder("My MacBook")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value;
            await this.plugin.saveSettings();
          }),
      );

    // ─── Security ───────────────────────────────────────────
    containerEl.createEl("h3", { text: "Security" });

    new Setting(containerEl)
      .setName("Enable E2E Encryption")
      .setDesc(
        "Encrypt all sync data so the relay server never sees plaintext",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableE2E)
          .onChange(async (value) => {
            this.plugin.settings.enableE2E = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Encryption Passphrase")
      .setDesc(
        "Shared passphrase for E2E encryption. All devices must use the same passphrase.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter passphrase")
          .setValue(this.plugin.settings.encryptionPassphrase)
          .onChange(async (value) => {
            this.plugin.settings.encryptionPassphrase = value;
            await this.plugin.saveSettings();
          });
      });

    // ─── Sync Behavior ──────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync Behavior" });

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically start syncing when Obsidian opens")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Conflict Strategy")
      .setDesc("How to resolve conflicts when the same file is modified on two devices")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("newer-wins", "Newer wins")
          .addOption("merge-frontmatter", "Merge frontmatter")
          .addOption("manual", "Ask me")
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (value: string) => {
            this.plugin.settings.conflictStrategy = value as any;
            await this.plugin.saveSettings();
          }),
      );

    // ─── Advanced ───────────────────────────────────────────
    containerEl.createEl("h3", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Debug Logging")
      .setDesc("Log sync events to the developer console")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debug)
          .onChange(async (value) => {
            this.plugin.settings.debug = value;
            await this.plugin.saveSettings();
          }),
      );

    // Device ID (read-only)
    if (this.plugin.settings.deviceId) {
      new Setting(containerEl)
        .setName("Device ID")
        .setDesc("Unique identifier for this device (auto-generated)")
        .addText((text) => {
          text.setValue(this.plugin.settings.deviceId!);
          text.inputEl.readOnly = true;
          text.inputEl.style.fontFamily = "monospace";
          text.inputEl.style.fontSize = "12px";
        });
    }
  }
}
