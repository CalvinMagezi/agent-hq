/**
 * TelegramBridge — grammY bot wrapper providing a clean send/receive abstraction.
 *
 * Encapsulates all Telegram Bot API interactions:
 * - Message reception (text, photos, voice, documents, stickers, etc.)
 * - Security middleware (guard check on every update)
 * - File downloads from Telegram servers
 * - Sending messages with HTML formatting
 * - Inline keyboards, message editing, chat actions
 */

import { Bot, type Context, InputFile, InlineKeyboard } from "grammy";
import type { TelegramGuard } from "./guard.js";

// ─── Message types ───────────────────────────────────────────────

export interface TelegramMessage {
  id: number;
  chatId: number;
  userId: number;
  content: string;
  timestamp: number;

  // Voice
  isVoiceNote?: boolean;
  audioBuffer?: Buffer;
  audioDuration?: number;

  // Media
  mediaType?: "photo" | "video" | "document" | "sticker" | "audio" | "video_note";
  mediaBuffer?: Buffer;
  mediaMimeType?: string;
  mediaFilename?: string;
  mediaSize?: number;

  // Location
  location?: { lat: number; lng: number };

  // Contact
  contactName?: string;
  contactPhone?: string;

  // Poll
  pollQuestion?: string;
  pollOptions?: string[];

  // Reply context
  replyToMessageId?: number;
  replyContent?: string;    // text of the message being replied to (from cache)
  replyFromSelf?: boolean;  // true if replying to a bot-sent message
}

export type MessageCallback = (msg: TelegramMessage) => void;
export type CallbackQueryHandler = (queryId: string, data: string, chatId: number) => void;

export interface TelegramBridgeConfig {
  guard: TelegramGuard;
  token: string;
  debug?: boolean;
}

// ─── Bridge ──────────────────────────────────────────────────────

/** Max messages to keep in the reply-context cache. */
const MAX_CACHE_SIZE = 100;

export class TelegramBridge {
  private bot: Bot;
  private guard: TelegramGuard;
  private token: string;
  private messageCallback: MessageCallback | null = null;
  private callbackQueryHandler: CallbackQueryHandler | null = null;
  private chatId: number | null = null;
  private debug: boolean;

  /** LRU cache of recent messages: messageId → content text */
  private messageCache = new Map<number, string>();
  /** Track which message IDs were sent by the bot (for replyFromSelf) */
  private botMessageIds = new Set<number>();

  constructor(config: TelegramBridgeConfig) {
    this.guard = config.guard;
    this.token = config.token;
    this.debug = config.debug ?? false;
    this.bot = new Bot(config.token);
  }

  /** Register message callback. */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /** Register callback query handler (inline keyboard button presses). */
  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.callbackQueryHandler = handler;
  }

  /** Get the saved chat ID (set from first received message). */
  getChatId(): number | null {
    return this.chatId;
  }

  /**
   * Cache an outgoing bot message so its content can be used as reply context.
   * Call this from bot.ts after every sendMessage / sendPhoto / sendDocument.
   */
  cacheMessage(id: number, text: string): void {
    this.botMessageIds.add(id);
    this.messageCache.set(id, text);
    this.evictCache();
  }

  /** Remove the oldest entry when the cache exceeds MAX_CACHE_SIZE. */
  private evictCache(): void {
    while (this.messageCache.size > MAX_CACHE_SIZE) {
      const firstKey = this.messageCache.keys().next().value;
      if (firstKey !== undefined) {
        this.messageCache.delete(firstKey);
        this.botMessageIds.delete(firstKey);
      } else {
        break;
      }
    }
  }

  /** Start the bot with long polling. */
  async start(): Promise<void> {
    // Security middleware — check every update
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.guard.isAllowedUser(userId)) {
        if (this.debug && userId) {
          console.log(`[telegram] Blocked unauthorized user: ${userId}`);
        }
        return; // Silently ignore
      }

      // Save chat ID from first interaction
      if (!this.chatId && ctx.chat?.id) {
        this.chatId = ctx.chat.id;
        console.log(`[telegram] Chat ID saved: ${this.chatId}`);
      }

      await next();
    });

    // Text messages
    this.bot.on("message:text", async (ctx) => {
      const replyId = ctx.message.reply_to_message?.message_id;
      const msg: TelegramMessage = {
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: ctx.message.text,
        timestamp: ctx.message.date,
        replyToMessageId: replyId,
        replyContent: replyId !== undefined ? this.messageCache.get(replyId) : undefined,
        replyFromSelf: replyId !== undefined ? this.botMessageIds.has(replyId) : undefined,
      };
      this.messageCache.set(msg.id, msg.content);
      this.evictCache();
      this.emit(msg);
    });

    // Photos — pick highest resolution
    this.bot.on("message:photo", async (ctx) => {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];

      let buffer: Buffer | undefined;
      try {
        buffer = await this.downloadFile(largest.file_id);
      } catch (err) {
        console.error("[telegram] Photo download failed:", err);
      }

      const photoReplyId = ctx.message.reply_to_message?.message_id;
      const photoContent = ctx.message.caption ?? "";
      const photoMsg: TelegramMessage = {
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: photoContent,
        timestamp: ctx.message.date,
        mediaType: "photo",
        mediaBuffer: buffer,
        mediaMimeType: "image/jpeg",
        mediaSize: largest.file_size,
        replyToMessageId: photoReplyId,
        replyContent: photoReplyId !== undefined ? this.messageCache.get(photoReplyId) : undefined,
        replyFromSelf: photoReplyId !== undefined ? this.botMessageIds.has(photoReplyId) : undefined,
      };
      if (photoContent) { this.messageCache.set(photoMsg.id, photoContent); this.evictCache(); }
      this.emit(photoMsg);
    });

    // Voice notes
    this.bot.on("message:voice", async (ctx) => {
      const voice = ctx.message.voice;

      let buffer: Buffer | undefined;
      try {
        buffer = await this.downloadFile(voice.file_id);
      } catch (err) {
        console.error("[telegram] Voice download failed:", err);
      }

      const voiceReplyId = ctx.message.reply_to_message?.message_id;
      this.emit({
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: ctx.message.caption ?? "",
        timestamp: ctx.message.date,
        isVoiceNote: true,
        audioBuffer: buffer,
        audioDuration: voice.duration,
        replyToMessageId: voiceReplyId,
        replyContent: voiceReplyId !== undefined ? this.messageCache.get(voiceReplyId) : undefined,
        replyFromSelf: voiceReplyId !== undefined ? this.botMessageIds.has(voiceReplyId) : undefined,
      });
    });

    // Video notes (circular videos)
    this.bot.on("message:video_note", async (ctx) => {
      const vn = ctx.message.video_note;

      let buffer: Buffer | undefined;
      try {
        buffer = await this.downloadFile(vn.file_id);
      } catch (err) {
        console.error("[telegram] Video note download failed:", err);
      }

      const vnReplyId = ctx.message.reply_to_message?.message_id;
      this.emit({
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: "[Video note]",
        timestamp: ctx.message.date,
        mediaType: "video_note",
        mediaBuffer: buffer,
        mediaMimeType: "video/mp4",
        mediaSize: vn.file_size,
        replyToMessageId: vnReplyId,
        replyContent: vnReplyId !== undefined ? this.messageCache.get(vnReplyId) : undefined,
        replyFromSelf: vnReplyId !== undefined ? this.botMessageIds.has(vnReplyId) : undefined,
      });
    });

    // Documents
    this.bot.on("message:document", async (ctx) => {
      const doc = ctx.message.document;

      let buffer: Buffer | undefined;
      try {
        buffer = await this.downloadFile(doc.file_id);
      } catch (err) {
        console.error("[telegram] Document download failed:", err);
      }

      const docReplyId = ctx.message.reply_to_message?.message_id;
      this.emit({
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: ctx.message.caption ?? "",
        timestamp: ctx.message.date,
        mediaType: "document",
        mediaBuffer: buffer,
        mediaMimeType: doc.mime_type ?? "application/octet-stream",
        mediaFilename: doc.file_name ?? `doc-${Date.now()}`,
        mediaSize: doc.file_size,
        replyToMessageId: docReplyId,
        replyContent: docReplyId !== undefined ? this.messageCache.get(docReplyId) : undefined,
        replyFromSelf: docReplyId !== undefined ? this.botMessageIds.has(docReplyId) : undefined,
      });
    });

    // Videos
    this.bot.on("message:video", async (ctx) => {
      const video = ctx.message.video;

      let buffer: Buffer | undefined;
      try {
        buffer = await this.downloadFile(video.file_id);
      } catch (err) {
        console.error("[telegram] Video download failed:", err);
      }

      const videoReplyId = ctx.message.reply_to_message?.message_id;
      this.emit({
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: ctx.message.caption ?? "",
        timestamp: ctx.message.date,
        mediaType: "video",
        mediaBuffer: buffer,
        mediaMimeType: video.mime_type ?? "video/mp4",
        mediaSize: video.file_size,
        replyToMessageId: videoReplyId,
        replyContent: videoReplyId !== undefined ? this.messageCache.get(videoReplyId) : undefined,
        replyFromSelf: videoReplyId !== undefined ? this.botMessageIds.has(videoReplyId) : undefined,
      });
    });

    // Stickers
    this.bot.on("message:sticker", async (ctx) => {
      const sticker = ctx.message.sticker;
      const stickerReplyId = ctx.message.reply_to_message?.message_id;
      this.emit({
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: sticker.emoji ?? "[Sticker]",
        timestamp: ctx.message.date,
        mediaType: "sticker",
        replyToMessageId: stickerReplyId,
        replyContent: stickerReplyId !== undefined ? this.messageCache.get(stickerReplyId) : undefined,
        replyFromSelf: stickerReplyId !== undefined ? this.botMessageIds.has(stickerReplyId) : undefined,
      });
    });

    // Location
    this.bot.on("message:location", async (ctx) => {
      const loc = ctx.message.location;
      const locReplyId = ctx.message.reply_to_message?.message_id;
      this.emit({
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: `Location: ${loc.latitude}, ${loc.longitude}`,
        timestamp: ctx.message.date,
        location: { lat: loc.latitude, lng: loc.longitude },
        replyToMessageId: locReplyId,
        replyContent: locReplyId !== undefined ? this.messageCache.get(locReplyId) : undefined,
        replyFromSelf: locReplyId !== undefined ? this.botMessageIds.has(locReplyId) : undefined,
      });
    });

    // Contact
    this.bot.on("message:contact", async (ctx) => {
      const contact = ctx.message.contact;
      const contactReplyId = ctx.message.reply_to_message?.message_id;
      this.emit({
        id: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        content: `Contact: ${contact.first_name} ${contact.last_name ?? ""} — ${contact.phone_number}`,
        timestamp: ctx.message.date,
        contactName: `${contact.first_name} ${contact.last_name ?? ""}`.trim(),
        contactPhone: contact.phone_number,
        replyToMessageId: contactReplyId,
        replyContent: contactReplyId !== undefined ? this.messageCache.get(contactReplyId) : undefined,
        replyFromSelf: contactReplyId !== undefined ? this.botMessageIds.has(contactReplyId) : undefined,
      });
    });

    // Callback queries (inline keyboard button presses)
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const queryId = ctx.callbackQuery.id;
      const chatId = ctx.callbackQuery.message?.chat.id ?? this.chatId ?? 0;
      this.callbackQueryHandler?.(queryId, data, chatId);
    });

    // Error handler
    this.bot.catch((err) => {
      console.error("[telegram] Bot error:", err.message ?? err);
    });

    // Start long polling
    console.log("[telegram] Starting bot with long polling...");
    this.bot.start({
      onStart: () => console.log("[telegram] Bot is running!"),
      drop_pending_updates: true,
    });
  }

  /** Stop the bot gracefully. */
  async stop(): Promise<void> {
    console.log("[telegram] Stopping bot...");
    await this.bot.stop();
  }

  // ─── Send methods ────────────────────────────────────────────

  async sendMessage(
    text: string,
    options?: { replyTo?: number; parseMode?: "HTML" | "MarkdownV2" },
  ): Promise<number | null> {
    const chatId = this.chatId;
    if (!chatId) return null;

    try {
      const msg = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: options?.parseMode ?? "HTML",
        reply_parameters: options?.replyTo ? { message_id: options.replyTo } : undefined,
        link_preview_options: { is_disabled: true },
      });
      return msg.message_id;
    } catch (err) {
      // If HTML parsing fails, retry as plain text
      if (String(err).includes("can't parse entities")) {
        try {
          const msg = await this.bot.api.sendMessage(chatId, text, {
            reply_parameters: options?.replyTo ? { message_id: options.replyTo } : undefined,
          });
          return msg.message_id;
        } catch (retryErr) {
          console.error("[telegram] Send message fallback failed:", retryErr);
          return null;
        }
      }
      console.error("[telegram] Send message failed:", err);
      return null;
    }
  }

  async sendMessageWithKeyboard(
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<number | null> {
    const chatId = this.chatId;
    if (!chatId) return null;

    try {
      const msg = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return msg.message_id;
    } catch (err) {
      console.error("[telegram] Send message with keyboard failed:", err);
      return null;
    }
  }

  async sendPhoto(buffer: Buffer, caption?: string): Promise<number | null> {
    const chatId = this.chatId;
    if (!chatId) return null;

    try {
      const msg = await this.bot.api.sendPhoto(
        chatId,
        new InputFile(buffer, "photo.jpg"),
        { caption, parse_mode: "HTML" },
      );
      return msg.message_id;
    } catch (err) {
      console.error("[telegram] Send photo failed:", err);
      return null;
    }
  }

  async sendDocument(buffer: Buffer, filename: string, caption?: string): Promise<number | null> {
    const chatId = this.chatId;
    if (!chatId) return null;

    try {
      const msg = await this.bot.api.sendDocument(
        chatId,
        new InputFile(buffer, filename),
        { caption, parse_mode: "HTML" },
      );
      return msg.message_id;
    } catch (err) {
      console.error("[telegram] Send document failed:", err);
      return null;
    }
  }

  async sendVoiceNote(buffer: Buffer): Promise<number | null> {
    const chatId = this.chatId;
    if (!chatId) return null;

    try {
      const msg = await this.bot.api.sendVoice(
        chatId,
        new InputFile(buffer, "voice.ogg"),
      );
      return msg.message_id;
    } catch (err) {
      console.error("[telegram] Send voice failed:", err);
      return null;
    }
  }

  async sendLocation(lat: number, lng: number): Promise<number | null> {
    const chatId = this.chatId;
    if (!chatId) return null;

    try {
      const msg = await this.bot.api.sendLocation(chatId, lat, lng);
      return msg.message_id;
    } catch (err) {
      console.error("[telegram] Send location failed:", err);
      return null;
    }
  }

  async sendPoll(question: string, options: string[]): Promise<number | null> {
    const chatId = this.chatId;
    if (!chatId) return null;

    try {
      const msg = await this.bot.api.sendPoll(
        chatId,
        question,
        options.map((o) => ({ text: o })),
        { is_anonymous: false },
      );
      return msg.message_id;
    } catch (err) {
      console.error("[telegram] Send poll failed:", err);
      return null;
    }
  }

  // ─── Telegram-specific methods ─────────────────────────────────

  async editMessage(messageId: number, newText: string): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;

    try {
      await this.bot.api.editMessageText(chatId, messageId, newText, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      // If HTML fails, try plain text
      if (String(err).includes("can't parse entities")) {
        try {
          await this.bot.api.editMessageText(chatId, messageId, newText);
        } catch {
          // Ignore — message may have been deleted
        }
      }
      // "message is not modified" is not an error
      if (!String(err).includes("not modified")) {
        console.error("[telegram] Edit message failed:", err);
      }
    }
  }

  async deleteMessage(messageId: number): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;

    try {
      await this.bot.api.deleteMessage(chatId, messageId);
    } catch (err) {
      console.error("[telegram] Delete message failed:", err);
    }
  }

  async sendChatAction(action: "typing" | "upload_voice" | "upload_photo" | "upload_document"): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;

    try {
      await this.bot.api.sendChatAction(chatId, action);
    } catch {
      // Non-critical — ignore
    }
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    try {
      await this.bot.api.answerCallbackQuery(queryId, { text });
    } catch (err) {
      console.error("[telegram] Answer callback query failed:", err);
    }
  }

  // ─── File download ─────────────────────────────────────────────

  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error("No file_path returned from Telegram");
    }

    const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`File download failed: ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  // ─── Internal ──────────────────────────────────────────────────

  private emit(msg: TelegramMessage): void {
    if (this.messageCallback) {
      this.messageCallback(msg);
    }
  }
}

// Re-export InlineKeyboard for bot.ts
export { InlineKeyboard } from "grammy";
