import {
  PresenceUpdateStatus,
  ActivityType,
  type Client,
} from "discord.js";
import type { BotStatus, PresenceConfig } from "./types.js";

/**
 * Debounced Discord presence manager.
 * Wraps discord.js Client presence updates with rate-limit protection.
 */
export class PresenceManager {
  private client: Client | null = null;
  private lastUpdate = 0;
  private debounceMs: number;
  private onlineText: string;
  private busyText: string;

  constructor(config: PresenceConfig = {}) {
    this.debounceMs = config.debounceMs ?? 5000;
    this.onlineText = config.onlineText ?? "Idle — ready for tasks";
    this.busyText = config.busyText ?? "a task";
  }

  /** Set the Discord client (called by DiscordBotBase on start). */
  setClient(client: Client): void {
    this.client = client;
  }

  /** Update presence with debouncing to avoid rate limits. */
  update(status: BotStatus): void {
    if (!this.client?.user) return;

    const now = Date.now();
    if (now - this.lastUpdate < this.debounceMs) return;
    this.lastUpdate = now;

    try {
      switch (status) {
        case "online":
          this.client.user.setPresence({
            status: PresenceUpdateStatus.Online,
            activities: [{
              name: this.onlineText,
              type: ActivityType.Watching,
            }],
          });
          break;

        case "busy":
          this.client.user.setPresence({
            status: PresenceUpdateStatus.DoNotDisturb,
            activities: [{
              name: this.busyText,
              type: ActivityType.Playing,
            }],
          });
          break;

        case "offline":
          this.client.user.setPresence({
            status: PresenceUpdateStatus.Invisible,
            activities: [],
          });
          break;
      }
    } catch (err: any) {
      console.warn("[PresenceManager] Update failed:", err.message);
    }
  }
}
