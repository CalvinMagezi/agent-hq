// ── Core ─────────────────────────────────────────────────────────────
export { DiscordBotBase } from "./botBase.js";
export type { BotBaseOptions } from "./botBase.js";

// ── Types ────────────────────────────────────────────────────────────
export type {
  DiscordBotConfig,
  BotStatus,
  PresenceConfig,
  IncomingMessage,
  CommandResult,
  IntentTier,
  ClassificationResult,
  IntentRule,
} from "./types.js";

// ── Utilities ────────────────────────────────────────────────────────
export { chunkMessage } from "./chunker.js";
export { StreamingReply } from "./streamingReply.js";
export { ThreadManager } from "./threadManager.js";
export { stripMention, isBotAddressed, isAuthorized } from "./mentionUtils.js";
export { PresenceManager } from "./presenceManager.js";
export { TypingManager } from "./typingManager.js";

// ── Intent Classification ────────────────────────────────────────────
export { classifyIntent, DEFAULT_INTENT_RULES } from "./intentClassifier.js";

// ── Embeds ───────────────────────────────────────────────────────────
export {
  infoEmbed,
  successEmbed,
  warningEmbed,
  errorEmbed,
  formatTimeAgo,
} from "./embedKit.js";

// ── File Attachments ─────────────────────────────────────────────────
export { extractFileAttachments, buildAttachments } from "./fileAttachments.js";
export type { FileRef } from "./fileAttachments.js";

// ── Command System ───────────────────────────────────────────────────
export {
  CommandRegistry,
  loadCustomCommands,
  handleCustomCommand,
  getCustomCommands,
} from "./commandSystem/index.js";
export type {
  CommandDef,
  CommandContext,
  CustomCommandDef,
  CustomCommandContext,
} from "./commandSystem/index.js";
