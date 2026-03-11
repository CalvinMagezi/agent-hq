/**
 * Tag Suggester — Touch Point
 *
 * Suggests 2-4 relevant tags for notes via Ollama (1 LLM call).
 * Triggered by synaptic chain from frontmatter-fixer + direct note:created.
 *
 * Guards:
 *   - Skip if note already has ≥ 2 tags
 *   - Skip if content < 50 characters
 *   - Uses existing tag vocabulary from SearchClient for consistency
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { TouchPoint } from "../types.js";

const DEBOUNCE_MS = 30_000; // 30 seconds
const MIN_CONTENT_LENGTH = 50;
const SKIP_IF_TAGS_GTE = 2;

const SYSTEM_PROMPT = `You are a tag suggestion assistant for a personal knowledge vault.
Given a note's content, suggest 2-4 relevant tags from the existing vocabulary provided.
If the existing vocabulary doesn't have suitable tags, you may propose new ones in kebab-case.
Return ONLY a JSON array of strings, e.g. ["ai", "projects", "notes"].
No explanation, no Markdown, just the JSON array.`;

export const tagSuggester: TouchPoint = {
  name: "tag-suggester",
  description: "Suggest 2-4 tags via Ollama for notes missing tags",
  triggers: ["note:created"],
  pathFilter: "Notebooks/",
  debounceMs: DEBOUNCE_MS,

  async evaluate(event, ctx, incomingData) {
    const fullPath = path.join(ctx.vaultPath, event.path);

    if (!fs.existsSync(fullPath) || !event.path.endsWith(".md")) return null;

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

    const existingTags: string[] = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];

    // Skip if already has enough tags
    if (existingTags.length >= SKIP_IF_TAGS_GTE) return null;

    // Skip if content is too short
    const content = parsed.content.trim();
    if (content.length < MIN_CONTENT_LENGTH) return null;

    // Fetch existing tag vocabulary from search
    let vocabulary: string[] = [];
    try {
      const tagMap = ctx.search.getAllTags();
      vocabulary = Array.from(tagMap.keys()).slice(0, 100);
    } catch { /* vocabulary stays empty — model will improvise */ }

    // Call Ollama
    const prompt = [
      `Existing tag vocabulary: ${vocabulary.length > 0 ? vocabulary.join(", ") : "(none yet — create new tags)"}`,
      "",
      `Note title: ${path.basename(event.path, ".md")}`,
      `Note content (first 1000 chars):`,
      content.slice(0, 1000),
    ].join("\n");

    let suggestedTags: string[] = [];
    try {
      const response = await ctx.llm(prompt, SYSTEM_PROMPT);
      // Try to extract JSON array from response
      const match = response.match(/\[[\s\S]*?\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          suggestedTags = parsed
            .filter((t): t is string => typeof t === "string")
            .map(t => t.toLowerCase().replace(/\s+/g, "-"))
            .slice(0, 4);
        }
      }
    } catch {
      return null;
    }

    if (suggestedTags.length === 0) return null;

    if (ctx.dryRun) {
      return {
        observation: `Would add tags: ${suggestedTags.join(", ")}`,
        actions: [],
        meaningful: false,
      };
    }

    // Write tags back to frontmatter
    const backupDir = path.join(ctx.vaultPath, "_system", ".touchpoint-backups");
    try {
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `${path.basename(fullPath)}.${Date.now()}.bak`);
      fs.writeFileSync(backupPath, raw, "utf-8");
    } catch { /* non-fatal */ }

    try {
      const newData = { ...parsed.data, tags: [...existingTags, ...suggestedTags] };
      fs.writeFileSync(fullPath, matter.stringify(parsed.content, newData), "utf-8");
    } catch {
      return null;
    }

    return {
      observation: `Suggested tags: ${suggestedTags.join(", ")}`,
      actions: [`TAGGED: [${suggestedTags.join(", ")}]`],
      meaningful: false,
    };
  },
};
