/**
 * notificationService.ts
 *
 * Proactive push notifications from the daemon to Calvin's preferred channels.
 * Priority order: Telegram + Web Push (parallel) → Discord fallback
 *
 * Env vars (read from relay .env.local at startup):
 *   TELEGRAM_BOT_TOKEN   — from apps/relay-adapter-telegram/.env.local
 *   TELEGRAM_USER_ID     — Calvin's numeric Telegram ID
 *   DISCORD_WEBHOOK_URL  — optional fallback Discord webhook
 *
 * Usage:
 *   import { notify, notifyIfMeaningful } from "./notificationService.js";
 *   await notify("📊 Daily project pulse is ready — ask me to summarize it");
 *   await notifyIfMeaningful("memory-digest", "pruned 12 entries", count > 0);
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    vars[key] = val;
  }
  return vars;
}

const AGENT_HQ_ROOT = join(import.meta.dir, "..");
const TG_ENV = loadEnvFile(join(AGENT_HQ_ROOT, "apps/relay-adapter-telegram/.env.local"));
const DISCORD_ENV = loadEnvFile(join(AGENT_HQ_ROOT, "apps/discord-relay/.env.local"));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? TG_ENV["TELEGRAM_BOT_TOKEN"] ?? "";
const TG_USER_ID = process.env.TELEGRAM_USER_ID ?? TG_ENV["TELEGRAM_USER_ID"] ?? "";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ?? DISCORD_ENV["DISCORD_WEBHOOK_URL"] ?? "";

// PWA Web Push via ws-server on port 4748
const WS_SERVER = process.env.HQ_WS_SERVER ?? "http://localhost:4748";

const TG_AVAILABLE = !!(TG_TOKEN && TG_USER_ID);
const DISCORD_AVAILABLE = !!DISCORD_WEBHOOK;

if (!TG_AVAILABLE && !DISCORD_AVAILABLE) {
  console.log("[notify] No Telegram/Discord configured — will use Web Push only if PWA subscribers exist");
}

// ─── Dedup — don't spam the same message within a cooldown window ─────────────

const recentMessages = new Map<string, number>(); // key → last sent timestamp
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isDuplicate(key: string): boolean {
  const last = recentMessages.get(key);
  if (!last) return false;
  return Date.now() - last < DEDUP_WINDOW_MS;
}

function markSent(key: string): void {
  recentMessages.set(key, Date.now());
}

// ─── Telegram push ────────────────────────────────────────────────────────────

async function sendTelegram(text: string): Promise<boolean> {
  if (!TG_AVAILABLE) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_USER_ID,
        text,
        parse_mode: "HTML",
        disable_notification: false,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn("[notify:telegram] Failed:", err.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[notify:telegram] Network error:", err);
    return false;
  }
}

// ─── Web Push (PWA native notifications) ─────────────────────────────────────

async function sendWebPush(title: string, body: string, url = "/"): Promise<boolean> {
  try {
    const res = await fetch(`${WS_SERVER}/push/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, url, tag: "hq-daemon" }),
    });
    return res.ok;
  } catch {
    return false; // ws-server not running — silently skip
  }
}

// ─── Discord webhook push ─────────────────────────────────────────────────────

async function sendDiscord(text: string): Promise<boolean> {
  if (!DISCORD_AVAILABLE) return false;
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    return res.ok;
  } catch (err) {
    console.warn("[notify:discord] Network error:", err);
    return false;
  }
}

// ─── Strip HTML tags for plain-text channels ──────────────────────────────────

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a proactive notification to Calvin.
 * Fires Telegram + Web Push in parallel, falls back to Discord.
 * @param message  The message text (supports basic HTML for Telegram)
 * @param dedupKey Optional dedup key — if same key sent within 10min, skip
 * @param url      Deep-link URL for Web Push notification tap (default: "/")
 */
export async function notify(message: string, dedupKey?: string, url = "/"): Promise<void> {
  const key = dedupKey ?? message.slice(0, 60);
  if (isDuplicate(key)) return;

  // Extract a short title for Web Push (first line, stripped of HTML)
  const plain = stripHtml(message);
  const firstLine = plain.split("\n")[0].trim().slice(0, 60) || "HQ";
  const body = plain.slice(firstLine.length).trim().slice(0, 120);

  // Fire Telegram + Web Push in parallel; Discord is fallback only
  const [tgSent, wpSent] = await Promise.all([
    sendTelegram(message),
    sendWebPush(firstLine, body || firstLine, url),
  ]);

  const sent = tgSent || wpSent || (!tgSent && (await sendDiscord(message)));

  if (sent) {
    markSent(key);
    console.log(`[notify] Sent: ${message.slice(0, 80).replace(/\n/g, " ")}`);
  }
}

/**
 * Only notify if a condition is met — avoids noise on "nothing happened" runs.
 * @param taskName   Used in dedup key + log prefix
 * @param summary    Short summary appended to the message
 * @param condition  Only send if true
 * @param msgBuilder Optional custom message builder
 */
export async function notifyIfMeaningful(
  taskName: string,
  summary: string,
  condition: boolean,
  msgBuilder?: (summary: string) => string
): Promise<void> {
  if (!condition) return;
  const defaultMsg = TASK_MESSAGES[taskName]
    ? TASK_MESSAGES[taskName](summary)
    : `<b>Agent-HQ</b>: ${taskName} — ${summary}`;
  const message = msgBuilder ? msgBuilder(summary) : defaultMsg;
  await notify(message, `${taskName}:${new Date().toDateString()}`);
}

// ─── Per-task message templates ───────────────────────────────────────────────

const TASK_MESSAGES: Record<string, (detail: string) => string> = {
  "project-status-pulse": (detail) =>
    `📊 <b>Daily Project Pulse</b> is ready\n${detail}\n\nAsk me: <i>"Summarise my project pulse"</i>`,

  "vault-memory-digest": (detail) =>
    `🧠 <b>Memory Digest</b> complete\n${detail}\n\nYour MEMORY.md has been pruned and consolidated.`,

  "vault-soul-check": (detail) =>
    `🔍 <b>Weekly Soul Check</b> complete\n${detail}`,

  "vault-dead-links": (detail) =>
    `🔗 <b>Link Health</b>: ${detail}\nSee <code>_system/LINK-HEALTH.md</code> for details.`,

  "vault-orphan-notes": (detail) =>
    `🗂 <b>Orphan Notes</b>: ${detail}\nSee <code>_system/ORPHAN-NOTES.md</code> for the list.`,

  "note-linking": (detail) =>
    `🔗 <b>Note Linking</b> complete — ${detail}`,

  "topic-mocs": (detail) =>
    `📚 <b>MOC pages</b> updated — ${detail}`,

  "memory-consolidation": (detail) =>
    `🧠 <b>Memory consolidation</b> cycle done — ${detail}`,

  "health-check": (detail) =>
    `⚠️ <b>Health Alert</b>: ${detail}`,

  "embeddings": (detail) =>
    `🔍 <b>Embeddings</b> updated — ${detail}`,
};

export { TG_AVAILABLE, DISCORD_AVAILABLE };
