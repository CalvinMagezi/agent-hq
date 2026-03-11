/**
 * ChannelRouter — smart single-channel notification picker.
 *
 * Reads _system/CHANNEL-PRESENCE.md to find Calvin's most recently active
 * channel, then routes to exactly ONE channel instead of spamming all.
 *
 * Selection logic (no LLM):
 *   1. Pick channel with most recent activity within 2 hours
 *   2. No recent activity → Telegram (primary)
 *   3. urgency:"high" → most-recent + Telegram (max 2)
 *   4. 10-min dedup per message
 */

import * as fs from "fs";
import * as path from "path";
import {
  sendTelegram,
  sendDiscord,
  sendWebPush,
} from "../notificationService.js";

export type NotifyUrgency = "normal" | "high";

interface ChannelPresence {
  telegram?: string;
  discord?: string;
  web?: string;
}

// In-process dedup map (separate from notificationService's own dedup since we
// don't go through the combined notify() function here)
const recentMessages = new Map<string, number>();
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

function isDuplicate(key: string): boolean {
  const last = recentMessages.get(key);
  if (!last) return false;
  return Date.now() - last < DEDUP_WINDOW_MS;
}

function markSent(key: string): void {
  recentMessages.set(key, Date.now());
}

export class ChannelRouter {
  private presencePath: string;

  constructor(vaultPath: string) {
    this.presencePath = path.join(vaultPath, "_system", "CHANNEL-PRESENCE.md");
  }

  /**
   * Update presence for a channel (called by relay adapters on user message).
   */
  updatePresence(channel: "telegram" | "discord" | "web"): void {
    try {
      let presence: ChannelPresence = {};

      if (fs.existsSync(this.presencePath)) {
        const raw = fs.readFileSync(this.presencePath, "utf-8");
        for (const line of raw.split("\n")) {
          const m = line.match(/^(telegram|discord|web):\s*(.+)$/);
          if (m) presence[m[1] as keyof ChannelPresence] = m[2].trim();
        }
      }

      presence[channel] = new Date().toISOString();
      this.writePresence(presence);
    } catch (err) {
      console.warn("[channel-router] Failed to update presence:", err);
    }
  }

  /**
   * Send a notification to the best single channel.
   */
  async notify(
    message: string,
    opts: { dedupKey?: string; urgency?: NotifyUrgency; url?: string } = {}
  ): Promise<void> {
    const { dedupKey, urgency = "normal", url = "/" } = opts;
    const key = dedupKey ?? message.slice(0, 60);

    if (isDuplicate(key)) return;

    const channels = this.pickChannels(urgency);

    let sent = false;
    for (const channel of channels) {
      if (channel === "telegram") {
        sent = (await sendTelegram(message)) || sent;
      } else if (channel === "discord") {
        sent = (await sendDiscord(message)) || sent;
      } else if (channel === "web") {
        const firstLine = message.replace(/<[^>]+>/g, "").split("\n")[0].trim().slice(0, 60) || "HQ";
        const body = message.replace(/<[^>]+>/g, "").slice(firstLine.length).trim().slice(0, 120);
        sent = (await sendWebPush(firstLine, body || firstLine, url)) || sent;
      }
    }

    if (sent) {
      markSent(key);
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private readPresence(): ChannelPresence {
    try {
      if (!fs.existsSync(this.presencePath)) return {};
      const raw = fs.readFileSync(this.presencePath, "utf-8");
      const presence: ChannelPresence = {};
      for (const line of raw.split("\n")) {
        const m = line.match(/^(telegram|discord|web):\s*(.+)$/);
        if (m) presence[m[1] as keyof ChannelPresence] = m[2].trim();
      }
      return presence;
    } catch {
      return {};
    }
  }

  private writePresence(presence: ChannelPresence): void {
    const lines = [
      "---",
      "noteType: system-file",
      "---",
      "# Channel Presence",
      "",
      "Last-active timestamp per channel. Updated by relay adapters on user message.",
      "",
    ];
    for (const [ch, ts] of Object.entries(presence)) {
      if (ts) lines.push(`${ch}: ${ts}`);
    }
    fs.writeFileSync(this.presencePath, lines.join("\n") + "\n", "utf-8");
  }

  private pickChannels(urgency: NotifyUrgency): string[] {
    const presence = this.readPresence();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();

    // Find most recently active channel within 2 hours
    let bestChannel: string | null = null;
    let bestTime = 0;

    for (const [ch, ts] of Object.entries(presence)) {
      if (!ts) continue;
      const t = new Date(ts).getTime();
      const age = now - t;
      if (age <= TWO_HOURS_MS && t > bestTime) {
        bestTime = t;
        bestChannel = ch;
      }
    }

    // Fallback: Telegram (Calvin's primary)
    if (!bestChannel) {
      bestChannel = "telegram";
    }

    if (urgency === "high") {
      // Most-recent channel + Telegram (deduplicated, max 2)
      const channels = [bestChannel];
      if (bestChannel !== "telegram") channels.push("telegram");
      return channels;
    }

    return [bestChannel];
  }
}
