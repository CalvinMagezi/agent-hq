import type { EmbedBuilder, Client } from "discord.js";

// ── Bot Configuration ────────────────────────────────────────────────

export interface DiscordBotConfig {
  /** Discord bot token */
  botToken: string;
  /** Authorized user ID (only this user can interact) */
  userId: string;
  /** Bot's own user ID (for mention detection) */
  botId?: string;
  /** Optional channel for notifications */
  channelId?: string;
}

// ── Presence ─────────────────────────────────────────────────────────

export type BotStatus = "online" | "busy" | "offline";

export interface PresenceConfig {
  /** Status text when online/idle */
  onlineText?: string;
  /** Status text when busy */
  busyText?: string;
  /** Debounce interval in ms (default: 5000) */
  debounceMs?: number;
}

// ── Messages ─────────────────────────────────────────────────────────

export interface IncomingMessage {
  /** Raw message content (mention already stripped) */
  content: string;
  /** Original unstripped content */
  rawContent: string;
  /** Message author info */
  author: { id: string; username: string; bot: boolean };
  /** Channel where the message was sent */
  channelId: string;
  /** Whether this is a DM */
  isDM: boolean;
  /** The original Discord message object */
  message: import("discord.js").Message;
}

// ── Command System ───────────────────────────────────────────────────

export interface CommandResult {
  handled: boolean;
  response?: string;
  embed?: EmbedBuilder;
  file?: { name: string; buffer: Buffer };
}

// ── Intent Classification ────────────────────────────────────────────

export type IntentTier = "instant" | "chat" | "claude";

export interface ClassificationResult {
  tier: IntentTier;
  /** Pre-computed response for instant tier */
  instantResponse?: string;
  /** Why this classification was chosen (for logging) */
  reason: string;
}

export interface IntentRule {
  patterns: RegExp[];
  response: string | ((ctx: Record<string, unknown>) => string);
  reason: string;
}
