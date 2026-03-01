/**
 * WhatsAppBridge — Native Baileys connection manager.
 *
 * Handles WhatsApp Web multidevice connection, QR authentication,
 * session persistence, and message send/receive — all scoped to the
 * owner's self-chat via WhatsAppGuard.
 *
 * Supports all WhatsApp message types: text, images, videos, documents,
 * stickers, voice notes, locations, contacts, polls, reactions, forwards,
 * edits, and deletions.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getAggregateVotesInPollMessage,
  proto,
  type WASocket,
  type BaileysEventMap,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
// @ts-ignore — no type declarations for qrcode-terminal
import qrcode from "qrcode-terminal";
import path from "node:path";
import type { WhatsAppGuard } from "./guard.js";

// ── Message types ────────────────────────────────────────────────

export interface WhatsAppMessage {
  id: string;
  chatJid: string;
  sender: string;
  /** Text content. Empty string for media-only messages. */
  content: string;
  timestamp: number;
  fromMe: boolean;

  // Voice notes
  /** True if this message is a WhatsApp voice note (PTT audio). */
  isVoiceNote?: boolean;
  /** Raw audio buffer — present for voice notes when download succeeds. */
  audioBuffer?: Buffer;
  /** MIME type of the audio, e.g. "audio/ogg; codecs=opus". */
  audioMimeType?: string;

  // Media attachments
  /** Type of media attachment, if any. */
  mediaType?: "image" | "video" | "document" | "sticker" | "audio";
  /** Downloaded media buffer (may not be present if download failed). */
  mediaBuffer?: Buffer;
  /** MIME type of the media. */
  mediaMimeType?: string;
  /** Original filename (for documents). */
  mediaFilename?: string;
  /** Media file size in bytes. */
  mediaSize?: number;

  // Location
  /** Location data if the message contains a location pin. */
  location?: { lat: number; lng: number; name?: string; address?: string };

  // Contact
  /** vCard data if the message is a contact share. */
  contactVcard?: string;
  /** Display name of the shared contact. */
  contactName?: string;

  // Quoted/reply context
  /** Info about the message being replied to, if this is a reply. */
  quotedMessage?: { id: string; text: string; sender: string };

  // Poll
  /** Poll question/name if this is a poll creation message. */
  pollName?: string;
  /** Poll options if this is a poll creation message. */
  pollOptions?: string[];

  // Reaction
  /** Reaction data if this is a reaction message. */
  reaction?: { emoji: string; targetId: string };

  // Raw proto for forwarding/quoting
  /** Raw Baileys message — used for quoting, forwarding, editing, deleting. */
  rawMessage?: proto.IWebMessageInfo;
}

export type MessageCallback = (msg: WhatsAppMessage) => void;
export type MessageUpdateCallback = (update: {
  type: "poll_vote" | "edit" | "delete" | "status";
  messageId: string;
  data?: any;
}) => void;

export interface WhatsAppBridgeConfig {
  guard: WhatsAppGuard;
  authDir?: string;
  logLevel?: string;
  /** Enable high-quality link previews. */
  linkPreviews?: boolean;
  /** Callback for message store lookups (needed for poll vote decryption). */
  getMessageForPoll?: (key: proto.IMessageKey) => Promise<proto.IMessage | undefined>;
}

export class WhatsAppBridge {
  private sock: WASocket | null = null;
  private guard: WhatsAppGuard;
  private authDir: string;
  private logLevel: string;
  private linkPreviews: boolean;
  private messageCallback: MessageCallback | null = null;
  private updateCallback: MessageUpdateCallback | null = null;
  private sentMessageIds = new Set<string>();
  private logger: pino.Logger;
  private reconnecting = false;
  private connected = false;
  private getMessageForPoll:
    | ((key: proto.IMessageKey) => Promise<proto.IMessage | undefined>)
    | null = null;

  constructor(config: WhatsAppBridgeConfig) {
    this.guard = config.guard;
    this.authDir = config.authDir ?? path.join(process.cwd(), "auth_info");
    this.logLevel = config.logLevel ?? "warn";
    this.linkPreviews = config.linkPreviews ?? true;
    this.getMessageForPoll = config.getMessageForPoll ?? null;
    this.logger = pino({ level: this.logLevel });
  }

  /** Register a callback for incoming messages (only self-chat messages). */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /** Register a callback for message updates (poll votes, edits, status changes). */
  onMessageUpdate(callback: MessageUpdateCallback): void {
    this.updateCallback = callback;
  }

  /** Whether the WhatsApp connection is open. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Start the WhatsApp connection. Displays QR on first run. */
  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[whatsapp] Connecting with Baileys v${version.join(".")}...`);
    console.log(
      `[whatsapp] SECURITY: Adapter locked to self-chat: ${this.guard.ownerJid}`,
    );

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger,
      printQRInTerminal: false, // We handle QR ourselves
      generateHighQualityLinkPreview: this.linkPreviews,
      // First line of defense: tell Baileys to ignore all JIDs except owner
      shouldIgnoreJid: (jid: string) => !this.guard.isAllowedChat(jid),
    });

    // ── Auth credential persistence ────────────────────────────────
    this.sock.ev.on("creds.update", saveCreds);

    // ── Connection state management ────────────────────────────────
    this.sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update);
    });

    // ── Message handler ────────────────────────────────────────────
    this.sock.ev.on(
      "messages.upsert",
      (upsert: BaileysEventMap["messages.upsert"]) => {
        this.handleMessagesUpsert(upsert);
      },
    );

    // ── Message updates (poll votes, edits, delivery status) ──────
    this.sock.ev.on(
      "messages.update",
      (updates: BaileysEventMap["messages.update"]) => {
        this.handleMessagesUpdate(updates);
      },
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // SEND METHODS
  // ══════════════════════════════════════════════════════════════════

  /** Send a text message to the owner's self-chat. */
  async sendMessage(
    text: string,
    options?: { quoted?: proto.IWebMessageInfo },
  ): Promise<string | null> {
    if (!this.sock) {
      console.error("[whatsapp] Cannot send: socket not connected");
      return null;
    }
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(
        this.guard.ownerJid,
        { text },
        options ? { quoted: options.quoted } : undefined,
      );
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send message:", err);
      return null;
    }
  }

  /** Send a voice note (PTT audio) to the owner's self-chat. */
  async sendVoiceNote(buffer: Buffer): Promise<string | null> {
    if (!this.sock) {
      console.error("[whatsapp] Cannot send voice note: socket not connected");
      return null;
    }
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        audio: buffer,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      });
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send voice note:", err);
      return null;
    }
  }

  /** Send an image with optional caption. */
  async sendImage(
    buffer: Buffer,
    caption?: string,
    options?: { quoted?: proto.IWebMessageInfo; viewOnce?: boolean },
  ): Promise<string | null> {
    if (!this.sock) return null;
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(
        this.guard.ownerJid,
        {
          image: buffer,
          caption,
          viewOnce: options?.viewOnce,
        },
        options?.quoted ? { quoted: options.quoted } : undefined,
      );
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send image:", err);
      return null;
    }
  }

  /** Send a video with optional caption. */
  async sendVideo(
    buffer: Buffer,
    caption?: string,
    options?: { gifPlayback?: boolean },
  ): Promise<string | null> {
    if (!this.sock) return null;
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        video: buffer,
        caption,
        gifPlayback: options?.gifPlayback,
      });
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send video:", err);
      return null;
    }
  }

  /** Send a document/file. */
  async sendDocument(
    buffer: Buffer,
    filename: string,
    mimetype: string,
    caption?: string,
  ): Promise<string | null> {
    if (!this.sock) return null;
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        document: buffer,
        fileName: filename,
        mimetype,
        caption,
      });
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send document:", err);
      return null;
    }
  }

  /** Send a sticker (WebP format). */
  async sendSticker(buffer: Buffer): Promise<string | null> {
    if (!this.sock) return null;
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        sticker: buffer,
      });
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send sticker:", err);
      return null;
    }
  }

  /** Send a location pin. */
  async sendLocation(
    lat: number,
    lng: number,
    name?: string,
    address?: string,
  ): Promise<string | null> {
    if (!this.sock) return null;
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        location: {
          degreesLatitude: lat,
          degreesLongitude: lng,
          name,
          address,
        },
      });
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send location:", err);
      return null;
    }
  }

  /** Send a contact card (vCard). */
  async sendContact(vcard: string, displayName: string): Promise<string | null> {
    if (!this.sock) return null;
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        contacts: {
          displayName,
          contacts: [{ vcard }],
        },
      });
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send contact:", err);
      return null;
    }
  }

  /** Create a poll. */
  async sendPoll(
    name: string,
    options: string[],
    selectableCount = 1,
  ): Promise<string | null> {
    if (!this.sock) return null;
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        poll: {
          name,
          values: options,
          selectableCount,
        },
      });
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to send poll:", err);
      return null;
    }
  }

  /** React to a message with an emoji. */
  async sendReaction(targetMsgKey: proto.IMessageKey, emoji: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendMessage(this.guard.ownerJid, {
        react: { text: emoji, key: targetMsgKey },
      });
    } catch (err) {
      console.error("[whatsapp] Failed to send reaction:", err);
    }
  }

  /** Remove a reaction from a message. */
  async removeReaction(targetMsgKey: proto.IMessageKey): Promise<void> {
    await this.sendReaction(targetMsgKey, "");
  }

  /** Edit a previously sent message. */
  async editMessage(
    originalKey: proto.IMessageKey,
    newText: string,
  ): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendMessage(this.guard.ownerJid, {
        text: newText,
        edit: originalKey,
      });
    } catch (err) {
      console.error("[whatsapp] Failed to edit message:", err);
    }
  }

  /** Delete a message (for everyone). */
  async deleteMessage(originalKey: proto.IMessageKey): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendMessage(this.guard.ownerJid, {
        delete: originalKey,
      });
    } catch (err) {
      console.error("[whatsapp] Failed to delete message:", err);
    }
  }

  /** Forward a message. */
  async forwardMessage(msg: proto.IWebMessageInfo): Promise<string | null> {
    if (!this.sock) return null;
    this.guard.assertAllowed(this.guard.ownerJid);
    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        forward: msg,
      });
      return this.trackSentMessage(result);
    } catch (err) {
      console.error("[whatsapp] Failed to forward message:", err);
      return null;
    }
  }

  // ── Presence indicators ──────────────────────────────────────────

  /** Send a read receipt for a message (mark as read). */
  async markRead(msg: WhatsAppMessage): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.readMessages([
        {
          remoteJid: msg.chatJid,
          id: msg.id,
          participant: undefined,
        },
      ]);
    } catch {
      // Non-critical — ignore read receipt failures
    }
  }

  /** Send typing indicator (composing). */
  async sendTyping(): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("composing", this.guard.ownerJid);
    } catch {
      // Non-critical
    }
  }

  /** Send recording indicator (recording audio). */
  async sendRecording(): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("recording", this.guard.ownerJid);
    } catch {
      // Non-critical
    }
  }

  /** Stop typing/recording indicator. */
  async stopTyping(): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("paused", this.guard.ownerJid);
    } catch {
      // Non-critical
    }
  }

  /** Gracefully disconnect. */
  async stop(): Promise<void> {
    this.connected = false;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    console.log("[whatsapp] Disconnected");
  }

  // ══════════════════════════════════════════════════════════════════
  // PRIVATE HANDLERS
  // ══════════════════════════════════════════════════════════════════

  private trackSentMessage(
    result: proto.WebMessageInfo | undefined,
  ): string | null {
    const msgId = result?.key?.id;
    if (msgId) {
      this.sentMessageIds.add(msgId);
      if (this.sentMessageIds.size > 500) {
        const first = this.sentMessageIds.values().next().value;
        if (first) this.sentMessageIds.delete(first);
      }
    }
    return msgId ?? null;
  }

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n[whatsapp] Scan this QR code with WhatsApp:");
      console.log("[whatsapp] Open WhatsApp → Settings → Linked Devices → Link a Device\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      this.connected = false;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect && !this.reconnecting) {
        console.log(
          `[whatsapp] Connection closed (code: ${statusCode}). Reconnecting in 3s...`,
        );
        this.reconnecting = true;
        setTimeout(() => {
          this.reconnecting = false;
          this.start().catch((err) => {
            console.error("[whatsapp] Reconnection failed:", err);
          });
        }, 3000);
      } else if (!shouldReconnect) {
        console.error(
          "[whatsapp] Logged out. Please delete auth_info/ and restart to re-authenticate.",
        );
        process.exit(1);
      }
    }

    if (connection === "open") {
      this.connected = true;
      console.log("[whatsapp] Connected to WhatsApp — ready to receive messages");
    }
  }

  private async handleMessagesUpsert(
    upsert: BaileysEventMap["messages.upsert"],
  ): Promise<void> {
    if (!this.messageCallback) return;

    // Accept both "notify" (real-time) and "append" (sync) message types
    if (upsert.type !== "notify" && upsert.type !== "append") {
      console.log(`[whatsapp] Ignoring upsert type: ${upsert.type}`);
      return;
    }

    for (const msg of upsert.messages) {
      const chatJid = msg.key.remoteJid;
      if (!chatJid) continue;

      // Security: only process messages from the owner's self-chat
      if (!this.guard.isAllowedChat(chatJid)) continue;

      // Echo prevention: skip messages we sent via the bot
      const msgId = msg.key.id;
      if (msgId && this.sentMessageIds.has(msgId)) {
        console.log(`[whatsapp] Skipping echo (sent by bot): ${msgId}`);
        continue;
      }

      const msgTimestamp =
        typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp * 1000
          : Date.now();

      const sender = msg.key.participant ?? chatJid.split("@")[0];
      const message = msg.message;
      if (!message) continue;

      // Build the WhatsAppMessage with all available data
      const waMsg: WhatsAppMessage = {
        id: msgId ?? `unknown-${Date.now()}`,
        chatJid,
        sender,
        content: "",
        timestamp: msgTimestamp,
        fromMe: msg.key.fromMe ?? false,
        rawMessage: msg,
      };

      // ── Extract quoted message context ────────────────────────
      const contextInfo =
        message.extendedTextMessage?.contextInfo ??
        message.imageMessage?.contextInfo ??
        message.videoMessage?.contextInfo ??
        message.documentMessage?.contextInfo ??
        message.audioMessage?.contextInfo;

      if (contextInfo?.quotedMessage) {
        const quotedText =
          contextInfo.quotedMessage.conversation ??
          contextInfo.quotedMessage.extendedTextMessage?.text ??
          contextInfo.quotedMessage.imageMessage?.caption ??
          "";
        waMsg.quotedMessage = {
          id: contextInfo.stanzaId ?? "",
          text: quotedText,
          sender: contextInfo.participant ?? sender,
        };
      }

      // ── Reaction message ──────────────────────────────────────
      if (message.reactionMessage) {
        const reaction = message.reactionMessage;
        waMsg.reaction = {
          emoji: reaction.text ?? "",
          targetId: reaction.key?.id ?? "",
        };
        console.log(
          `[whatsapp] Reaction: ${waMsg.reaction.emoji} on ${waMsg.reaction.targetId}`,
        );
        this.messageCallback(waMsg);
        continue;
      }

      // ── Voice note / audio message ────────────────────────────
      const audioMsg = message.audioMessage;
      if (audioMsg) {
        const isPtt = audioMsg.ptt ?? false;
        const mimeType = audioMsg.mimetype ?? "audio/ogg; codecs=opus";

        console.log(
          `[whatsapp] Audio message received (ptt=${isPtt}, mime=${mimeType}, id=${msgId})`,
        );

        let audioBuffer: Buffer | undefined;
        try {
          const downloaded = await downloadMediaMessage(msg, "buffer", {});
          audioBuffer = downloaded as Buffer;
          console.log(
            `[whatsapp] Voice note downloaded: ${audioBuffer.length} bytes`,
          );
        } catch (err) {
          console.error("[whatsapp] Failed to download audio message:", err);
        }

        waMsg.isVoiceNote = isPtt;
        waMsg.audioBuffer = audioBuffer;
        waMsg.audioMimeType = mimeType;
        waMsg.mediaType = "audio";
        waMsg.mediaBuffer = audioBuffer;
        waMsg.mediaMimeType = mimeType;
        waMsg.mediaSize = audioBuffer?.length;
        this.messageCallback(waMsg);
        continue;
      }

      // ── Image message ─────────────────────────────────────────
      if (message.imageMessage) {
        const img = message.imageMessage;
        waMsg.content = img.caption ?? "";
        waMsg.mediaType = "image";
        waMsg.mediaMimeType = img.mimetype ?? "image/jpeg";
        waMsg.mediaSize = img.fileLength
          ? typeof img.fileLength === "number"
            ? img.fileLength
            : Number(img.fileLength)
          : undefined;

        try {
          const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          waMsg.mediaBuffer = buffer;
          console.log(
            `[whatsapp] Image downloaded: ${buffer.length} bytes, caption="${(waMsg.content ?? "").substring(0, 40)}"`,
          );
        } catch (err) {
          console.error("[whatsapp] Failed to download image:", err);
        }

        this.messageCallback(waMsg);
        continue;
      }

      // ── Video message ─────────────────────────────────────────
      if (message.videoMessage) {
        const vid = message.videoMessage;
        waMsg.content = vid.caption ?? "";
        waMsg.mediaType = "video";
        waMsg.mediaMimeType = vid.mimetype ?? "video/mp4";
        waMsg.mediaSize = vid.fileLength
          ? typeof vid.fileLength === "number"
            ? vid.fileLength
            : Number(vid.fileLength)
          : undefined;

        try {
          const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          waMsg.mediaBuffer = buffer;
          console.log(
            `[whatsapp] Video downloaded: ${buffer.length} bytes`,
          );
        } catch (err) {
          console.error("[whatsapp] Failed to download video:", err);
        }

        this.messageCallback(waMsg);
        continue;
      }

      // ── Document message ──────────────────────────────────────
      if (message.documentMessage) {
        const doc = message.documentMessage;
        waMsg.content = doc.caption ?? "";
        waMsg.mediaType = "document";
        waMsg.mediaMimeType = doc.mimetype ?? "application/octet-stream";
        waMsg.mediaFilename = doc.fileName ?? undefined;
        waMsg.mediaSize = doc.fileLength
          ? typeof doc.fileLength === "number"
            ? doc.fileLength
            : Number(doc.fileLength)
          : undefined;

        try {
          const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          waMsg.mediaBuffer = buffer;
          console.log(
            `[whatsapp] Document downloaded: ${doc.fileName} (${buffer.length} bytes)`,
          );
        } catch (err) {
          console.error("[whatsapp] Failed to download document:", err);
        }

        this.messageCallback(waMsg);
        continue;
      }

      // ── Sticker message ───────────────────────────────────────
      if (message.stickerMessage) {
        waMsg.mediaType = "sticker";
        waMsg.mediaMimeType = message.stickerMessage.mimetype ?? "image/webp";

        try {
          const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          waMsg.mediaBuffer = buffer;
          console.log(`[whatsapp] Sticker downloaded: ${buffer.length} bytes`);
        } catch (err) {
          console.error("[whatsapp] Failed to download sticker:", err);
        }

        this.messageCallback(waMsg);
        continue;
      }

      // ── Location message ──────────────────────────────────────
      if (message.locationMessage) {
        const loc = message.locationMessage;
        waMsg.location = {
          lat: loc.degreesLatitude ?? 0,
          lng: loc.degreesLongitude ?? 0,
          name: loc.name ?? undefined,
          address: loc.address ?? undefined,
        };
        waMsg.content = `[Location: ${waMsg.location.lat}, ${waMsg.location.lng}]`;
        console.log(
          `[whatsapp] Location received: ${waMsg.location.lat}, ${waMsg.location.lng}`,
        );
        this.messageCallback(waMsg);
        continue;
      }

      // ── Contact message ───────────────────────────────────────
      if (message.contactMessage) {
        waMsg.contactVcard = message.contactMessage.vcard ?? undefined;
        waMsg.contactName = message.contactMessage.displayName ?? undefined;
        waMsg.content = `[Contact: ${waMsg.contactName ?? "Unknown"}]`;
        console.log(`[whatsapp] Contact received: ${waMsg.contactName}`);
        this.messageCallback(waMsg);
        continue;
      }
      if (message.contactsArrayMessage) {
        const contacts = message.contactsArrayMessage.contacts ?? [];
        const names = contacts.map((c) => c.displayName ?? "Unknown").join(", ");
        waMsg.contactName = names;
        waMsg.contactVcard = contacts[0]?.vcard ?? undefined;
        waMsg.content = `[Contacts: ${names}]`;
        console.log(`[whatsapp] Contacts received: ${names}`);
        this.messageCallback(waMsg);
        continue;
      }

      // ── Poll creation message ─────────────────────────────────
      if (message.pollCreationMessage || message.pollCreationMessageV3) {
        const poll = message.pollCreationMessage ?? message.pollCreationMessageV3;
        waMsg.pollName = poll?.name ?? undefined;
        waMsg.pollOptions = poll?.options?.map((o) => o.optionName ?? "") ?? [];
        waMsg.content = `[Poll: ${waMsg.pollName}] Options: ${waMsg.pollOptions.join(", ")}`;
        console.log(`[whatsapp] Poll received: ${waMsg.pollName}`);
        this.messageCallback(waMsg);
        continue;
      }

      // ── Text / caption message (fallback) ─────────────────────
      const content = this.extractTextContent(message);
      if (!content) continue;

      waMsg.content = content;

      console.log(
        `[whatsapp] Message received: "${content.substring(0, 80)}${content.length > 80 ? "..." : ""}" (id: ${msgId}, type: ${upsert.type})`,
      );

      this.messageCallback(waMsg);
    }
  }

  private async handleMessagesUpdate(
    updates: BaileysEventMap["messages.update"],
  ): Promise<void> {
    if (!this.updateCallback) return;

    for (const { key, update } of updates) {
      if (!key.remoteJid || !this.guard.isAllowedChat(key.remoteJid)) continue;
      const messageId = key.id ?? "";

      // Poll vote update
      if (update.pollUpdates && this.getMessageForPoll) {
        try {
          const pollCreation = await this.getMessageForPoll(key);
          if (pollCreation) {
            const votes = getAggregateVotesInPollMessage({
              message: pollCreation,
              pollUpdates: update.pollUpdates,
            });
            this.updateCallback({
              type: "poll_vote",
              messageId,
              data: { votes },
            });
          }
        } catch (err) {
          console.error("[whatsapp] Failed to process poll vote:", err);
        }
      }

      // Message status update (sent/delivered/read)
      if (update.status) {
        this.updateCallback({
          type: "status",
          messageId,
          data: { status: update.status },
        });
      }
    }
  }

  private extractTextContent(
    message: proto.IMessage | null | undefined,
  ): string {
    if (!message) return "";

    // Plain text
    if (message.conversation) return message.conversation;

    // Extended text (replies, links, etc.)
    if (message.extendedTextMessage?.text) {
      return message.extendedTextMessage.text;
    }

    // Image/video/document with caption (handled above, but fallback)
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;

    return "";
  }
}
