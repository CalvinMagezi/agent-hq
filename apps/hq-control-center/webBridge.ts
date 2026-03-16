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
  private doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Accumulate response text per chatId so ws-server can persist it on done
  private tokenAccumulators = new Map<string, string>();
  private onDoneCallback: (chatId: string, accumulatedText: string) => void = () => {};
  // Per-chatId SSE listeners — for the /chat-stream SSE endpoint
  private sseTokenListeners = new Map<string, (token: string) => void>();
  private sseDoneListeners = new Map<string, () => void>();
  private sseStatusListeners = new Map<string, (status: string) => void>();

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

  /** Register a callback invoked just before SSE done is signaled (for thread persistence). */
  onDone(handler: (chatId: string, accumulatedText: string) => void): void {
    this.onDoneCallback = handler;
  }

  /** Register per-chatId SSE listeners for the /chat-stream endpoint. */
  registerSseListeners(chatId: string, opts: {
    onToken: (token: string) => void;
    onDone: () => void;
    onStatus?: (status: string) => void;
  }): void {
    this.sseTokenListeners.set(chatId, opts.onToken);
    this.sseDoneListeners.set(chatId, opts.onDone);
    if (opts.onStatus) this.sseStatusListeners.set(chatId, opts.onStatus);
  }

  /** Deregister SSE listeners for a chatId. */
  removeSseListeners(chatId: string): void {
    this.sseTokenListeners.delete(chatId);
    this.sseDoneListeners.delete(chatId);
    this.sseStatusListeners.delete(chatId);
  }

  // Helper for the ws-server to push incoming web messages into the unified bot
  async handleIncoming(
    threadId: string,
    content: string,
    userId: string = "web-user",
    harnessOverride?: string,
  ): Promise<void> {
    this.onMessageCallback({
      id: `web-${Date.now()}`,
      chatId: threadId,
      userId,
      content,
      timestamp: Date.now(),
      platform: "web",
      harnessOverride,
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

    // Accumulate response for persistence
    this.tokenAccumulators.set(chatId, (this.tokenAccumulators.get(chatId) ?? "") + text);

    // Forward token to SSE listener if registered for this chatId
    this.sseTokenListeners.get(chatId)?.(text);

    // Debounce done — fires 300ms after the last token for this chatId
    const existing = this.doneTimers.get(chatId);
    if (existing) clearTimeout(existing);
    this.doneTimers.set(chatId, setTimeout(() => {
      this.doneTimers.delete(chatId);
      // Persist BEFORE signaling done so loadThread finds the file
      const accumulated = this.tokenAccumulators.get(chatId) ?? "";
      this.tokenAccumulators.delete(chatId);
      this.onDoneCallback(chatId, accumulated);
      // Signal SSE done — client triggers chat:load via SSE completion effect
      this.sseDoneListeners.get(chatId)?.();
    }, 300));

    return `web-msg-${Date.now()}`;
  }

  async sendTyping(chatId?: string): Promise<void> {
    if (chatId) {
      this.sseStatusListeners.get(chatId)?.("thinking");
    }
  }

  async sendReaction(messageId: string, reaction: string, chatId?: string): Promise<void> {
    if (chatId) {
      this.sseStatusListeners.get(chatId)?.(`reaction:${reaction}`);
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
