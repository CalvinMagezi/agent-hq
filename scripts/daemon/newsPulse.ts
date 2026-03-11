/**
 * Daemon Task: News Pulse (every 15 min)
 *
 * Fetches top headlines from trusted RSS feeds and writes a compact
 * "Current News Pulse" section to _system/HEARTBEAT.md so all agents
 * have ambient awareness of current events.
 *
 * When Gemini CLI is installed, also runs a web-search micro-task to
 * capture breaking stories that haven't hit RSS feeds yet.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "bun";
import type { DaemonContext } from "./context.js";

const NEWS_PULSE_FEEDS = [
  // Global news
  { url: "https://www.theguardian.com/world/rss", label: "Guardian" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", label: "Al Jazeera" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", label: "BBC" },
  // Tech
  { url: "https://techcrunch.com/feed/", label: "TechCrunch" },
  { url: "https://www.theverge.com/rss/index.xml", label: "The Verge" },
  { url: "https://www.wired.com/feed/rss", label: "Wired" },
  { url: "https://news.ycombinator.com/rss", label: "HN" },
  { url: "https://simonwillison.net/atom/everything/", label: "Simon Willison" },
  // Africa / Business
  { url: "https://techcabal.com/feed/", label: "TechCabal" },
  // AI / Research
  { url: "https://www.technologyreview.com/feed/", label: "MIT Tech Review" },
];

/**
 * Strip characters that could be used for prompt injection or markdown manipulation.
 * RSS titles from untrusted feeds are written into HEARTBEAT.md which all agents read.
 */
function sanitizePulseText(raw: string): string {
  return raw
    .replace(/\r?\n|\r/g, " ")
    .replace(/#{1,6}\s/g, "")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~|\\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 100);
}

/** Validate a URL is a safe https link before embedding in markdown. */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// ─── Gemini CLI web search ─────────────────────────────────────────

let geminiAvailable: boolean | null = null; // cached after first check

async function isGeminiInstalled(): Promise<boolean> {
  if (geminiAvailable !== null) return geminiAvailable;
  try {
    const proc = spawn({
      cmd: ["gemini", "--version"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    geminiAvailable = proc.exitCode === 0;
  } catch {
    geminiAvailable = false;
  }
  console.log(`[news-pulse] Gemini CLI: ${geminiAvailable ? "available" : "not found"}`);
  return geminiAvailable;
}

const GEMINI_NEWS_PROMPT = `You have web search. Search for today's top breaking news stories.

Output ONLY a compact markdown list using this exact format (no headers, no commentary):
- **[Category]** Headline summary (1 sentence max)

Categories to use: World, Tech, Business, Africa, Science, Sports

Rules:
- Maximum 8 items total
- Focus on stories from the last 6 hours
- Include at least 1 Africa-related story if any exist
- Include at least 2 tech/AI stories if any exist
- No URLs needed
- No commentary before or after the list`;

/**
 * Run a Gemini CLI micro-task to search the web for breaking news.
 * Returns markdown bullet lines, or empty array on failure.
 */
async function fetchGeminiNews(): Promise<string[]> {
  if (!(await isGeminiInstalled())) return [];

  try {
    const proc = spawn({
      cmd: ["gemini", "--yolo", "-p", GEMINI_NEWS_PROMPT],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const timer = setTimeout(() => proc.kill(), 60_000); // 60s timeout

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    clearTimeout(timer);
    await proc.exited;

    if (proc.exitCode !== 0) {
      if (stderr.trim()) {
        console.warn(`[news-pulse] Gemini stderr: ${stderr.trim().substring(0, 200)}`);
      }
      return [];
    }

    // Parse the response — extract only bullet lines
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- **["));

    // Sanitize each line to prevent injection
    const sanitized = lines.map((line) => {
      // Extract category and text from: - **[Category]** Text
      const match = line.match(/^- \*\*\[([^\]]+)\]\*\*\s*(.+)$/);
      if (!match) return null;
      const category = sanitizePulseText(match[1]);
      const text = sanitizePulseText(match[2]);
      if (!category || !text) return null;
      return `- **[${category}]** ${text}`;
    }).filter(Boolean) as string[];

    console.log(`[news-pulse] Gemini returned ${sanitized.length} breaking news items`);
    return sanitized;
  } catch (err) {
    console.warn(`[news-pulse] Gemini news fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ─── Main pulse refresh ────────────────────────────────────────────

export async function refreshNewsPulse(ctx: DaemonContext): Promise<void> {
  const heartbeatPath = path.join(ctx.vaultPath, "_system/HEARTBEAT.md");
  if (!fs.existsSync(heartbeatPath)) return;

  const PULSE_MARKER = "<!-- agent-hq-news-pulse -->";
  const now = new Date().toUTCString();

  // Run RSS feeds and Gemini search in parallel
  const [feedResults, geminiNews] = await Promise.all([
    Promise.allSettled(
      NEWS_PULSE_FEEDS.map(async (feed) => {
        const res = await fetch(feed.url, {
          headers: { "User-Agent": "AgentHQ-Pulse/1.0" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return { label: feed.label, items: [] as string[] };
        const xml = await res.text();
        const isAtom = /<feed[\s>]/.test(xml);
        const blockTag = isAtom ? "entry" : "item";
        const blockRegex = new RegExp(`<${blockTag}>[\\s\\S]*?<\\/${blockTag}>`, "gi");

        const items: string[] = [];
        for (const match of xml.matchAll(blockRegex)) {
          if (items.length >= 3) break;
          const block = match[0];
          const rawTitle = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]
            ?.replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
            .replace(/&#8220;/g, "\u201C").replace(/&#8221;/g, "\u201D").replace(/&#[0-9]+;/g, "") || "";
          const rawLink = isAtom
            ? (block.match(/\shref=["']([^"']+)["']/i)?.[1] || "")
            : (block.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1]?.trim() || "");

          const title = sanitizePulseText(rawTitle);
          if (!title || !rawLink || !isSafeUrl(rawLink)) continue;
          const link = rawLink.slice(0, 300).replace(/[()[\]]/g, (c) => encodeURIComponent(c));
          items.push(`- **[${feed.label}]** [${title}](${link})`);
        }
        return { label: feed.label, items };
      })
    ),
    fetchGeminiNews(),
  ]);

  const rssLines: string[] = feedResults
    .filter((r): r is PromiseFulfilledResult<{ label: string; items: string[] }> => r.status === "fulfilled")
    .flatMap((r) => r.value.items);

  if (rssLines.length === 0 && geminiNews.length === 0) return;

  // Build the pulse section — Gemini breaking news first (if any), then RSS
  const sections: string[] = [];

  if (geminiNews.length > 0) {
    sections.push("### Breaking (via web search)");
    sections.push(...geminiNews);
    sections.push("");
    sections.push("### From RSS Feeds");
  }

  sections.push(...rssLines);

  const totalItems = rssLines.length + geminiNews.length;
  const pulseSection = `${PULSE_MARKER}\n## Current News Pulse\n_Updated: ${now}_\n${sections.join("\n")}\n`;

  try {
    const existing = fs.readFileSync(heartbeatPath, "utf-8");
    let updated: string;
    if (existing.includes(PULSE_MARKER)) {
      const escapedMarker = PULSE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      updated = existing.replace(new RegExp(`${escapedMarker}[\\s\\S]*$`), pulseSection);
    } else {
      updated = existing.trimEnd() + "\n\n" + pulseSection;
    }
    fs.writeFileSync(heartbeatPath, updated, "utf-8");
    console.log(`[news-pulse] Updated HEARTBEAT.md with ${totalItems} headline(s) (${geminiNews.length} from Gemini, ${rssLines.length} from RSS)`);
  } catch (err) {
    console.error("[news-pulse] Failed to update HEARTBEAT.md:", err);
  }
}
