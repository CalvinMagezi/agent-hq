import {
  MessageFlags,
  type Message,
  type Interaction,
  AttachmentBuilder,
} from "discord.js";
import {
  DiscordBotBase,
} from "@repo/discord-core";
import {
  type PlatformBridge,
  type PlatformCapabilities,
  type PlatformAction,
  type SendOpts,
  type UnifiedMessage,
} from "@repo/relay-adapter-core";
import type { RelayConfig } from "./types.js";
import { mkdir, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { createTranscriber, type Transcriber } from "./transcribe.js";

/**
 * DiscordBridge — implements PlatformBridge for Discord.
 * Wraps DiscordBotBase for client lifecycle and basic messaging.
 */
export class DiscordBridge extends DiscordBotBase implements PlatformBridge {
  readonly platformId = "discord" as const;
  readonly capabilities: PlatformCapabilities = {
    maxMessageLength: 2000,
    supportsInlineKeyboards: true, // Discord buttons
    supportsReactions: true,
    supportsStreaming: false,
    supportsVoice: true,
    supportsMedia: true,
    formatType: "markdown",
  };

  private unifiedMessageCallback: ((msg: UnifiedMessage) => void) | null = null;
  private actionCallback: ((action: PlatformAction) => void) | null = null;
  private readyCallbacks: (() => Promise<void>)[] = [];
  private transcriber: Transcriber | null = null;
  private configExtended: RelayConfig;

  constructor(config: RelayConfig) {
    super({
      config: {
        botToken: config.discordBotToken,
        userId: config.discordUserId,
        botId: config.discordBotId,
      },
      label: "Discord Relay",
      presence: {
        onlineText: "Ready for messages",
        busyText: "Processing...",
      },
    });
    this.configExtended = config;
    this.transcriber = createTranscriber(config);
  }

  // ── PlatformBridge Implementation ────────────────────────────────

  onMessage(handler: (msg: UnifiedMessage) => void): void {
    this.unifiedMessageCallback = handler;
  }

  onAction(handler: (action: PlatformAction) => void): void {
    this.actionCallback = handler;
  }

  /** Register a callback to fire when the Discord client is ready. */
  addReadyCallback(handler: () => Promise<void>): void {
    this.readyCallbacks.push(handler);
  }

  /** DiscordBotBase hook — fires registered onReady callbacks. */
  override async onReady(): Promise<void> {
    for (const cb of this.readyCallbacks) {
      await cb();
    }
  }

  async sendText(text: string, opts?: SendOpts): Promise<string | null> {
    const targetChatId = opts?.chatId;
    if (!targetChatId) return null;
    await this.sendMessage(targetChatId, text);
    return null;
  }

  async sendReaction(msgId: string, emoji: string, chatId?: string): Promise<void> {
    if (!this.client || !chatId) return;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && "messages" in channel) {
        const msg = await (channel as any).messages.fetch(msgId);
        if (msg) await msg.react(emoji);
      }
    } catch (err) {
      console.error("[DiscordBridge] Failed to send reaction:", err);
    }
  }

  async sendTyping(chatId?: string): Promise<void> {
    if (chatId) this.startTyping("unified-bot", chatId);
  }

  async stopTyping(): Promise<void> {
    this.typing.stopAll();
  }

  async sendFile(
    buffer: Buffer,
    filename: string,
    caption?: string,
    chatId?: string
  ): Promise<void> {
    if (!chatId) return;
    const attachment = new AttachmentBuilder(buffer, { name: filename, description: caption });
    await this.sendDiscordFiles(chatId, [attachment]);
  }

  // ── DiscordBotBase Hooks ──────────────────────────────────────────

  /** Implementing the abstract onDiscordMessage from DiscordBotBase. */
  async onDiscordMessage(msg: any): Promise<void> {
    if (!this.unifiedMessageCallback) return;

    const message = msg.message as Message;
    let content = msg.content;

    // Handle voice message transcription
    const isVoiceMessage = message.flags.has(MessageFlags.IsVoiceMessage);
    const audioAttachment = message.attachments.find(
      (a) => a.contentType?.startsWith("audio/") ?? false
    );

    let audioBuffer: Buffer | undefined;

    if (isVoiceMessage && audioAttachment && this.transcriber) {
      try {
        await mkdir(this.configExtended.uploadsDir, { recursive: true });
        const audioPath = join(this.configExtended.uploadsDir, `${Date.now()}_voice.ogg`);
        const audioResponse = await fetch(audioAttachment.url);
        audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
        await writeFile(audioPath, audioBuffer);

        const result = await this.transcriber.transcribe(audioPath);
        await unlink(audioPath).catch(() => {});

        if (result.text) {
          content = content ? `${content}\n\n[Voice]: ${result.text}` : result.text;
        }
      } catch (err) {
        console.error("[DiscordBridge] Transcription error:", err);
      }
    }

    // Media handling for first non-voice attachment
    const firstMedia = message.attachments.find(
      (a) => !(a.contentType?.startsWith("audio/") && isVoiceMessage)
    );

    const unified: UnifiedMessage = {
      id: message.id,
      chatId: message.channelId,
      userId: message.author.id,
      content,
      timestamp: message.createdTimestamp,
      platform: "discord",
    };

    if (isVoiceMessage && audioBuffer) {
      unified.isVoiceNote = true;
      unified.audioBuffer = audioBuffer;
    }

    if (firstMedia) {
      unified.mediaType = "document"; // Default
      if (firstMedia.contentType?.startsWith("image/")) unified.mediaType = "photo";
      if (firstMedia.contentType?.startsWith("video/")) unified.mediaType = "video";
      
      unified.mediaMimeType = firstMedia.contentType || "application/octet-stream";
      unified.mediaFilename = firstMedia.name || "file";
      unified.mediaSize = firstMedia.size;
      
      try {
        const resp = await fetch(firstMedia.url);
        unified.mediaBuffer = Buffer.from(await resp.arrayBuffer());
      } catch (e) {
        console.error("[DiscordBridge] Failed to download media:", e);
      }
    }

    // If it's a reply, find the quoted text
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (refMsg) {
          unified.replyToId = refMsg.id;
          unified.replyContent = refMsg.content || "[Media/Embed]";
        }
      } catch {}
    }

    this.unifiedMessageCallback(unified);
  }

  /** Handle interactions (buttons). */
  protected async onInteraction(interaction: Interaction): Promise<boolean> {
    if (!this.actionCallback) return false;

    if (interaction.isButton()) {
      this.actionCallback({
        type: "button_press",
        actionId: interaction.customId,
        chatId: interaction.channelId || "",
        userId: interaction.user.id,
        queryId: interaction.id,
      });
      await interaction.deferUpdate().catch(() => {});
      return true;
    }

    return false;
  }
}
