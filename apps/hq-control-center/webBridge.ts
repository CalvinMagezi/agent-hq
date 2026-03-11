import type { ServerWebSocket } from "bun";
import {
  type PlatformBridge,
  type UnifiedMessage,
  type SendOpts,
  type PlatformCapabilities,
  type PlatformId,
  type PlatformAction,
} from "@repo/relay-adapter-core";

export class WebBridge implements PlatformBridge {
  public platformId: PlatformId = "web";
  public capabilities: PlatformCapabilities = {
    maxMessageLength: 20000,
    supportsInlineKeyboards: true,
    supportsReactions: true,
    supportsStreaming: true,
    supportsVoice: false,
    supportsMedia: true,
    formatType: "markdown",
  };

  private clients: Set<ServerWebSocket<unknown>>;
  private onMessageCallback: (msg: UnifiedMessage) => void = () => {};
  private onActionCallback: (action: PlatformAction) => void = () => {};

  constructor(clients: Set<ServerWebSocket<unknown>>) {
    this.clients = clients;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onMessage(handler: (msg: UnifiedMessage) => void): void {
    this.onMessageCallback = handler;
  }

  onAction(handler: (action: PlatformAction) => void): void {
    this.onActionCallback = handler;
  }

  // Helper for the ws-server to push incoming web messages into the unified bot
  async handleIncoming(threadId: string, content: string, userId: string = "web-user"): Promise<void> {
    this.onMessageCallback({
      id: `web-${Date.now()}`,
      chatId: threadId,
      userId,
      content,
      timestamp: Date.now(),
      platform: "web",
    });
  }

  private broadcast(threadId: string, msg: any) {
    const payload = JSON.stringify({ ...msg, threadId });
    for (const client of this.clients) {
      try {
        client.send(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  async sendText(text: string, opts?: SendOpts): Promise<string | null> {
    const chatId = opts?.chatId;
    if (!chatId) return null;

    this.broadcast(chatId, {
      type: "chat:token",
      token: text,
      replyToId: opts?.replyToId,
    });
    
    return `web-msg-${Date.now()}`;
  }

  async sendTyping(chatId?: string): Promise<void> {
    if (chatId) {
      this.broadcast(chatId, {
        type: "chat:status",
        status: "thinking",
      });
    }
  }

  async sendReaction(messageId: string, reaction: string, chatId?: string): Promise<void> {
    if (chatId) {
      this.broadcast(chatId, {
        type: "chat:status",
        status: `reaction:${reaction}`,
        messageId
      });
    }
  }

  async sendFile(buffer: Buffer, filename: string, caption?: string, chatId?: string): Promise<void> {
    if (chatId) {
      this.broadcast(chatId, {
        type: "chat:token",
        token: `\n\n[File attached: ${filename}${caption ? ` - ${caption}` : ""}]\n`,
      });
    }
  }
}
