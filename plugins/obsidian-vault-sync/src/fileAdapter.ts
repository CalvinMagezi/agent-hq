/**
 * FileAdapter — Read/write files via Obsidian's Vault API.
 *
 * Abstracts file operations for both desktop and mobile platforms.
 * Uses `this.app.vault.adapter` for raw file I/O.
 */

import type { App, TFile } from "obsidian";
import { hashContent } from "@repo/vault-sync-protocol";

export class FileAdapter {
  constructor(private app: App) {}

  /**
   * Read a file's content as a string.
   */
  async readFile(path: string): Promise<string | null> {
    try {
      return await this.app.vault.adapter.read(path);
    } catch {
      return null;
    }
  }

  /**
   * Write content to a file, creating parent directories if needed.
   * Returns the SHA-256 hash of the written content.
   */
  async writeFile(path: string, content: string): Promise<string> {
    // Ensure parent directory exists
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      const exists = await this.app.vault.adapter.exists(dir);
      if (!exists) {
        await this.app.vault.adapter.mkdir(dir);
      }
    }

    await this.app.vault.adapter.write(path, content);
    return hashContent(content);
  }

  /**
   * Delete a file.
   */
  async deleteFile(path: string): Promise<void> {
    const exists = await this.app.vault.adapter.exists(path);
    if (exists) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) {
        await this.app.vault.delete(file);
      }
    }
  }

  /**
   * Rename a file.
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (file) {
      await this.app.vault.rename(file, newPath);
    }
  }

  /**
   * Check if a file exists.
   */
  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  /**
   * Get a file's hash, or null if it doesn't exist.
   */
  async getFileHash(path: string): Promise<string | null> {
    const content = await this.readFile(path);
    if (content === null) return null;
    return hashContent(content);
  }

  /**
   * Get file metadata (stat).
   */
  async getFileStat(
    path: string,
  ): Promise<{ mtime: number; size: number } | null> {
    try {
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat) return null;
      return { mtime: stat.mtime, size: stat.size };
    } catch {
      return null;
    }
  }
}
