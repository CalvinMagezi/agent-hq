/**
 * Test helpers — create/cleanup temporary vault directories for testing.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { VaultClient } from "../index";

/**
 * Create a temporary vault directory with the full expected structure.
 * Returns the vault path and a configured VaultClient.
 */
export function createTempVault(): { vaultPath: string; client: VaultClient } {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));

  // Create directory structure
  const dirs = [
    "_system",
    "_jobs/pending",
    "_jobs/running",
    "_jobs/done",
    "_jobs/failed",
    "_delegation/pending",
    "_delegation/claimed",
    "_delegation/completed",
    "_delegation/relay-health",
    "_threads/active",
    "_threads/archived",
    "_approvals/pending",
    "_approvals/resolved",
    "_logs",
    "_usage/daily",
    "_embeddings",
    "_agent-sessions",
    "_moc",
    "Notebooks/Memories",
    "Notebooks/Projects",
    "Notebooks/Daily Digest",
    "Notebooks/AI Intelligence",
    "Notebooks/Insights",
    "Notebooks/Discord Memory",
  ];

  for (const dir of dirs) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
  }

  // Create minimal system files
  fs.writeFileSync(
    path.join(vaultPath, "_system/SOUL.md"),
    "---\npinned: false\n---\n# Soul\n\nYou are a helpful AI assistant.",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(vaultPath, "_system/MEMORY.md"),
    "---\npinned: false\n---\n# Memory\n\n## Key Facts\n\n## Active Goals\n\n## Recent Work Summary\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(vaultPath, "_system/PREFERENCES.md"),
    "---\npinned: false\n---\n# Preferences\n\nNo preferences yet.",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(vaultPath, "_system/HEARTBEAT.md"),
    "---\npinned: false\n---\n# Heartbeat\n\nNo pending actions.",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(vaultPath, "_system/CONFIG.md"),
    "---\npinned: false\n---\n# Configuration\n\n| Key | Value |\n|-----|-------|\n| DEFAULT_MODEL | test-model |\n",
    "utf-8",
  );

  const client = new VaultClient(vaultPath);
  return { vaultPath, client };
}

/**
 * Clean up a temporary vault directory.
 */
export function cleanupTempVault(vaultPath: string): void {
  fs.rmSync(vaultPath, { recursive: true, force: true });
}
