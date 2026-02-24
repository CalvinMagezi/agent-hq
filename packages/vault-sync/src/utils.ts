/**
 * Utility functions for vault-sync: hashing, path normalization, constants.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

/** Compute SHA-256 content hash of a file. */
export async function computeContentHash(filePath: string): Promise<string> {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Compute SHA-256 hash of a string. */
export function hashString(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Normalize a file path to use forward slashes and be relative to vault root. */
export function normalizeVaultPath(
  filePath: string,
  vaultRoot: string,
): string {
  const rel = path.relative(vaultRoot, filePath);
  return rel.split(path.sep).join("/");
}

/** Convert a relative vault path back to an absolute filesystem path. */
export function toAbsolutePath(
  relativePath: string,
  vaultRoot: string,
): string {
  return path.join(vaultRoot, ...relativePath.split("/"));
}

/** Generate a stable device ID from hostname + vault path. */
export function generateDeviceId(vaultPath: string): string {
  const hostname = os.hostname();
  return hashString(`${hostname}:${vaultPath}`).slice(0, 16);
}

/** Built-in ignore patterns for the file watcher. */
export const BUILTIN_IGNORE_PATTERNS = [
  ".obsidian/",
  ".obsidian\\",
  "_embeddings/",
  "_embeddings\\",
  ".git/",
  ".git\\",
  ".DS_Store",
  "node_modules/",
  "node_modules\\",
  ".sync-conflict-",
];

/** Check if a relative path should be ignored by the watcher. */
export function shouldIgnorePath(
  relativePath: string,
  extraPatterns?: string[],
): boolean {
  const normalized = relativePath.split(path.sep).join("/");

  for (const pattern of BUILTIN_IGNORE_PATTERNS) {
    if (normalized.includes(pattern.replace(/\\/g, "/"))) return true;
  }

  if (extraPatterns) {
    for (const pattern of extraPatterns) {
      if (normalized.includes(pattern)) return true;
    }
  }

  return false;
}

/** Check if a path is a markdown file. */
export function isMarkdownFile(filePath: string): boolean {
  return filePath.endsWith(".md");
}

/** Get file stats safely, returning null if file doesn't exist. */
export function safeStatSync(
  filePath: string,
): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/** Generate a unique conflict ID. */
export function generateConflictId(): string {
  return `conflict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Format a timestamp for use in conflict file names. */
export function formatConflictTimestamp(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
