#!/usr/bin/env bun
/**
 * Web Digest Workflow — Daily curated RSS digest.
 *
 * Fetches from a curated set of free RSS/Atom feeds defined in
 * _system/DIGEST-FEEDS.md (falls back to DEFAULT_FEEDS if file is absent).
 * No external search API required — feeds are always free and legal.
 *
 * Synthesizes with OpenRouter, writes digest to Notebooks/Daily Digest/.
 *
 * Schedule: Daily 7:00 AM UTC (via launchd)
 */

import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";
import { recordWorkflowRun } from "./statusHelper.js";
import { checkOllamaAvailable, ollamaChat, MEMORY_MODEL, type OllamaChatMessage } from "@repo/vault-memory";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "../..", ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DIGEST_MODEL = process.env.DIGEST_MODEL ?? "google/gemini-2.5-flash";

if (!OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is required.");
  recordWorkflowRun(VAULT_PATH, "web-digest", false, "OPENROUTER_API_KEY missing");
  process.exit(1);
}

const vault = new VaultClient(VAULT_PATH);

// ── RSS/Atom parsing (no external library) ────────────────────────────

interface FeedItem {
  title: string;
  url: string;
  description: string;
  pubDate?: string;
}

interface FeedCategory {
  name: string;
  feeds: Array<{ url: string; label: string }>;
}

/** Extract text between XML tags, handling CDATA. */
function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
  if (!m) return "";
  // Strip inner HTML tags and decode common entities
  return m[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Extract an attribute value from a self-closing or opening tag. */
function extractAttr(block: string, tag: string, attr: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, "i"));
  return m ? m[1] : "";
}

/** Fetch and parse one RSS or Atom feed. Returns up to `limit` items. */
async function fetchRSSFeed(url: string, label: string, limit = 5): Promise<FeedItem[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AgentHQ-Digest/1.0 (local vault digest)" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`[web-digest] ${label}: HTTP ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const isAtom = /<feed[\s>]/.test(xml);
    const blockTag = isAtom ? "entry" : "item";
    const blockRegex = new RegExp(`<${blockTag}>[\\s\\S]*?<\\/${blockTag}>`, "gi");

    const items: FeedItem[] = [];
    for (const match of xml.matchAll(blockRegex)) {
      if (items.length >= limit) break;
      const block = match[0];

      const title = extractTag(block, "title") || "Untitled";
      const description = isAtom
        ? (extractTag(block, "summary") || extractTag(block, "content") || "")
        : (extractTag(block, "description") || extractTag(block, "summary") || "");
      const itemUrl = isAtom
        ? (extractAttr(block, "link", "href") || extractTag(block, "id"))
        : (extractTag(block, "link") || extractAttr(block, "link", "href"));
      const pubDate = extractTag(block, isAtom ? "updated" : "pubDate");

      if (!itemUrl || !title) continue;

      items.push({
        title: title.slice(0, 120),
        url: itemUrl.trim().slice(0, 400),
        description: description.slice(0, 400),
        pubDate: pubDate.slice(0, 30),
      });
    }

    console.log(`[web-digest] ${label}: ${items.length} item(s)`);
    return items;
  } catch (err) {
    console.warn(`[web-digest] ${label} fetch failed: ${String(err).slice(0, 100)}`);
    return [];
  }
}

// ── Default curated feed list ─────────────────────────────────────────
// Free, legal, no API key required. Edit _system/DIGEST-FEEDS.md to
// add/remove feeds without touching code.

const DEFAULT_FEEDS: FeedCategory[] = [
  {
    name: "AI & Research",
    feeds: [
      { url: "https://simonwillison.net/atom/everything/", label: "Simon Willison" },
      { url: "https://www.quantamagazine.org/feed/", label: "Quanta Magazine" },
      { url: "https://www.anthropic.com/rss.xml", label: "Anthropic Blog" },
    ],
  },
  {
    name: "Tech & Startups",
    feeds: [
      { url: "https://news.ycombinator.com/rss", label: "Hacker News" },
      { url: "https://blog.ycombinator.com/rss/", label: "Y Combinator Blog" },
      { url: "https://www.theverge.com/ai-artificial-intelligence/rss/index.xml", label: "The Verge AI" },
    ],
  },
  {
    name: "African Business & Tech",
    feeds: [
      { url: "https://techcabal.com/feed/", label: "TechCabal" },
      { url: "https://disruptafrica.com/feed/", label: "Disrupt Africa" },
    ],
  },
  {
    name: "TypeScript & Dev",
    feeds: [
      { url: "https://devblogs.microsoft.com/typescript/feed/", label: "TypeScript Blog" },
      { url: "https://dev.to/feed/tag/typescript", label: "Dev.to TypeScript" },
    ],
  },
];

// ── DIGEST-FEEDS.md parser ────────────────────────────────────────────

/**
 * Parse _system/DIGEST-FEEDS.md into feed categories.
 *
 * Format:
 *   ## Category Name
 *   - https://feed.url | Feed Label
 *   - https://another.url
 */
function parseFeedsFile(content: string): FeedCategory[] {
  const categories: FeedCategory[] = [];
  let current: FeedCategory | null = null;

  for (const line of content.split("\n")) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      current = { name: headingMatch[1].trim(), feeds: [] };
      categories.push(current);
      continue;
    }
    const feedMatch = line.match(/^-\s+(https?:\/\/\S+)(?:\s*\|\s*(.+))?/);
    if (feedMatch && current) {
      current.feeds.push({
        url: feedMatch[1].trim(),
        label: feedMatch[2]?.trim() || feedMatch[1].trim(),
      });
    }
  }

  return categories.filter((c) => c.feeds.length > 0);
}

// ── RSS content sanitization ──────────────────────────────────────────
// Descriptions from external feeds must be sanitized before being passed
// to an LLM (prompt injection) or stored in the vault (persistent injection).

function sanitizeFeedText(raw: string, maxLen = 200): string {
  return raw
    .replace(/\r?\n|\r/g, " ")            // flatten newlines
    .replace(/#{1,6}\s/g, "")             // strip markdown headings
    .replace(/`{1,3}[^`]*`{1,3}/g, "")   // strip code spans/blocks
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // collapse links to label
    .replace(/[*_~|\\]/g, "")            // strip formatting chars
    .replace(/\s{2,}/g, " ")             // collapse whitespace
    .trim()
    .slice(0, maxLen);
}

function isSafeUrl(url: string): boolean {
  try {
    const p = new URL(url);
    return p.protocol === "https:" || p.protocol === "http:";
  } catch { return false; }
}

// ── Digest generation ─────────────────────────────────────────────────

const DIGEST_SYSTEM = `You are a research analyst creating a daily briefing for Calvin Magezi, CTO of Kolaborate Platforms (Uganda).
He is building AI agent systems, a diagramming tool (Chamuka), and a healthcare/construction platform (SiteSeer).
His tech stack: TypeScript, Bun, Next.js, Convex, Vercel.

Write a concise daily digest. For each category:
- Lead with the most actionable/relevant item
- Use bullet points, include source links
- Flag anything directly relevant to AI agents, TypeScript, African tech, or startup strategy
- Keep total length under 800 words`;

async function generateDigest(
  categoryResults: Map<string, Array<{ label: string; items: FeedItem[] }>>
): Promise<string> {
  // Build structured context — sanitize all external text before passing to LLM
  const context = Array.from(categoryResults.entries())
    .map(([category, feedResults]) => {
      const feedLines = feedResults
        .filter((f) => f.items.length > 0)
        .map((f) => {
          const items = f.items
            .map((i) => {
              const safeTitle = sanitizeFeedText(i.title, 120);
              const safeDesc = i.description ? sanitizeFeedText(i.description, 180) : "";
              const safeUrl = isSafeUrl(i.url) ? i.url.slice(0, 300) : "";
              const link = safeUrl ? `[${safeTitle}](${safeUrl})` : safeTitle;
              return `  - ${link}${safeDesc ? `: ${safeDesc}` : ""}`;
            })
            .join("\n");
          return `**${f.label}:**\n${items}`;
        })
        .join("\n\n");
      return `### ${category}\n\n${feedLines}`;
    })
    .filter((s) => s.includes("**"))
    .join("\n\n");

  if (!context.trim()) {
    return "_No feed content retrieved today. Check feed URLs in `_system/DIGEST-FEEDS.md`._";
  }

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const userMessage = `Create a daily digest for ${today} from these RSS feed items:\n\n${context}`;

  // Cost optimization: try local Ollama first (free), fall back to OpenRouter.
  // The digest is a pure summarization task — qwen handles it well locally.
  try {
    const ollamaAvailable = await checkOllamaAvailable();
    if (ollamaAvailable) {
      console.log("[web-digest] Using local Ollama for synthesis (free)");
      const messages: OllamaChatMessage[] = [
        { role: "system", content: DIGEST_SYSTEM },
        { role: "user", content: userMessage },
      ];
      return await ollamaChat(messages);
    }
  } catch (err) {
    console.warn("[web-digest] Ollama synthesis failed, falling back to OpenRouter:", String(err).slice(0, 80));
  }

  // OpenRouter fallback — with timeout to prevent hung duplicate runs
  console.log(`[web-digest] Using OpenRouter (${DIGEST_MODEL}) for synthesis`);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(120_000), // 2 min max — prevents hung duplicate invocations
    body: JSON.stringify({
      model: DIGEST_MODEL,
      messages: [
        { role: "system", content: DIGEST_SYSTEM },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error: ${response.status}`);
  }

  const result = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return result.choices[0]?.message?.content ?? "No digest generated.";
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[web-digest] Starting daily RSS digest...");

  // Load feed categories from vault file, or fall back to defaults
  const feedsFilePath = path.join(VAULT_PATH, "_system/DIGEST-FEEDS.md");
  let categories = DEFAULT_FEEDS;
  if (fs.existsSync(feedsFilePath)) {
    const parsed = parseFeedsFile(fs.readFileSync(feedsFilePath, "utf-8"));
    if (parsed.length > 0) {
      categories = parsed;
      console.log(`[web-digest] Loaded ${categories.length} category/categories from DIGEST-FEEDS.md`);
    }
  } else {
    console.log("[web-digest] DIGEST-FEEDS.md not found — using default feed list");
  }

  // Fetch all feeds concurrently per category
  const categoryResults = new Map<string, Array<{ label: string; items: FeedItem[] }>>();

  await Promise.all(
    categories.map(async (category) => {
      const feedResults = await Promise.all(
        category.feeds.map(async (feed) => ({
          label: feed.label,
          items: await fetchRSSFeed(feed.url, feed.label, 5),
        }))
      );
      categoryResults.set(category.name, feedResults);
    })
  );

  const totalItems = [...categoryResults.values()]
    .flat()
    .reduce((sum, f) => sum + f.items.length, 0);

  console.log(`[web-digest] Fetched ${totalItems} total items across ${categories.length} categories`);

  // Generate digest
  console.log("[web-digest] Generating digest...");
  const digest = await generateDigest(categoryResults);

  // Seed wikilinks from keyword search (non-fatal)
  const today = new Date().toISOString().split("T")[0];
  const noteTitle = `Daily Digest ${today}`;
  let body = digest;
  try {
    const search = new SearchClient(VAULT_PATH);
    const allLabels = categories.flatMap((c) => c.feeds.map((f) => f.label));
    const shortQuery = allLabels.slice(0, 4).join(" ");
    const related = search.keywordSearch(shortQuery, 5)
      .filter((r) => !r.notePath.includes(noteTitle));
    search.close();
    if (related.length > 0) {
      const links = related.map((r) => `- [[${r.title}]]`).join("\n");
      body += `\n\n<!-- agent-hq-graph-links -->\n## Related Notes\n\n${links}\n`;
    }
  } catch (err) {
    console.warn("[web-digest] Wikilink search failed (non-fatal):", String(err).substring(0, 100));
  }

  // Save to vault
  const feedCount = [...categoryResults.values()].flat().filter((f) => f.items.length > 0).length;
  await vault.createNote("Daily Digest", noteTitle, body, {
    noteType: "digest",
    tags: ["daily-digest", "auto-generated", "rss"],
    source: "web-digest",
  });

  recordWorkflowRun(VAULT_PATH, "web-digest", true);
  console.log(`[web-digest] Digest saved: ${noteTitle} (${totalItems} items from ${feedCount} feeds)`);
}

main().catch((err) => {
  recordWorkflowRun(VAULT_PATH, "web-digest", false, String(err));
  console.error("[web-digest] Fatal error:", err);
  process.exit(1);
});
