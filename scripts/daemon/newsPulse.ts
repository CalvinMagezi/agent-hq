/**
 * Daemon Task: News Pulse (every 15 min)
 *
 * Fetches top headlines from trusted RSS feeds and writes a compact
 * "Current News Pulse" section to _system/HEARTBEAT.md so all agents
 * have ambient awareness of current events.
 */

import * as fs from "fs";
import * as path from "path";
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

export async function refreshNewsPulse(ctx: DaemonContext): Promise<void> {
  const heartbeatPath = path.join(ctx.vaultPath, "_system/HEARTBEAT.md");
  if (!fs.existsSync(heartbeatPath)) return;

  const PULSE_MARKER = "<!-- agent-hq-news-pulse -->";
  const now = new Date().toUTCString();

  const feedResults = await Promise.allSettled(
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
        const link = rawLink.slice(0, 300);
        items.push(`- **[${feed.label}]** [${title}](${link})`);
      }
      return { label: feed.label, items };
    })
  );

  const lines: string[] = feedResults
    .filter((r): r is PromiseFulfilledResult<{ label: string; items: string[] }> => r.status === "fulfilled")
    .flatMap((r) => r.value.items);

  if (lines.length === 0) return;

  const pulseSection = `${PULSE_MARKER}\n## Current News Pulse\n_Updated: ${now}_\n\n${lines.join("\n")}\n`;

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
    console.log(`[news-pulse] Updated HEARTBEAT.md with ${lines.length} headline(s)`);
  } catch (err) {
    console.error("[news-pulse] Failed to update HEARTBEAT.md:", err);
  }
}
