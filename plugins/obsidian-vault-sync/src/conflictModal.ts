/**
 * ConflictModal — UI for viewing and resolving sync conflicts.
 */

import { Modal, type App, Setting } from "obsidian";
import type { ConflictInfo } from "./conflictHandler";

export class ConflictModal extends Modal {
  private conflicts: ConflictInfo[];
  private onResolve: (path: string, action: "keep-local" | "keep-remote" | "keep-both") => void;

  constructor(
    app: App,
    conflicts: ConflictInfo[],
    onResolve: (path: string, action: "keep-local" | "keep-remote" | "keep-both") => void,
  ) {
    super(app);
    this.conflicts = conflicts;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vault-sync-conflict-modal");

    contentEl.createEl("h2", { text: "Sync Conflicts" });

    if (this.conflicts.length === 0) {
      contentEl.createEl("p", { text: "No unresolved conflicts." });
      return;
    }

    contentEl.createEl("p", {
      text: `${this.conflicts.length} file${this.conflicts.length > 1 ? "s have" : " has"} conflicting changes from other devices.`,
    });

    for (const conflict of this.conflicts) {
      const container = contentEl.createDiv("vault-sync-conflict-item");
      container.createEl("h4", { text: conflict.path });
      container.createEl("p", {
        text: `Local: ${conflict.localHash.slice(0, 8)}... | Remote: ${conflict.remoteHash.slice(0, 8)}... (from ${conflict.remoteDeviceId.slice(0, 8)})`,
        cls: "vault-sync-conflict-hashes",
      });

      new Setting(container)
        .addButton((btn) =>
          btn
            .setButtonText("Keep Local")
            .onClick(() => {
              this.onResolve(conflict.path, "keep-local");
              container.remove();
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText("Keep Remote")
            .setCta()
            .onClick(() => {
              this.onResolve(conflict.path, "keep-remote");
              container.remove();
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText("Keep Both")
            .onClick(() => {
              this.onResolve(conflict.path, "keep-both");
              container.remove();
            }),
        );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
