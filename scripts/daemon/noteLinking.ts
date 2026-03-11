/**
 * Daemon Task: Note Linking (every 2 hr) + Topic MOC Generation (every 12 hr)
 *
 * Scans embedded notes, computes semantic similarity scores with tag bonuses,
 * writes bidirectional wikilinks, and auto-generates Maps of Content per tag.
 */

import * as fs from "fs";
import * as path from "path";
import type { DaemonContext } from "./context.js";

// ─── Note Linking ──────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.75;
const MAX_LINKS_PER_NOTE = 5;
const TAG_BONUS_PER_SHARED = 0.05;
const TAG_BONUS_CAP = 0.15;
const GRAPH_LINK_MARKER = "<!-- agent-hq-graph-links -->";

interface EmbeddedNote {
  absPath: string;
  relPath: string;
  title: string;
  tags: string[];
  contentHash: string;
}

interface NoteLink {
  relPath: string;
  title: string;
  score: number;
  type: string;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRelatedSection(links: NoteLink[]): string {
  const lines = [GRAPH_LINK_MARKER, "## Related Notes", ""];

  for (const link of links) {
    const scoreLabel = (link.score * 100).toFixed(0);
    const typeIndicator = link.type.includes("tags") ? " #" : "";
    lines.push(
      `- [[${link.title}]]${typeIndicator} _(${scoreLabel}% similar)_`,
    );
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

export async function processNoteLinking(ctx: DaemonContext): Promise<void> {
  const stats = ctx.search.getStats();
  if (stats.embeddingCount < 2) return;

  console.log(
    `[linking] Processing note links across ${stats.embeddingCount} embedded notes...`,
  );

  const notebooksDir = path.join(ctx.vaultPath, "Notebooks");
  if (!fs.existsSync(notebooksDir)) return;

  const matter = await import("gray-matter").then((m) => m.default);

  // Step 1: Scan all embedded notes
  const embeddedNotes: EmbeddedNote[] = [];

  const scanDir = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const { data } = matter(raw);
          if (data.embeddingStatus === "embedded") {
            const relPath = path.relative(ctx.vaultPath, fullPath);
            const contentForHash = raw.replace(
              new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
              "",
            );
            embeddedNotes.push({
              absPath: fullPath,
              relPath,
              title: path.basename(entry.name, ".md"),
              tags: data.tags ?? [],
              contentHash: Bun.hash(contentForHash).toString(36),
            });
          }
        } catch {
          // Skip
        }
      }
    }
  };

  scanDir(notebooksDir);

  // Step 2: Identify dirty notes (changed since last linked or never linked)
  const dirtyNotes = embeddedNotes.filter((note) => {
    const state = ctx.search.getLinkState(note.relPath);
    if (!state) return true;
    return state.contentHash !== note.contentHash;
  });

  if (dirtyNotes.length === 0) {
    console.log("[linking] No notes need relinking.");
    return;
  }

  console.log(
    `[linking] ${dirtyNotes.length} of ${embeddedNotes.length} note(s) need relinking...`,
  );

  // Build tag index for bonus scoring
  const tagIndex = new Map<string, string[]>();
  for (const note of embeddedNotes) {
    for (const tag of note.tags) {
      const existing = tagIndex.get(tag) ?? [];
      existing.push(note.relPath);
      tagIndex.set(tag, existing);
    }
  }

  // Step 3: Find similar notes and compute final scores
  const pendingUpdates = new Map<
    string,
    { links: NoteLink[]; tags: string[] }
  >();

  for (const note of dirtyNotes) {
    const similar = ctx.search.findSimilarNotes(
      note.relPath,
      MAX_LINKS_PER_NOTE * 2,
      SIMILARITY_THRESHOLD,
    );

    const scored: NoteLink[] = similar.map((hit) => {
      const targetNote = embeddedNotes.find((n) => n.relPath === hit.notePath);
      let tagBonus = 0;
      if (targetNote) {
        const sharedTags = note.tags.filter((t) =>
          targetNote.tags.includes(t),
        );
        tagBonus = Math.min(
          sharedTags.length * TAG_BONUS_PER_SHARED,
          TAG_BONUS_CAP,
        );
      }
      return {
        relPath: hit.notePath,
        title: hit.title,
        score: hit.relevance + tagBonus,
        type: tagBonus > 0 ? "semantic+tags" : "semantic",
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const topLinks = scored.slice(0, MAX_LINKS_PER_NOTE);

    if (topLinks.length > 0) {
      pendingUpdates.set(note.relPath, { links: topLinks, tags: note.tags });
    }
  }

  // Step 4: Enforce bidirectionality — for every A→B, also queue B→A
  const bidirectionalUpdates = new Map(pendingUpdates);

  for (const [sourcePath, { links }] of pendingUpdates) {
    for (const link of links) {
      let targetEntry = bidirectionalUpdates.get(link.relPath);
      if (!targetEntry) {
        const targetNote = embeddedNotes.find(
          (n) => n.relPath === link.relPath,
        );
        targetEntry = { links: [], tags: targetNote?.tags ?? [] };
        bidirectionalUpdates.set(link.relPath, targetEntry);
      }
      const alreadyLinked = targetEntry.links.some(
        (l) => l.relPath === sourcePath,
      );
      if (!alreadyLinked) {
        const sourceNote = embeddedNotes.find(
          (n) => n.relPath === sourcePath,
        );
        targetEntry.links.push({
          relPath: sourcePath,
          title: sourceNote?.title ?? path.basename(sourcePath, ".md"),
          score: link.score,
          type: link.type,
        });
      }
    }
  }

  // Step 5: Write wikilinks into note bodies and update frontmatter
  let updated = 0;
  for (const [notePath, { links }] of bidirectionalUpdates) {
    try {
      const absPath = path.join(ctx.vaultPath, notePath);
      if (!fs.existsSync(absPath)) continue;

      const raw = fs.readFileSync(absPath, "utf-8");
      const { data, content } = matter(raw);

      const relatedSection = buildRelatedSection(links);

      let newContent: string;
      if (content.includes(GRAPH_LINK_MARKER)) {
        newContent = content.replace(
          new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
          relatedSection,
        );
      } else {
        newContent = content.trimEnd() + "\n\n" + relatedSection;
      }

      data.relatedNotes = links.map((l) => `[[${l.title}]]`);
      data.updatedAt = new Date().toISOString();

      fs.writeFileSync(
        absPath,
        matter.stringify(newContent.trim(), data),
        "utf-8",
      );

      const contentForHash = fs
        .readFileSync(absPath, "utf-8")
        .replace(
          new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
          "",
        );
      ctx.search.setLinkState(notePath, Bun.hash(contentForHash).toString(36));

      ctx.search.removeGraphLinks(notePath);
      for (const link of links) {
        ctx.search.addGraphLink(notePath, link.relPath, link.score, link.type);
      }

      updated++;
    } catch (err) {
      console.error(`[linking] Error updating ${notePath}:`, err);
    }
  }

  if (updated > 0) {
    console.log(`[linking] Updated links for ${updated} note(s)`);
    await ctx.notifyIfMeaningful(
      "note-linking",
      `${updated} note(s) updated`,
      updated >= 5,
      (s) => `🔗 <b>Note Linking</b> complete — ${s} with new semantic connections in your vault.`
    );
  }
}

// ─── Topic MOC Generation ──────────────────────────────────────────

const MOC_LINK_MARKER = "<!-- agent-hq-moc-links -->";
const MIN_NOTES_FOR_MOC = 3;
const SKIP_TAGS = new Set([
  "auto-generated",
  "daily-digest",
  "weekly-analysis",
  "moc",
]);

export async function processTopicMOCs(ctx: DaemonContext): Promise<void> {
  const matter = await import("gray-matter").then((m) => m.default);
  const mocDir = path.join(ctx.vaultPath, "_moc");
  if (!fs.existsSync(mocDir)) {
    fs.mkdirSync(mocDir, { recursive: true });
  }

  const tagCounts = ctx.search.getAllTags();
  let created = 0;
  let updated = 0;

  for (const [tag, count] of tagCounts) {
    if (count < MIN_NOTES_FOR_MOC || SKIP_TAGS.has(tag)) continue;

    const notePaths = ctx.search.getTaggedNotePaths(tag);
    if (notePaths.length < MIN_NOTES_FOR_MOC) continue;

    const safeName = tag.replace(/[/\\:*?"<>|]/g, "-");
    const titleCase =
      tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ");
    const mocPath = path.join(mocDir, `Topic - ${safeName}.md`);

    const wikilinks = notePaths
      .map((p) => {
        const title = path.basename(p, ".md");
        return `- [[${title}]]`;
      })
      .join("\n");

    const managedSection = `${MOC_LINK_MARKER}\n### Linked Notes\n\n${wikilinks}\n`;

    if (!fs.existsSync(mocPath)) {
      const frontmatter = {
        tags: ["moc", tag],
        autoGenerated: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const content = [
        `# ${titleCase}`,
        "",
        "```dataview",
        `TABLE noteType, tags, updatedAt`,
        `FROM "Notebooks"`,
        `WHERE contains(tags, "${tag}")`,
        `SORT updatedAt DESC`,
        "```",
        "",
        managedSection,
      ].join("\n");

      fs.writeFileSync(
        mocPath,
        matter.stringify(content, frontmatter),
        "utf-8",
      );
      created++;
    } else {
      const raw = fs.readFileSync(mocPath, "utf-8");
      const { data, content } = matter(raw);

      let newContent: string;
      if (content.includes(MOC_LINK_MARKER)) {
        newContent = content.replace(
          new RegExp(`${escapeRegex(MOC_LINK_MARKER)}[\\s\\S]*$`),
          managedSection,
        );
      } else {
        newContent = content.trimEnd() + "\n\n" + managedSection;
      }

      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(
        mocPath,
        matter.stringify(newContent.trim(), data),
        "utf-8",
      );
      updated++;
    }
  }

  if (created + updated > 0) {
    console.log(`[moc] Created ${created}, updated ${updated} topic MOC(s)`);
    await ctx.notifyIfMeaningful(
      "topic-mocs",
      `${created} created, ${updated} updated`,
      true,
      (s) => `📚 <b>MOC pages</b> updated — ${s}\nOpen <i>_moc/</i> in Obsidian to browse.`
    );
  }
}
