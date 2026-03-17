#!/usr/bin/env bun
/**
 * morning-brief-notebooklm.ts — Daily deep-dive audio brief via Google NotebookLM.
 *
 * Gathers rich sources from the vault, calendar, and news, creates a NotebookLM
 * notebook, loads sources, generates a personalized deep-dive audio, and sends
 * the link via Telegram.
 *
 * Usage:
 *   bun run scripts/morning-brief-notebooklm.ts
 *   bun run scripts/morning-brief-notebooklm.ts --format deep_dive   (default)
 *   bun run scripts/morning-brief-notebooklm.ts --format debate
 *   bun run scripts/morning-brief-notebooklm.ts --dry-run
 *
 * Env:
 *   VAULT_PATH              — vault root (default: .vault)
 *   TELEGRAM_BOT_TOKEN      — Telegram bot token
 *   TELEGRAM_USER_ID        — Telegram chat ID
 *   MORNING_BRIEF_ENABLED   — must be "true"
 *   GWS_BIN                 — path to gws CLI (optional, for calendar)
 *   NLM_BIN                 — path to nlm CLI (default: auto-resolve)
 */

import "@repo/env-loader";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { execSync, spawnSync } from "child_process";

// ── Config ───────────────────────────────────────────────────────────────────

const VAULT_PATH = process.env.VAULT_PATH ?? resolve(import.meta.dir, "..", ".vault");
const DRY_RUN = process.argv.includes("--dry-run");
const AUDIO_FORMAT = (() => {
  const idx = process.argv.indexOf("--format");
  return idx !== -1 ? process.argv[idx + 1] ?? "deep_dive" : "deep_dive";
})();

const dateStr = new Date().toISOString().slice(0, 10);
const dateHuman = new Date().toLocaleDateString("en-US", {
  weekday: "long", year: "numeric", month: "long", day: "numeric",
  timeZone: "Africa/Nairobi",
});

// ── Binary resolution ────────────────────────────────────────────────────────

function resolveBin(names: string[], envVar?: string): string {
  if (envVar && process.env[envVar]) return process.env[envVar]!;
  for (const name of names) {
    try { return execSync(`which ${name}`, { encoding: "utf-8" }).trim(); }
    catch { continue; }
  }
  return names[0]; // fallback — let it fail with a clear error
}

const NLM = resolveBin(["nlm", "notebooklm-mcp"], "NLM_BIN");
const GWS = resolveBin(["gws"], "GWS_BIN");
const CURL = resolveBin(["curl"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function sh(cmd: string, timeout = 30_000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return ""; }
}

function nlm(args: string[], timeout = 120_000): { stdout: string; status: number | null } {
  const result = spawnSync(NLM, args, {
    encoding: "utf-8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { stdout: (result.stdout ?? "").trim(), status: result.status };
}

function readVaultFile(relative: string): string {
  const full = join(VAULT_PATH, relative);
  return existsSync(full) ? readFileSync(full, "utf-8") : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Source Gathering ─────────────────────────────────────────────────────────

function getNewsPulse(): string {
  const heartbeat = readVaultFile("_system/HEARTBEAT.md");
  const marker = "<!-- agent-hq-news-pulse -->";
  const idx = heartbeat.indexOf(marker);
  if (idx === -1) return "";
  return heartbeat.slice(idx + marker.length).trim().replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}

function getPinnedNotes(): Array<{ title: string; summary: string; content: string }> {
  const results: Array<{ title: string; summary: string; content: string }> = [];

  function scan(dir: string, depth = 0) {
    if (depth > 3) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const content = readFileSync(fullPath, "utf-8");
            if (!content.includes("pinned: true")) continue;
            const title = entry.name.replace(".md", "");
            const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("---") && !l.startsWith("#") && !l.match(/^[a-zA-Z]+:/));
            const summary = lines[0]?.trim().slice(0, 120) ?? "";
            results.push({ title, summary, content: content.slice(0, 3000) });
          } catch {}
        }
      }
    } catch {}
  }

  scan(join(VAULT_PATH, "Notebooks"));
  return results.slice(0, 8);
}

function getCalendarToday(): string {
  // Try gws CLI for calendar
  try {
    const today = dateStr;
    const result = sh(
      `${GWS} calendar events list --params '{"timeMin":"${today}T00:00:00+03:00","timeMax":"${today}T23:59:59+03:00","singleEvents":true,"orderBy":"startTime"}' 2>/dev/null`,
      15_000
    );
    if (result && result.length > 20) return result;
  } catch {}
  return "";
}

function getRecentProjectActivity(): string {
  // Recent git commits as project context
  const commits = sh(`cd ${resolve(import.meta.dir, "..")} && git log --oneline -15 --since="3 days ago" 2>/dev/null`);
  return commits;
}

function getModelIntel(): string {
  const intel = readVaultFile("_system/MODEL-INTELLIGENCE.md");
  return intel.slice(0, 3000); // Trim to keep source manageable
}

function getMemory(): string {
  return readVaultFile("_system/MEMORY.md");
}

// ── Extract news URLs for rich sourcing ──────────────────────────────────────

function extractNewsUrls(newsPulse: string): Array<{ title: string; url: string }> {
  const urls: Array<{ title: string; url: string }> = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(newsPulse)) !== null) {
    urls.push({ title: match[1], url: match[2] });
  }
  // Dedupe by URL and take top 8
  const seen = new Set<string>();
  return urls.filter(u => {
    if (seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  }).slice(0, 8);
}

// ── Main Pipeline ────────────────────────────────────────────────────────────

async function main() {
  console.log(`🌅 NotebookLM Morning Brief — ${dateHuman}`);
  console.log(`   Format: ${AUDIO_FORMAT}`);
  console.log(`   NLM CLI: ${NLM}\n`);

  // ── 1. Gather sources ──────────────────────────────────────────────────────
  console.log("📚 Gathering sources...");

  const newsPulse = getNewsPulse();
  const newsUrls = extractNewsUrls(newsPulse);
  const pinned = getPinnedNotes();
  const calendar = getCalendarToday();
  const recentCommits = getRecentProjectActivity();
  const modelIntel = getModelIntel();
  const memory = getMemory();

  console.log(`   News URLs: ${newsUrls.length}`);
  console.log(`   Pinned notes: ${pinned.length}`);
  console.log(`   Calendar: ${calendar ? "loaded" : "unavailable"}`);
  console.log(`   Model intel: ${modelIntel ? "yes" : "none"}`);
  console.log(`   Recent commits: ${recentCommits.split("\n").filter(Boolean).length}`);

  if (DRY_RUN) {
    console.log("\n🔍 DRY RUN — would create notebook with these sources:");
    console.log("  Text sources: calendar, pinned notes, memory, model-intel, project-activity");
    console.log(`  URL sources: ${newsUrls.map(u => u.title).join(", ")}`);
    return;
  }

  // ── 2. Create notebook ─────────────────────────────────────────────────────
  console.log("\n📓 Creating NotebookLM notebook...");
  const createResult = nlm(["notebook", "create", `Daily Brief — ${dateStr}`]);
  // Parse notebook ID from output
  const nbIdMatch = createResult.stdout.match(/([a-f0-9-]{36})/);
  if (!nbIdMatch) {
    console.error("❌ Failed to create notebook:", createResult.stdout);
    process.exit(1);
  }
  const notebookId = nbIdMatch[1];
  console.log(`   ✅ Notebook: ${notebookId}`);

  // ── 3. Add sources (parallel where possible) ──────────────────────────────
  console.log("\n📎 Adding sources...");

  // -- Text sources (added sequentially to avoid rate limits) --

  // Profile + context
  const profileText = [
    `# Daily Briefing Context — ${dateHuman}`,
    "",
    "## Who You Are",
    memory.slice(0, 2000),
    "",
    calendar ? `## Today's Calendar\n\n${calendar}` : "",
    "",
    recentCommits ? `## Recent Project Activity (last 3 days)\n\n${recentCommits}` : "",
  ].filter(Boolean).join("\n");

  const addSource = (type: string, title: string, content: string, url?: string) => {
    if (url) {
      const r = nlm(["source", "add", notebookId, "--url", url, "--wait"]);
      console.log(`   ${r.status === 0 ? "✅" : "⚠️ "} URL: ${title}`);
    } else {
      const r = nlm(["source", "add", notebookId, "--text", content, "--title", title, "--wait"]);
      console.log(`   ${r.status === 0 ? "✅" : "⚠️ "} Text: ${title}`);
    }
  };

  addSource("text", "Profile & Calendar", profileText);

  if (modelIntel) {
    addSource("text", "AI Model Intelligence", modelIntel);
  }

  if (newsPulse) {
    addSource("text", "News Pulse Headlines", newsPulse);
  }

  for (const note of pinned.slice(0, 4)) {
    addSource("text", `Pinned: ${note.title}`, note.content);
  }

  // -- URL sources (real web pages for NotebookLM to parse) --
  for (const news of newsUrls.slice(0, 6)) {
    addSource("url", news.title, "", news.url);
  }

  console.log(`\n   Total sources added: ${3 + Math.min(pinned.length, 4) + Math.min(newsUrls.length, 6)}`);

  // ── 4. Generate deep-dive audio ────────────────────────────────────────────
  console.log("\n🎙️  Generating deep-dive audio...");

  const focusPrompt = [
    `This is a personalized daily briefing for Calvin Magezi, CTO of Kolaborate in Kampala, Uganda.`,
    `Frame everything through his lens: a tech leader running multiple projects in East Africa.`,
    calendar ? `Reference his calendar for today and any key meetings.` : "",
    `Cover his active project context from the pinned notes, any engineering wins from recent commits,`,
    `and the most relevant tech and Africa news. Make it conversational, insightful, and actionable`,
    `— not a generic news recap. Prioritize Africa-relevant stories and AI/developer tooling news.`,
  ].filter(Boolean).join(" ");

  const audioResult = nlm([
    "audio", "create", notebookId,
    "--format", AUDIO_FORMAT,
    "--length", "long",
    "--focus", focusPrompt,
    "--confirm",
  ]);
  console.log(`   ${audioResult.status === 0 ? "✅" : "⚠️ "} Audio creation triggered`);

  // ── 5. Poll for completion ─────────────────────────────────────────────────
  console.log("\n⏳ Waiting for audio generation (typically 5–10 minutes)...");

  let audioUrl: string | null = null;
  const maxWait = 15 * 60 * 1000; // 15 minutes
  const pollInterval = 30_000; // 30 seconds
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(pollInterval);
    const elapsed = Math.round((Date.now() - start) / 1000);
    const statusResult = nlm(["studio", "status", notebookId, "--json"]);

    try {
      const data = JSON.parse(statusResult.stdout);
      const artifacts = data.artifacts ?? data;

      for (const artifact of (Array.isArray(artifacts) ? artifacts : [])) {
        if (artifact.type === "audio") {
          if (artifact.status === "completed" || artifact.audio_url) {
            audioUrl = artifact.audio_url ?? artifact.url ?? null;
            break;
          }
          if (artifact.status === "failed") {
            console.error("❌ Audio generation failed");
            break;
          }
        }
      }
    } catch {
      // JSON parse failed — try simple string check
      if (statusResult.stdout.includes("completed")) {
        // Re-fetch as JSON
        const retry = nlm(["studio", "status", notebookId, "--json"]);
        try {
          const data = JSON.parse(retry.stdout);
          for (const a of (data.artifacts ?? [])) {
            if (a.type === "audio") audioUrl = a.audio_url ?? a.url ?? null;
          }
        } catch {}
        break;
      }
    }

    if (audioUrl) break;
    process.stdout.write(`   ${elapsed}s elapsed...\r`);
  }

  const notebookUrl = `https://notebooklm.google.com/notebook/${notebookId}`;

  if (!audioUrl) {
    console.warn(`\n⚠️  Audio still processing after ${Math.round(maxWait / 60000)} minutes.`);
    console.log(`   Check manually: ${notebookUrl}`);
    // Still send Telegram with notebook link
    audioUrl = notebookUrl;
  } else {
    console.log(`\n✅ Audio ready!`);
  }

  // ── 6. Save results to vault ───────────────────────────────────────────────
  const outputDir = join(VAULT_PATH, "Notebooks/Daily Digest");
  const resultFile = join(outputDir, `Brief-${dateStr}-notebooklm.md`);
  const resultContent = [
    "---",
    `title: NotebookLM Brief — ${dateStr}`,
    `date: ${dateStr}`,
    "tags:",
    "  - daily-brief",
    "  - notebooklm",
    `notebook_id: ${notebookId}`,
    `audio_format: ${AUDIO_FORMAT}`,
    "---",
    "",
    `# NotebookLM Brief — ${dateHuman}`,
    "",
    `**Notebook**: [Open in NotebookLM](${notebookUrl})`,
    audioUrl !== notebookUrl ? `**Audio**: [Listen](${audioUrl})` : "",
    "",
    `## Sources Used`,
    "",
    `- Profile & Calendar`,
    modelIntel ? "- AI Model Intelligence" : "",
    newsPulse ? "- News Pulse Headlines" : "",
    ...pinned.slice(0, 4).map(n => `- Pinned: ${n.title}`),
    ...newsUrls.slice(0, 6).map(u => `- [${u.title}](${u.url})`),
    "",
    `## Focus Prompt`,
    "",
    `> ${focusPrompt}`,
    "",
  ].filter(l => l !== "").join("\n");

  writeFileSync(resultFile, resultContent, "utf-8");
  console.log(`📄 Saved: ${resultFile}`);

  // ── 7. Telegram notification ───────────────────────────────────────────────
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;

  if (botToken && chatId) {
    console.log("📱 Sending Telegram notification...");

    const tgMessage = [
      `🌅 <b>NotebookLM Brief — ${dateStr}</b>`,
      "",
      `Format: ${AUDIO_FORMAT} | Sources: ${3 + Math.min(pinned.length, 4) + Math.min(newsUrls.length, 6)}`,
      "",
      `<a href="${notebookUrl}">📓 Open Notebook</a>`,
      audioUrl !== notebookUrl ? `<a href="${audioUrl}">🎧 Listen to Audio</a>` : "",
    ].filter(Boolean).join("\n");

    const tgResult = spawnSync(CURL, [
      "-s", "-X", "POST",
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      "-d", `chat_id=${chatId}&parse_mode=HTML&text=${encodeURIComponent(tgMessage)}`,
    ], { encoding: "utf-8", timeout: 15_000 });

    if (tgResult.status === 0) {
      try {
        const resp = JSON.parse(tgResult.stdout) as { ok: boolean };
        if (resp.ok) console.log("   ✅ Telegram notification sent");
        else console.warn(`   ⚠️  Telegram API error: ${tgResult.stdout.slice(0, 120)}`);
      } catch {
        console.warn("   ⚠️  Couldn't parse Telegram response");
      }
    }
  }

  console.log(`\n✅ NotebookLM brief complete!`);
  console.log(`   Notebook: ${notebookUrl}`);
  console.log(`   Vault:    ${resultFile}`);
}

main().catch(err => {
  console.error("❌ Morning brief (NotebookLM) failed:", err);
  process.exit(1);
});
