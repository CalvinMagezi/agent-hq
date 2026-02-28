import type { Client } from "discord.js";

/**
 * Key-based typing indicator management.
 * Associates typing indicators with logical keys (e.g., job IDs)
 * so they can be started/stopped independently.
 */
export class TypingManager {
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private client: Client | null = null;

  /** Refresh interval — Discord typing indicator lasts ~10s */
  private static readonly REFRESH_MS = 8000;

  /** Set the Discord client (called by DiscordBotBase on start). */
  setClient(client: Client): void {
    this.client = client;
  }

  /**
   * Start typing indicator for a given key in a channel.
   * Sends immediately, then refreshes every 8s.
   */
  start(key: string, channelId: string): void {
    // Stop any existing typing for this key
    this.stop(key);

    this.sendTyping(channelId);
    const interval = setInterval(() => {
      this.sendTyping(channelId);
    }, TypingManager.REFRESH_MS);

    this.intervals.set(key, interval);
  }

  /** Stop typing indicator for a key. */
  stop(key: string): void {
    const interval = this.intervals.get(key);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(key);
    }
  }

  /** Stop all active typing indicators. */
  stopAll(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }

  /** Send a single typing indicator to a channel. */
  private async sendTyping(channelId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && "sendTyping" in channel) {
        await (channel as any).sendTyping();
      }
    } catch {
      // Silently ignore typing indicator errors
    }
  }
}
