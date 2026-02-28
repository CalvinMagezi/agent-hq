import { AttachmentBuilder } from "discord.js";
import { existsSync, statSync, readFileSync } from "fs";
import { basename, resolve, sep } from "path";
import { tmpdir, homedir } from "os";

export interface FileRef {
  path: string;
  name: string;
}

/** Discord file upload limit (25 MB for boosted servers, 8 MB default — use 25 MB) */
const MAX_FILE_SIZE = 25 * 1024 * 1024;

/**
 * Paths that AI-generated [FILE:] markers are allowed to read from.
 * Prevents prompt-injection attacks from exfiltrating credentials or system files.
 */
const ALLOWED_ROOTS: string[] = [
  process.env.VAULT_PATH,
  tmpdir(),
].filter((p): p is string => !!p).map(p => resolve(p));

function isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath);
  // Reject hidden files (dotfiles) outside of vault to avoid ~/.ssh, ~/.aws leaks
  if (basename(resolved).startsWith(".")) return false;
  return ALLOWED_ROOTS.some(root => resolved.startsWith(root + sep) || resolved === root);
}

/**
 * Parses [FILE: /absolute/path] or [FILE: /absolute/path | Display Name.ext]
 * markers from AI response text.
 *
 * Returns the text with all markers stripped, plus an array of file refs.
 */
export function extractFileAttachments(text: string): { cleanText: string; files: FileRef[] } {
  const files: FileRef[] = [];
  const cleanText = text.replace(/\[FILE:\s*([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\s*\]/g, (_match, rawPath, rawName) => {
    const filePath = rawPath.trim();
    const name = rawName ? rawName.trim() : basename(filePath);
    files.push({ path: filePath, name });
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();

  return { cleanText, files };
}

/**
 * Builds discord.js AttachmentBuilder objects from file refs.
 * Skips files that don't exist, are too large, or can't be read.
 */
export function buildAttachments(files: FileRef[]): AttachmentBuilder[] {
  const attachments: AttachmentBuilder[] = [];

  for (const f of files) {
    try {
      if (!isPathAllowed(f.path)) {
        console.warn(`[FileAttachment] Skipping — path not in allowed roots: ${f.path}`);
        continue;
      }
      if (!existsSync(f.path)) {
        console.warn(`[FileAttachment] Skipping — not found: ${f.path}`);
        continue;
      }
      const stat = statSync(f.path);
      if (!stat.isFile()) {
        console.warn(`[FileAttachment] Skipping — not a file: ${f.path}`);
        continue;
      }
      if (stat.size > MAX_FILE_SIZE) {
        console.warn(`[FileAttachment] Skipping — too large (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${f.path}`);
        continue;
      }
      if (stat.size === 0) {
        console.warn(`[FileAttachment] Skipping — empty file: ${f.path}`);
        continue;
      }
      const data = readFileSync(f.path);
      attachments.push(new AttachmentBuilder(data, { name: f.name }));
      console.log(`[FileAttachment] Loaded ${f.name} (${(stat.size / 1024).toFixed(1)} KB)`);
    } catch (err: any) {
      console.warn(`[FileAttachment] Skipping — read error: ${f.path}: ${err.message}`);
    }
  }

  return attachments;
}
