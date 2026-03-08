#!/usr/bin/env bun
/**
 * vault-icloud-bridge — One-way sync from .vault/ to iCloud Obsidian.
 *
 * Mirrors the local vault to the iCloud Drive Obsidian Documents folder so
 * Obsidian on iPhone stays up-to-date without needing the app open.
 *
 * iCloud Drive returns EDEADLK (resource deadlock) when overwriting existing
 * files via mmap — so we use delete + write for updates, and direct write for
 * new files. Triggered by fs.watch with a 3s debounce + 60s periodic safety net.
 */

import { watch, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { resolve, join, dirname, relative } from "path";

// ─── Config ───────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "..");
const VAULT_SRC = join(REPO_ROOT, ".vault");

const ICLOUD_BASE = join(
  process.env.HOME!,
  "Library/Mobile Documents/iCloud~md~obsidian/Documents",
);
const VAULT_NAME = process.env.ICLOUD_VAULT_NAME ?? "agent-hq";
const ICLOUD_DEST = join(ICLOUD_BASE, VAULT_NAME);

// Relative path prefixes/names never synced to iCloud
const EXCLUDE_PREFIXES = [
  ".obsidian",    // iCloud vault has its own plugin config
  "_embeddings",  // SQLite DBs — not useful on mobile
  ".git",
  "node_modules",
];
const EXCLUDE_SUFFIXES = [
  ".sync-conflict-",
];

const DEBOUNCE_MS = 3_000;
const FULL_SYNC_INTERVAL_MS = 60_000;

// ─── Helpers ──────────────────────────────────────────────────

function shouldExclude(relPath: string): boolean {
  const parts = relPath.split("/");
  if (EXCLUDE_PREFIXES.some((p) => parts[0] === p)) return true;
  if (EXCLUDE_SUFFIXES.some((s) => relPath.includes(s))) return true;
  if (parts[0] === ".DS_Store") return true;
  return false;
}

async function copyFile(srcPath: string, dstPath: string): Promise<void> {
  const content = await Bun.file(srcPath).arrayBuffer();
  // iCloud returns EDEADLK on overwrite-in-place — delete first, then write
  if (existsSync(dstPath)) {
    unlinkSync(dstPath);
  }
  await Bun.write(dstPath, content);
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

// ─── Full sync ────────────────────────────────────────────────

let syncing = false;

async function runFullSync(label: string): Promise<void> {
  if (syncing) return; // Don't overlap syncs
  syncing = true;
  let copied = 0;
  let errors = 0;

  try {
    await syncDir(VAULT_SRC, ICLOUD_DEST, "");
    console.log(
      `[icloud-bridge] Synced (${label}) — ${copied} files, ${errors} errors ${new Date().toLocaleTimeString()}`,
    );
  } catch (err) {
    console.error(`[icloud-bridge] Sync error (${label}):`, (err as Error).message);
  } finally {
    syncing = false;
  }

  async function syncDir(srcDir: string, dstDir: string, relBase: string): Promise<void> {
    ensureDir(dstDir);

    let entries: string[];
    try {
      entries = readdirSync(srcDir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (name === ".DS_Store") continue;

      const relPath = relBase ? `${relBase}/${name}` : name;
      if (shouldExclude(relPath)) continue;

      const srcPath = join(srcDir, name);
      const dstPath = join(dstDir, name);

      let stat;
      try {
        stat = statSync(srcPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await syncDir(srcPath, dstPath, relPath);
      } else {
        try {
          await copyFile(srcPath, dstPath);
          copied++;
        } catch (err) {
          errors++;
          // Log first few errors only
          if (errors <= 3) {
            console.error(`[icloud-bridge] Copy failed: ${relPath}:`, (err as Error).message);
          }
        }
      }
    }
  }
}

// ─── Debounced watcher ────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runFullSync("watch");
  }, DEBOUNCE_MS);
}

// ─── Main ─────────────────────────────────────────────────────

if (!existsSync(VAULT_SRC)) {
  console.error(`[icloud-bridge] Vault not found: ${VAULT_SRC}`);
  process.exit(1);
}

if (!existsSync(ICLOUD_BASE)) {
  console.error(`[icloud-bridge] iCloud Obsidian path not found: ${ICLOUD_BASE}`);
  console.error("[icloud-bridge] Is iCloud Drive enabled and Obsidian installed?");
  process.exit(1);
}

ensureDir(ICLOUD_DEST);

console.log(`[icloud-bridge] Watching ${VAULT_SRC}`);
console.log(`[icloud-bridge] Syncing to ${ICLOUD_DEST}`);

// Initial full sync on startup
await runFullSync("startup");

// Watch for changes
watch(VAULT_SRC, { recursive: true }, (event, filename) => {
  if (!filename) return;
  if (shouldExclude(filename)) return;
  scheduleSync();
});

// Periodic full sync safety net
setInterval(() => runFullSync("periodic"), FULL_SYNC_INTERVAL_MS);

console.log("[icloud-bridge] Running. Ctrl+C to stop.");
