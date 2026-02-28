import { AttachmentBuilder } from "discord.js";
import { readFileSync, existsSync } from "fs";
import { basename } from "path";

export interface FileRef {
  path: string;
  name: string;
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
 * Silently skips files that don't exist.
 */
export function buildAttachments(files: FileRef[]): AttachmentBuilder[] {
  return files
    .filter((f) => existsSync(f.path))
    .map((f) => new AttachmentBuilder(readFileSync(f.path), { name: f.name }));
}
