import { ThreadAutoArchiveDuration, type Message, type ThreadChannel } from "discord.js";

/**
 * Manages auto-threading for long conversations.
 * After a configurable number of exchanges in a channel, creates
 * a thread to keep the main channel clean.
 */
export class ThreadManager {
  /** Number of messages per channel before auto-threading kicks in */
  private threshold: number;

  /** Track message counts per channel */
  private channelCounts = new Map<string, number>();

  /** Active thread mappings: channelId -> threadId */
  private activeThreads = new Map<string, string>();

  constructor(threshold: number = 4) {
    this.threshold = threshold;
  }

  /** Track messages in a channel (called for each user message). */
  trackMessage(channelId: string): void {
    const count = this.channelCounts.get(channelId) ?? 0;
    this.channelCounts.set(channelId, count + 1);
  }

  /** Check if we should create a thread for this channel. */
  shouldCreateThread(channelId: string): boolean {
    if (this.activeThreads.has(channelId)) return false;
    const count = this.channelCounts.get(channelId) ?? 0;
    return count >= this.threshold;
  }

  /**
   * Create a new thread from a message.
   * Returns the thread channel and a notification message for the parent channel.
   */
  async createThread(
    message: Message,
    title?: string,
  ): Promise<ThreadChannel | null> {
    try {
      if (!("threads" in message.channel)) return null;

      const threadName = title
        || this.generateTitle(message.content)
        || `Chat ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;

      const thread = await message.startThread({
        name: threadName.substring(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });

      this.activeThreads.set(message.channelId, thread.id);
      return thread;
    } catch (err: any) {
      console.error("[ThreadManager] Failed to create thread:", err.message);
      return null;
    }
  }

  /** Get the active thread for a channel, or null. */
  getActiveThread(channelId: string): string | null {
    return this.activeThreads.get(channelId) ?? null;
  }

  /** Clear thread mapping and message count (called on reset). */
  clearThread(channelId: string): void {
    this.activeThreads.delete(channelId);
    this.channelCounts.delete(channelId);
  }

  /** Generate a short thread title from the message content. */
  private generateTitle(content: string): string {
    if (!content) return "";
    const firstLine = content.split("\n")[0].replace(/[*_`#>]/g, "").trim();
    if (firstLine.length <= 50) return firstLine;
    const truncated = firstLine.substring(0, 47);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 20 ? truncated.substring(0, lastSpace) : truncated) + "...";
  }
}
