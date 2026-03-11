/**
 * Frontmatter Fixer — Touch Point
 *
 * Auto-adds missing frontmatter fields to newly created or modified notes.
 * Pure filesystem, no LLM. Runs in 10s after change.
 *
 * Fields added when missing:
 *   - noteType (guessed from path)
 *   - tags: []
 *   - createdAt (current ISO timestamp)
 *   - embeddingStatus: "pending"
 *
 * Emits to tag-suggester chain when tags were empty/missing.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { TouchPoint, TouchPointResult } from "../types.js";

const DEBOUNCE_MS = 10_000; // 10 seconds

function guessNoteType(filePath: string): string {
  if (filePath.includes("/Daily/")) return "daily-note";
  if (filePath.includes("/Projects/")) return "project-note";
  if (filePath.includes("/Insights/")) return "insight";
  if (filePath.includes("/Reference/")) return "reference";
  if (filePath.includes("/Templates/")) return "template";
  return "note";
}

export const frontmatterFixer: TouchPoint = {
  name: "frontmatter-fixer",
  description: "Auto-add missing frontmatter fields to new/modified notes in Notebooks/",
  triggers: ["note:created", "note:modified"],
  pathFilter: "Notebooks/",
  debounceMs: DEBOUNCE_MS,

  async evaluate(event, ctx) {
    const fullPath = path.join(ctx.vaultPath, event.path);

    // File must exist and be a markdown file
    if (!fs.existsSync(fullPath) || !event.path.endsWith(".md")) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, "utf-8");
    } catch {
      return null;
    }

    // Parse frontmatter using a lightweight inline parser (gray-matter is available
    // everywhere in the daemon via node_modules)
    let parsed: ReturnType<typeof matter>;
    try {
      parsed = matter(raw);
    } catch {
      return null;
    }

    const data = { ...parsed.data };
    const added: string[] = [];

    // Add missing fields
    if (!data.noteType) {
      data.noteType = guessNoteType(event.path);
      added.push("noteType");
    }
    if (!data.tags || !Array.isArray(data.tags)) {
      data.tags = [];
      added.push("tags");
    }
    if (!data.createdAt) {
      data.createdAt = new Date().toISOString();
      added.push("createdAt");
    }
    if (!data.embeddingStatus) {
      data.embeddingStatus = "pending";
      added.push("embeddingStatus");
    }

    // Nothing to do if no fields were missing
    if (added.length === 0) return null;

    // Dry-run: just observe
    if (ctx.dryRun) {
      return {
        observation: `Would add frontmatter fields: ${added.join(", ")}`,
        actions: [],
        meaningful: false,
      };
    }

    // Write-safety: backup before modifying
    // Note: we access engine's backup via vaultPath convention (engine exposes vaultPath)
    const backupDir = path.join(ctx.vaultPath, "_system", ".touchpoint-backups");
    let backupPath: string | null = null;
    try {
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const basename = path.basename(fullPath);
      backupPath = path.join(backupDir, `${basename}.${Date.now()}.bak`);
      fs.writeFileSync(backupPath, raw, "utf-8");
    } catch { /* non-fatal */ }

    // Write modified file
    try {
      const newContent = matter.stringify(parsed.content, data);
      fs.writeFileSync(fullPath, newContent, "utf-8");
    } catch (err) {
      // Restore backup on write failure
      if (backupPath && fs.existsSync(backupPath)) {
        try { fs.writeFileSync(fullPath, fs.readFileSync(backupPath, "utf-8"), "utf-8"); } catch { /* ignore */ }
      }
      return null;
    }

    const hadNoTags = (parsed.data.tags == null || !Array.isArray(parsed.data.tags) || (parsed.data.tags as string[]).length === 0);

    return {
      observation: `Added frontmatter fields: ${added.join(", ")}`,
      actions: [`FIXED: added ${added.join(", ")}`],
      meaningful: false,
      // Chain to tag-suggester if tags were empty
      emit: hadNoTags ? [{ touchPoint: "tag-suggester", data: { triggeredBy: "frontmatter-fixer" } }] : undefined,
    };
  },
};
