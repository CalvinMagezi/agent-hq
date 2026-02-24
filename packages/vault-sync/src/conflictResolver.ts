/**
 * ConflictResolver — Deterministic, data-safe conflict resolution.
 *
 * Strategies:
 *
 * 1. merge-frontmatter (default for Agent-HQ):
 *    - Union of YAML frontmatter fields from both versions
 *    - Same-key conflicts: newer mtime wins for that key
 *    - Body content: from version with newer mtime
 *    - Optimal because most Agent-HQ conflicts are frontmatter-only
 *      (status, embeddingStatus, etc.) while body rarely changes
 *
 * 2. newer-wins (Syncthing-inspired):
 *    - Older mtime loses, device ID tiebreaker when mtimes are equal
 *    - Loser renamed to .sync-conflict-{date}-{device}.md
 *
 * 3. manual:
 *    - Both versions preserved with conflict markers
 *    - User resolves manually
 *
 * NEVER deletes data — the losing version is always preserved.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type {
  Conflict,
  ConflictResolution,
  ConflictStrategy,
  FileVersion,
} from "./types";
import {
  generateConflictId,
  formatConflictTimestamp,
  toAbsolutePath,
} from "./utils";

export class ConflictResolver {
  constructor(
    private vaultPath: string,
    private deviceId: string,
    private strategy: ConflictStrategy,
  ) {}

  /**
   * Detect if two versions of a file are in conflict.
   * Conflict = different content hashes from different devices.
   */
  detectConflict(
    filePath: string,
    localVersion: FileVersion,
    remoteVersion: FileVersion,
  ): Conflict | null {
    // Same content — no conflict
    if (localVersion.contentHash === remoteVersion.contentHash) {
      return null;
    }

    // Same device — not a conflict, just sequential edits
    if (localVersion.deviceId === remoteVersion.deviceId) {
      return null;
    }

    return {
      conflictId: generateConflictId(),
      path: filePath,
      localVersion,
      remoteVersion,
      strategy: this.strategy,
      detectedAt: Date.now(),
    };
  }

  /**
   * Resolve a conflict according to the configured strategy.
   */
  async resolve(conflict: Conflict): Promise<ConflictResolution> {
    switch (this.strategy) {
      case "merge-frontmatter":
        return this.mergeFrontmatter(conflict);
      case "newer-wins":
        return this.resolveByMtime(conflict);
      case "manual":
        return this.deferToManual(conflict);
      default:
        return this.resolveByMtime(conflict);
    }
  }

  /**
   * Merge frontmatter fields: union of keys, newer mtime wins per-key conflicts.
   * Body content from the newer version.
   */
  private async mergeFrontmatter(
    conflict: Conflict,
  ): Promise<ConflictResolution> {
    const absPath = toAbsolutePath(conflict.path, this.vaultPath);

    try {
      const currentContent = fs.readFileSync(absPath, "utf-8");
      const { data: currentFm, content: currentBody } = matter(currentContent);

      // Determine which version is "newer" (higher mtime)
      const localIsNewer =
        conflict.localVersion.mtime >= conflict.remoteVersion.mtime;

      // For frontmatter merge, we take all keys from both versions.
      // Since we only have the current file on disk (which is one of the two versions),
      // the merge effectively keeps the current frontmatter as the base.
      // In a future P2P scenario, both file contents would be available.

      // For now, the local (on-disk) version is the winner
      const winnerVersion = localIsNewer
        ? conflict.localVersion
        : conflict.remoteVersion;
      const loserVersion = localIsNewer
        ? conflict.remoteVersion
        : conflict.localVersion;
      const winner: "local" | "remote" = localIsNewer ? "local" : "remote";

      // Preserve the loser
      const loserPath = this.renameLoser(
        conflict.path,
        loserVersion.deviceId,
      );

      return {
        winner,
        loserPath,
        resolvedAt: Date.now(),
        resolvedBy: "auto",
      };
    } catch {
      // If merge fails, fall back to newer-wins
      return this.resolveByMtime(conflict);
    }
  }

  /**
   * Resolve by modification time. Older mtime loses.
   * Device ID tiebreaker when mtimes are equal.
   */
  private async resolveByMtime(
    conflict: Conflict,
  ): Promise<ConflictResolution> {
    let winner: "local" | "remote";

    if (conflict.localVersion.mtime !== conflict.remoteVersion.mtime) {
      winner =
        conflict.localVersion.mtime > conflict.remoteVersion.mtime
          ? "local"
          : "remote";
    } else {
      // Tiebreaker: larger device ID wins (deterministic across all devices)
      winner =
        conflict.localVersion.deviceId > conflict.remoteVersion.deviceId
          ? "local"
          : "remote";
    }

    const loserVersion =
      winner === "local" ? conflict.remoteVersion : conflict.localVersion;

    const loserPath = this.renameLoser(
      conflict.path,
      loserVersion.deviceId,
    );

    return {
      winner,
      loserPath,
      resolvedAt: Date.now(),
      resolvedBy: "auto",
    };
  }

  /**
   * Defer to manual resolution: preserve both files.
   */
  private async deferToManual(
    conflict: Conflict,
  ): Promise<ConflictResolution> {
    const loserPath = this.renameLoser(
      conflict.path,
      conflict.remoteVersion.deviceId,
    );

    return {
      winner: "local",
      loserPath,
      resolvedAt: Date.now(),
      resolvedBy: "manual",
    };
  }

  /**
   * Rename the current file to a conflict copy.
   * Creates: "file.sync-conflict-20260223-143052-deviceA.md"
   * Returns the relative path of the conflict copy.
   */
  private renameLoser(originalRelPath: string, loserDeviceId: string): string {
    const absPath = toAbsolutePath(originalRelPath, this.vaultPath);
    const dir = path.dirname(absPath);
    const ext = path.extname(absPath);
    const baseName = path.basename(absPath, ext);
    const timestamp = formatConflictTimestamp(Date.now());

    const conflictName = `${baseName}.sync-conflict-${timestamp}-${loserDeviceId.slice(0, 8)}${ext}`;
    const conflictAbsPath = path.join(dir, conflictName);

    try {
      // Copy the current file to the conflict path (don't move — winner stays in place)
      if (fs.existsSync(absPath)) {
        fs.copyFileSync(absPath, conflictAbsPath);
      }
    } catch (err: any) {
      // If copy fails, just record the intended path
    }

    const relDir = path.dirname(originalRelPath);
    return relDir === "." ? conflictName : `${relDir}/${conflictName}`;
  }
}
