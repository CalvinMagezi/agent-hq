/**
 * GoogleChatBridge — PlatformBridge implementation for Google Chat.
 *
 * Runs a local Bun HTTP server that receives push events from
 * the Google Chat App. Replies via the Chat REST API using
 * service account credentials.
 *
 * Architecture:
 *   Google Chat → HTTP POST → this server → UnifiedAdapterBot → relay
 *   relay response → Chat REST API → Google Chat
 */

import type {
  PlatformBridge,
  PlatformCapabilities,
  PlatformAction,
  SendOpts,
  UnifiedMessage,
} from "@repo/relay-adapter-core";
import type { GoogleChatGuard } from "./guard.js";
import type { ChatEvent } from "./gwsClient.js";
import * as gws from "./gwsClient.js";
import { formatForGoogleChat, chunkText } from "./formatter.js";
// ─── Config ──────────────────────────────────────────────────────

export interface GoogleChatBridgeConfig {
  guard: GoogleChatGuard;
  port: number;
  verificationToken?: string;
  debug?: boolean;
}

// ─── Bridge ──────────────────────────────────────────────────────

/** Max messages to keep in the dedup set. */
const MAX_SEEN_SIZE = 200;

export class GoogleChatBridge implements PlatformBridge {
  readonly platformId = "google-chat" as const;

  readonly capabilities: PlatformCapabilities = {
    maxMessageLength: 4096,
    supportsInlineKeyboards: false,
    supportsReactions: false,
    supportsStreaming: false,
    supportsVoice: false,
    supportsMedia: false,
    formatType: "plain",
  };

  private guard: GoogleChatGuard;
  private port: number;
  private verificationToken?: string;
  private debug: boolean;

  private messageCallback: ((msg: UnifiedMessage) => void) | null = null;
  private actionCallback: ((action: PlatformAction) => void) | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private seenMessageNames = new Set<string>();

  constructor(config: GoogleChatBridgeConfig) {
    this.guard = config.guard;
    this.port = config.port;
    this.verificationToken = config.verificationToken;
    this.debug = config.debug ?? false;
  }

  // ─── PlatformBridge: receive ──────────────────────────────────

  onMessage(handler: (msg: UnifiedMessage) => void): void {
    this.messageCallback = handler;
  }

  onAction(handler: (action: PlatformAction) => void): void {
    this.actionCallback = handler;
  }

  // ─── PlatformBridge: send ─────────────────────────────────────

  async sendText(text: string, opts?: SendOpts): Promise<string | null> {
    const spaceName = opts?.chatId;
    if (!spaceName) {
      if (this.debug) console.error("[googlechat] sendText: no chatId (spaceName)");
      return null;
    }

    try {
      const formatted = formatForGoogleChat(text);
      const chunks = chunkText(formatted);
      let firstMsgName: string | null = null;

      for (const chunk of chunks) {
        const msg = await gws.createMessage(spaceName, chunk);
        if (!firstMsgName) firstMsgName = msg.name;
        this.markSeen(msg.name);
      }

      return firstMsgName;
    } catch (err) {
      console.error("[googlechat] sendText failed:", err);
      return null;
    }
  }

  async sendTyping(_chatId?: string): Promise<void> {
    // Google Chat API does not support typing indicators for Chat Apps.
  }

  async sendReaction(_msgId: string, _emoji: string, _chatId?: string): Promise<void> {
    // Not supported for Chat App bots in MVP.
  }

  async sendFile(_buffer: Buffer, _filename: string, _caption?: string, _chatId?: string): Promise<void> {
    if (this.debug) {
      console.log("[googlechat] sendFile not supported — skipping");
    }
  }

  /**
   * Update an existing message (for progressive response updates).
   */
  async updateMessage(messageName: string, text: string): Promise<void> {
    try {
      const formatted = formatForGoogleChat(text);
      await gws.updateMessage(messageName, formatted);
    } catch (err) {
      if (this.debug) {
        console.error("[googlechat] updateMessage failed:", err);
      }
    }
  }

  // ─── PlatformBridge: lifecycle ────────────────────────────────

  async start(): Promise<void> {
    const self = this;

    this.server = Bun.serve({
      port: this.port,
      async fetch(req) {
        // Health check
        if (req.method === "GET") {
          return new Response(JSON.stringify({ status: "ok", platform: "google-chat" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Google Chat sends POST with JSON body
        if (req.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }

        try {
          const event = (await req.json()) as ChatEvent;

          // Optional verification token check
          if (self.verificationToken) {
            const token = req.headers.get("Authorization")?.replace("Bearer ", "");
            if (token !== self.verificationToken) {
              if (self.debug) console.log("[googlechat] Rejected: bad verification token");
              return new Response("Unauthorized", { status: 401 });
            }
          }

          self.handleEvent(event);

          // Google Chat expects a 200 response (can include a synchronous reply)
          return new Response(JSON.stringify({}), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          console.error("[googlechat] Error processing event:", err);
          return new Response("Internal error", { status: 500 });
        }
      },
    });

    console.log(`[googlechat] HTTP server listening on port ${this.port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    console.log("[googlechat] Stopped.");
  }

  // ─── Internal ─────────────────────────────────────────────────

  /** Handle an incoming Google Chat event. */
  private handleEvent(event: ChatEvent): void {
    if (this.debug) {
      console.log(`[googlechat] Event type: ${event.type}`);
    }

    switch (event.type) {
      case "MESSAGE":
        this.handleMessage(event);
        break;

      case "ADDED_TO_SPACE":
        console.log(`[googlechat] Bot added to space: ${event.space?.name}`);
        break;

      case "REMOVED_FROM_SPACE":
        console.log(`[googlechat] Bot removed from space: ${event.space?.name}`);
        break;

      default:
        if (this.debug) {
          console.log(`[googlechat] Unhandled event type: ${event.type}`);
        }
    }
  }

  /** Process an incoming MESSAGE event. */
  private handleMessage(event: ChatEvent): void {
    const msg = event.message;
    if (!msg?.text?.trim()) return;

    const msgName = msg.name;
    if (!msgName) return;

    // Dedup
    if (this.seenMessageNames.has(msgName)) return;
    this.markSeen(msgName);

    // Auth check — only process messages from the owner
    const senderId = event.user?.name ?? msg.sender?.name ?? "";
    if (!this.guard.isAllowedUser(senderId)) {
      if (this.debug) {
        console.log(`[googlechat] Blocked message from: ${senderId}`);
      }
      return;
    }

    let content = msg.text.trim();

    // Strip bot @mention from the beginning (Google Chat includes it)
    // Format: "@BotName command text" → "command text"
    content = content.replace(/^@\S+\s*/, "");

    // Convert /commands to !commands
    if (content.startsWith("/")) {
      content = "!" + content.slice(1);
    }

    const spaceName = msg.space?.name ?? event.space?.name ?? "";

    const unified: UnifiedMessage = {
      id: msgName,
      chatId: spaceName,
      userId: senderId,
      content,
      timestamp: new Date(msg.createTime).getTime(),
      platform: "google-chat",
    };

    if (this.debug) {
      console.log(`[googlechat] Message from ${senderId}: "${content.slice(0, 80)}"`);
    }

    this.messageCallback?.(unified);
  }

  /** Mark a message as seen (for dedup). */
  private markSeen(messageName: string): void {
    this.seenMessageNames.add(messageName);

    if (this.seenMessageNames.size > MAX_SEEN_SIZE) {
      const iter = this.seenMessageNames.values();
      const oldest = iter.next().value;
      if (oldest) this.seenMessageNames.delete(oldest);
    }
  }
}
