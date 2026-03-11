/**
 * Folder Organizer — Touch Point
 *
 * Moves newly created notes to the correct folder based on frontmatter rules.
 * Uses rule-based matching first; calls Ollama only for ambiguous cases (1 call).
 *
 * Safety guards:
 *   - Only moves files created within the last 5 minutes
 *   - Only fires on note:created events
 *   - Backup before move
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { TouchPoint } from "../types.js";

const DEBOUNCE_MS = 30_000;
const MAX_FILE_AGE_MS = 5 * 60_000; // 5 minutes

/** Rule: if frontmatter field has this value, move to this folder */
interface FolderRule {
  field: string;
  value: string;
  targetFolder: string;
}

const FOLDER_RULES: FolderRule[] = [
  { field: "noteType", value: "daily-note", targetFolder: "Notebooks/Daily" },
  { field: "noteType", value: "project-note", targetFolder: "Notebooks/Projects" },
  { field: "noteType", value: "insight", targetFolder: "Notebooks/Insights" },
  { field: "noteType", value: "reference", targetFolder: "Notebooks/Reference" },
  { field: "noteType", value: "template", targetFolder: "Notebooks/Templates" },
  { field: "source", value: "digest", targetFolder: "Notebooks/Daily Digest" },
  { field: "source", value: "vault-worker", targetFolder: "Notebooks/Insights" },
];

const SYSTEM_PROMPT = `You are a filing assistant for a personal knowledge vault.
Given a note's content and existing folder structure, pick the single best folder path.
Return ONLY the folder path as a string, e.g. "Notebooks/Projects".
No explanation, no Markdown, just the path.`;

export const folderOrganizer: TouchPoint = {
  name: "folder-organizer",
  description: "Move misplaced notes to the correct Notebooks/ subfolder",
  triggers: ["note:created"],
  pathFilter: "Notebooks/",
  debounceMs: DEBOUNCE_MS,

  async evaluate(event, ctx) {
    const fullPath = path.join(ctx.vaultPath, event.path);

    if (!fs.existsSync(fullPath) || !event.path.endsWith(".md")) return null;

    // Only act on very recently created files (prevent acting on old file syncs)
    try {
      const stat = fs.statSync(fullPath);
      if (Date.now() - stat.birthtimeMs > MAX_FILE_AGE_MS &&
          Date.now() - stat.ctimeMs > MAX_FILE_AGE_MS) return null;
    } catch {
      return null;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, "utf-8");
    } catch {
      return null;
    }

    let parsed: ReturnType<typeof matter>;
    try {
      parsed = matter(raw);
    } catch {
      return null;
    }

    // Current folder (relative to vault)
    const currentDir = path.dirname(event.path);

    // Rule-based match
    let targetFolder: string | null = null;
    for (const rule of FOLDER_RULES) {
      if (parsed.data[rule.field] === rule.value) {
        targetFolder = rule.targetFolder;
        break;
      }
    }

    // If no rule matched and file is in the root Notebooks/ dir, try Ollama
    if (!targetFolder && currentDir === "Notebooks") {
      const content = parsed.content.trim().slice(0, 800);
      if (content.length > 50) {
        // List existing subfolders
        const nbPath = path.join(ctx.vaultPath, "Notebooks");
        let subfolders: string[] = [];
        try {
          subfolders = fs.readdirSync(nbPath, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => `Notebooks/${e.name}`);
        } catch { /* no subfolders */ }

        const prompt = [
          `Available folders:\n${subfolders.join("\n")}`,
          "",
          `Note filename: ${path.basename(event.path, ".md")}`,
          `Note content:\n${content}`,
        ].join("\n");

        try {
          const response = await ctx.llm(prompt, SYSTEM_PROMPT);
          const candidate = response.trim().replace(/["'`]/g, "");
          // Validate it's a subfolder of Notebooks/
          if (candidate.startsWith("Notebooks/") && subfolders.includes(candidate)) {
            targetFolder = candidate;
          }
        } catch { /* skip */ }
      }
    }

    // Nothing to do
    if (!targetFolder) return null;
    if (targetFolder === currentDir) return null;

    const newPath = path.join(targetFolder, path.basename(event.path));
    const newFullPath = path.join(ctx.vaultPath, newPath);

    if (ctx.dryRun) {
      return {
        observation: `Would move to ${targetFolder}`,
        actions: [],
        meaningful: false,
      };
    }

    // Backup before move
    const backupDir = path.join(ctx.vaultPath, "_system", ".touchpoint-backups");
    try {
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `${path.basename(fullPath)}.${Date.now()}.bak`);
      fs.writeFileSync(backupPath, raw, "utf-8");
    } catch { /* non-fatal */ }

    try {
      const targetDir = path.dirname(newFullPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(fullPath, newFullPath);
    } catch (err) {
      return null;
    }

    return {
      observation: `Moved to ${targetFolder}`,
      actions: [`MOVED: ${event.path} → ${newPath}`],
      meaningful: false,
    };
  },
};
