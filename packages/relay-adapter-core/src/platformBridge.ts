/**
 * PlatformBridge — contract every platform adapter must implement.
 *
 * Platform adapters (Telegram, WhatsApp, Discord, Web) implement this
 * interface and are passed to UnifiedAdapterBot, which handles all
 * orchestration logic (routing, commands, delegation, chat relay).
 */

// ─── Platform Identity ────────────────────────────────────────────

export type PlatformId = "telegram" | "whatsapp" | "discord" | "web" | "google-chat";

// ─── Capabilities ─────────────────────────────────────────────────

export interface PlatformCapabilities {
  /** Max chars per message before chunking is needed. */
  maxMessageLength: number;
  /** Platform supports inline keyboard buttons. */
  supportsInlineKeyboards: boolean;
  /** Platform supports emoji reactions on messages. */
  supportsReactions: boolean;
  /** Platform supports token-level streaming (no need to buffer). */
  supportsStreaming: boolean;
  /** Platform supports voice note sending/receiving. */
  supportsVoice: boolean;
  /** Platform supports media uploads. */
  supportsMedia: boolean;
  /** What formatting the platform's sendText expects. */
  formatType: "html" | "markdown" | "whatsapp" | "plain";
}

// ─── Messages ─────────────────────────────────────────────────────

export interface UnifiedMessage {
  /** Platform-native message ID (string — each platform uses different types). */
  id: string;
  /** Chat/channel/room identifier. */
  chatId: string;
  /** Sender user ID. */
  userId: string;
  /** Text content (may be empty if message is media-only). */
  content: string;
  /** Unix ms timestamp. */
  timestamp: number;
  /** Which platform this message came from. */
  platform: PlatformId;

  // Voice
  isVoiceNote?: boolean;
  audioBuffer?: Buffer;

  // Media
  mediaType?: "photo" | "video" | "document" | "audio" | "sticker";
  mediaBuffer?: Buffer;
  mediaMimeType?: string;
  mediaFilename?: string;
  mediaSize?: number;

  // Rich message types
  location?: { lat: number; lng: number };
  contactName?: string;
  contactPhone?: string;
  pollQuestion?: string;
  pollOptions?: string[];

  // Reply context
  replyToId?: string;
  replyContent?: string;
}

// ─── Platform Actions ─────────────────────────────────────────────

export type PlatformActionType = "button_press" | "reaction" | "slash_command";

export interface PlatformAction {
  type: PlatformActionType;
  actionId: string;  // e.g. "harness:claude-code"
  chatId: string;
  userId: string;
  /** Raw query ID / interaction ID for acknowledging. */
  queryId?: string;
}

// ─── Send Options ─────────────────────────────────────────────────

export interface SendOpts {
  /** Chat/channel ID for multi-channel platforms. */
  chatId?: string;
  /** Reply to a specific message ID. */
  replyToId?: string;
  /** Whether to suppress link previews. */
  disableLinkPreview?: boolean;
}

// ─── Bridge Interface ─────────────────────────────────────────────

export interface PlatformBridge {
  readonly platformId: PlatformId;
  readonly capabilities: PlatformCapabilities;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Receive (platform → UnifiedAdapterBot)
  onMessage(handler: (msg: UnifiedMessage) => void): void;
  onAction(handler: (action: PlatformAction) => void): void;

  // Send (UnifiedAdapterBot → platform)
  /** Send text. Returns the sent message ID (for tracking). */
  sendText(text: string, opts?: SendOpts): Promise<string | null>;
  /** Send a typing / composing indicator. */
  sendTyping(chatId?: string): Promise<void>;
  /** Send an emoji reaction to a specific message. */
  sendReaction(msgId: string, emoji: string, chatId?: string): Promise<void>;
  /** Send a binary file. */
  sendFile(buffer: Buffer, filename: string, caption?: string, chatId?: string): Promise<void>;
}
