/**
 * DeviceModal — UI for managing paired devices.
 */

import { Modal, type App, Setting } from "obsidian";
import { generatePairingCode } from "@repo/vault-sync-protocol";

export class DeviceModal extends Modal {
  private connectedDevices: string[];
  private pairingCode: string | null = null;

  constructor(
    app: App,
    connectedDevices: string[],
  ) {
    super(app);
    this.connectedDevices = connectedDevices;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vault-sync-device-modal");

    contentEl.createEl("h2", { text: "Paired Devices" });

    // Connected devices
    if (this.connectedDevices.length === 0) {
      contentEl.createEl("p", {
        text: "No other devices currently connected.",
        cls: "vault-sync-no-devices",
      });
    } else {
      const list = contentEl.createEl("ul", { cls: "vault-sync-device-list" });
      for (const deviceId of this.connectedDevices) {
        const item = list.createEl("li");
        item.createSpan({
          text: `${deviceId.slice(0, 8)}...`,
          cls: "vault-sync-device-id",
        });
        item.createSpan({
          text: " (online)",
          cls: "vault-sync-device-status-online",
        });
      }
    }

    // Pairing section
    contentEl.createEl("h3", { text: "Pair New Device" });
    contentEl.createEl("p", {
      text: "Generate a pairing code and enter it on the new device.",
    });

    const pairingContainer = contentEl.createDiv("vault-sync-pairing");

    new Setting(pairingContainer)
      .setName("Pairing Code")
      .setDesc("Share this code with the device you want to pair")
      .addButton((btn) =>
        btn
          .setButtonText("Generate Code")
          .setCta()
          .onClick(() => {
            this.pairingCode = generatePairingCode();
            codeDisplay.setText(this.pairingCode);
            codeDisplay.addClass("vault-sync-pairing-code-visible");
          }),
      );

    const codeDisplay = pairingContainer.createDiv("vault-sync-pairing-code");
    codeDisplay.setText("------");
  }

  onClose(): void {
    this.contentEl.empty();
    this.pairingCode = null;
  }
}
