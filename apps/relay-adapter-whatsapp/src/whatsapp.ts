/**
 * WhatsAppBridge — Native Baileys connection manager.
 *
 * Handles WhatsApp Web multidevice connection, QR authentication,
 * session persistence, and message send/receive — all scoped to the
 * owner's self-chat via WhatsAppGuard.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
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

export interface WhatsAppMessage {
  id: string;
  chatJid: string;
  sender: string;
  /** Text content. Empty string for voice notes (use audioBuffer for transcription). */
  content: string;
  timestamp: number;
  fromMe: boolean;
  /** True if this message is a WhatsApp voice note (PTT audio). */
  isVoiceNote?: boolean;
  /** Raw audio buffer — present for voice notes when download succeeds. */
  audioBuffer?: Buffer;
  /** MIME type of the audio, e.g. "audio/ogg; codecs=opus". */
  audioMimeType?: string;
}

export type MessageCallback = (msg: WhatsAppMessage) => void;

export interface WhatsAppBridgeConfig {
  guard: WhatsAppGuard;
  authDir?: string;
  logLevel?: string;
}

export class WhatsAppBridge {
  private sock: WASocket | null = null;
  private guard: WhatsAppGuard;
  private authDir: string;
  private logLevel: string;
  private messageCallback: MessageCallback | null = null;
  private sentMessageIds = new Set<string>();
  private logger: pino.Logger;
  private reconnecting = false;
  private connected = false;

  constructor(config: WhatsAppBridgeConfig) {
    this.guard = config.guard;
    this.authDir = config.authDir ?? path.join(process.cwd(), "auth_info");
    this.logLevel = config.logLevel ?? "warn";
    this.logger = pino({ level: this.logLevel });
  }

  /** Register a callback for incoming messages (only self-chat messages). */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
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
      generateHighQualityLinkPreview: false,
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

      const msgId = result?.key?.id;
      if (msgId) {
        this.sentMessageIds.add(msgId);
        if (this.sentMessageIds.size > 500) {
          const first = this.sentMessageIds.values().next().value;
          if (first) this.sentMessageIds.delete(first);
        }
      }

      return msgId ?? null;
    } catch (err) {
      console.error("[whatsapp] Failed to send voice note:", err);
      return null;
    }
  }

  /** Send a text message to the owner's self-chat. */
  async sendMessage(text: string): Promise<string | null> {
    if (!this.sock) {
      console.error("[whatsapp] Cannot send: socket not connected");
      return null;
    }

    // Defense-in-depth: guard check before sending
    this.guard.assertAllowed(this.guard.ownerJid);

    try {
      const result = await this.sock.sendMessage(this.guard.ownerJid, {
        text,
      });

      const msgId = result?.key?.id;
      if (msgId) {
        // Track sent message ID to prevent echo loops
        this.sentMessageIds.add(msgId);
        // Clean up old entries (keep last 500)
        if (this.sentMessageIds.size > 500) {
          const first = this.sentMessageIds.values().next().value;
          if (first) this.sentMessageIds.delete(first);
        }
      }

      return msgId ?? null;
    } catch (err) {
      console.error("[whatsapp] Failed to send message:", err);
      return null;
    }
  }

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

  /** Stop typing indicator. */
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

  // ── Private handlers ───────────────────────────────────────────

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

      // ── Voice note / audio message ─────────────────────────────
      const audioMsg = msg.message?.audioMessage;
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

        this.messageCallback({
          id: msgId ?? `unknown-${Date.now()}`,
          chatJid,
          sender,
          content: "",
          timestamp: msgTimestamp,
          fromMe: msg.key.fromMe ?? false,
          isVoiceNote: isPtt,
          audioBuffer,
          audioMimeType: mimeType,
        });
        continue;
      }

      // ── Text / caption message ──────────────────────────────────
      const content = this.extractTextContent(msg.message);
      if (!content) continue;

      console.log(
        `[whatsapp] Message received: "${content.substring(0, 80)}${content.length > 80 ? "..." : ""}" (id: ${msgId}, type: ${upsert.type})`,
      );

      this.messageCallback({
        id: msgId ?? `unknown-${Date.now()}`,
        chatJid,
        sender,
        content,
        timestamp: msgTimestamp,
        fromMe: msg.key.fromMe ?? false,
      });
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

    // Image/video/document with caption
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption)
      return message.documentMessage.caption;

    return "";
  }
}
