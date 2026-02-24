/**
 * RelayClient — WebSocket client for the Agent Relay Server.
 *
 * Provides a typed API for connecting to and interacting with
 * the relay server from any JS/TS environment.
 */

import type {
  RelayMessage,
  RelayMessageType,
  AuthAckMessage,
  JobSubmittedMessage,
  JobStatusMessage,
  JobStreamMessage,
  JobCompleteMessage,
  SystemStatusResponseMessage,
  ChatDeltaMessage,
  ChatToolMessage,
  ChatFinalMessage,
  TraceStatusResponseMessage,
} from "./types";
import {
  RELAY_DEFAULT_PORT,
  RELAY_DEFAULT_HOST,
  RELAY_PING_INTERVAL_MS,
  RELAY_RECONNECT_INITIAL_MS,
  RELAY_RECONNECT_MAX_MS,
  RELAY_CLIENT_VERSION,
} from "./constants";

export interface RelayClientConfig {
  host?: string;
  port?: number;
  apiKey: string;
  clientId?: string;
  clientType?: "web" | "cli" | "discord" | "mobile" | "obsidian";
  autoReconnect?: boolean;
  debug?: boolean;
}

type MessageHandler = (msg: RelayMessage) => void;
type TypedHandler<T extends RelayMessage> = (msg: T) => void;

export class RelayClient {
  private config: Required<RelayClientConfig>;
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RELAY_RECONNECT_INITIAL_MS;
  private connected = false;
  private authenticated = false;
  private pendingRequests = new Map<string, (msg: RelayMessage) => void>();

  constructor(config: RelayClientConfig) {
    this.config = {
      host: config.host ?? RELAY_DEFAULT_HOST,
      port: config.port ?? RELAY_DEFAULT_PORT,
      apiKey: config.apiKey,
      clientId: config.clientId ?? `client-${Date.now()}`,
      clientType: config.clientType ?? "cli",
      autoReconnect: config.autoReconnect ?? true,
      debug: config.debug ?? false,
    };
  }

  get url(): string {
    return `ws://${this.config.host}:${this.config.port}`;
  }

  get isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  // ─── Connection ─────────────────────────────────────────────

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      const ws = new WebSocket(this.url);
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
        ws.close();
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        this.reconnectDelay = RELAY_RECONNECT_INITIAL_MS;
        this.log("Connected to relay server");

        // Send auth message
        this.send({
          type: "auth",
          apiKey: this.config.apiKey,
          clientId: this.config.clientId,
          clientType: this.config.clientType,
        });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as RelayMessage;
          this.handleMessage(msg);

          if (msg.type === "auth-ack") {
            const ack = msg as AuthAckMessage;
            if (ack.success) {
              this.authenticated = true;
              this.startPing();
              resolve();
            } else {
              reject(new Error(ack.error ?? "Authentication failed"));
              ws.close();
            }
          }
        } catch (err) {
          this.log("Failed to parse message:", err);
        }
      };

      ws.onclose = () => {
        this.connected = false;
        this.authenticated = false;
        this.stopPing();

        this.emit("disconnected", { type: "error", code: "DISCONNECTED", message: "Connection closed" });

        if (this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = (err) => {
        this.log("WebSocket error:", err);
        clearTimeout(timeout);
        if (!this.connected) {
          reject(new Error("Connection failed"));
        }
      };
    });
  }

  disconnect(): void {
    this.config.autoReconnect = false;
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
  }

  // ─── Messaging ──────────────────────────────────────────────

  send(msg: RelayMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    this.ws.send(JSON.stringify(msg));
  }

  // ─── High-level API ─────────────────────────────────────────

  async submitJob(opts: {
    instruction: string;
    jobType?: "background" | "rpc" | "interactive";
    priority?: number;
    securityProfile?: "minimal" | "standard" | "admin";
    modelOverride?: string;
    threadId?: string;
  }): Promise<JobSubmittedMessage> {
    const requestId = `req-${Date.now()}`;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, (msg) => {
        this.pendingRequests.delete(requestId);
        if (msg.type === "job:submitted") {
          resolve(msg as JobSubmittedMessage);
        } else if (msg.type === "error") {
          reject(new Error((msg as any).message));
        }
      });

      this.send({
        type: "job:submit",
        ...opts,
        requestId,
      });

      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error("submitJob timeout"));
        }
      }, 10_000);
    });
  }

  async waitForJob(jobId: string, onStream?: (delta: string) => void): Promise<JobCompleteMessage> {
    return new Promise((resolve) => {
      const unsub1 = this.on<JobStreamMessage>("job:stream", (msg) => {
        if (msg.jobId === jobId && onStream) {
          onStream(msg.delta);
        }
      });

      const unsub2 = this.on<JobCompleteMessage>("job:complete", (msg) => {
        if (msg.jobId === jobId) {
          unsub1();
          unsub2();
          resolve(msg as JobCompleteMessage);
        }
      });
    });
  }

  async chat(opts: {
    content: string;
    threadId?: string;
    modelOverride?: string;
    onDelta?: (delta: string) => void;
    onTool?: (toolName: string, input?: Record<string, unknown>) => void;
  }): Promise<ChatFinalMessage> {
    const requestId = `chat-${Date.now()}`;

    return new Promise((resolve, reject) => {
      const unsub1 = this.on<ChatDeltaMessage>("chat:delta", (msg) => {
        if (msg.requestId === requestId && opts.onDelta) {
          opts.onDelta(msg.delta);
        }
      });

      const unsub2 = this.on<ChatToolMessage>("chat:tool", (msg) => {
        if (msg.requestId === requestId && opts.onTool) {
          opts.onTool(msg.toolName, msg.toolInput);
        }
      });

      const unsub3 = this.on<ChatFinalMessage>("chat:final", (msg) => {
        if (msg.requestId === requestId) {
          unsub1();
          unsub2();
          unsub3();
          resolve(msg as ChatFinalMessage);
        }
      });

      const unsub4 = this.on("error", (msg) => {
        if ((msg as any).requestId === requestId) {
          unsub1();
          unsub2();
          unsub3();
          unsub4();
          reject(new Error((msg as any).message));
        }
      });

      this.send({
        type: "chat:send",
        content: opts.content,
        threadId: opts.threadId,
        requestId,
        modelOverride: opts.modelOverride,
      });
    });
  }

  async getStatus(): Promise<SystemStatusResponseMessage> {
    return new Promise((resolve, reject) => {
      const unsub = this.on<SystemStatusResponseMessage>("system:status-response", (msg) => {
        unsub();
        resolve(msg as SystemStatusResponseMessage);
      });

      this.send({ type: "system:status" });

      setTimeout(() => {
        unsub();
        reject(new Error("getStatus timeout"));
      }, 5_000);
    });
  }

  subscribeToEvents(events: string[]): void {
    this.send({ type: "system:subscribe", events });
  }

  cancelJob(jobId: string): void {
    this.send({ type: "job:cancel", jobId });
  }

  // ─── Trace API ──────────────────────────────────────────────

  /** Get the status of active orchestration traces. */
  async getTraceStatus(opts?: { traceId?: string; jobId?: string }): Promise<TraceStatusResponseMessage> {
    return new Promise((resolve, reject) => {
      const unsub = this.on("trace:status-response", (msg) => {
        unsub();
        resolve(msg as TraceStatusResponseMessage);
      });

      this.send({ type: "trace:status", ...opts });

      setTimeout(() => {
        unsub();
        reject(new Error("getTraceStatus timeout"));
      }, 5_000);
    });
  }

  /** Cancel one or more delegated tasks within an orchestration. */
  cancelTask(taskIds: string[], reason?: string): void {
    this.send({ type: "trace:cancel-task", taskIds, reason });
  }

  /** Subscribe to real-time trace progress events. */
  subscribeToTraces(): void {
    this.subscribeToEvents(["trace:*"]);
  }

  // ─── Event Emitter ──────────────────────────────────────────

  on<T extends RelayMessage>(
    type: T["type"],
    handler: TypedHandler<T>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    const h = handler as MessageHandler;
    this.handlers.get(type)!.add(h);
    return () => this.handlers.get(type)?.delete(h);
  }

  private emit(type: string, msg: RelayMessage): void {
    this.handlers.get(type)?.forEach((h) => h(msg));
  }

  private handleMessage(msg: RelayMessage): void {
    // Route to pending request if applicable
    const reqId = (msg as any).requestId;
    if (reqId && this.pendingRequests.has(reqId)) {
      this.pendingRequests.get(reqId)!(msg);
    }

    // Emit to type-specific handlers
    this.emit(msg.type, msg);
  }

  // ─── Internals ──────────────────────────────────────────────

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.connected) {
        try {
          this.send({ type: "ping", timestamp: Date.now() });
        } catch {
          // Connection may have dropped
        }
      }
    }, RELAY_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimeout = setTimeout(async () => {
      this.log(`Reconnecting (delay: ${this.reconnectDelay}ms)...`);
      try {
        await this.connect();
      } catch {
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          RELAY_RECONNECT_MAX_MS,
        );
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log("[relay-client]", ...args);
    }
  }
}
