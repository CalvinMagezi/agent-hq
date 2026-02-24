/**
 * AgentBridge — WebSocket client connecting to the local HQ agent's WS server.
 *
 * The agent runs its own WebSocket server (apps/agent/lib/wsServer.ts) on port 5678.
 * This bridge connects to it and proxies real-time streaming events (chat.delta,
 * chat.tool, chat.final) to relay clients via the ClientRegistry.
 *
 * Protocol: JSON-RPC frames { type: "req"|"res"|"event", id, method, payload }
 * Port: 5678 (default, configurable via AGENT_WS_PORT)
 */

import type { ClientRegistry } from "../clientRegistry";

const AGENT_WS_PORT = parseInt(process.env.AGENT_WS_PORT ?? "5678", 10);
const AGENT_WS_HOST = process.env.AGENT_WS_HOST ?? "127.0.0.1";

interface AgentWsEvent {
  type: "event";
  event: string;
  payload: unknown;
}

interface AgentWsResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export class AgentBridge {
  private ws: WebSocket | null = null;
  private registry: ClientRegistry;
  private debug: boolean;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** session token → requestId mapping for routing responses */
  private pendingStreams = new Map<string, string>();

  constructor(registry: ClientRegistry, debug = false) {
    this.registry = registry;
    this.debug = debug;
  }

  /**
   * Connect to the agent's WebSocket server.
   * Silently fails if agent is not running — relay works without it.
   */
  async connect(): Promise<void> {
    try {
      await this.tryConnect();
    } catch {
      // Agent may not be running — that's OK
      if (this.debug) {
        console.log(`[agent-bridge] Agent WS not available on port ${AGENT_WS_PORT}, will retry`);
      }
      this.scheduleReconnect();
    }
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${AGENT_WS_HOST}:${AGENT_WS_PORT}`;
      const ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
        ws.close();
      }, 3_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.connected = true;
        if (this.debug) {
          console.log(`[agent-bridge] Connected to agent WS on port ${AGENT_WS_PORT}`);
        }
        resolve();
      };

      ws.onmessage = (event) => {
        this.handleAgentMessage(event.data as string);
      };

      ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        if (this.debug) {
          console.log("[agent-bridge] Disconnected from agent WS, will reconnect");
        }
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket error"));
      };
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a chat message to the agent and route streaming responses
   * back to a specific relay client.
   */
  sendChatMessage(
    text: string,
    sessionToken: string,
    requestId?: string,
    threadId?: string,
  ): boolean {
    if (!this.ws || !this.connected) return false;

    const id = `relay-${Date.now()}`;
    this.pendingStreams.set(id, sessionToken);

    // Store the requestId so we can pass it in forwarded events
    if (requestId) {
      this.pendingStreams.set(`reqId-${id}`, requestId);
    }
    if (threadId) {
      this.pendingStreams.set(`threadId-${id}`, threadId);
    }

    this.ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "chat.send",
        params: { text },
      }),
    );
    return true;
  }

  /**
   * Abort the current agent chat session.
   */
  abort(): void {
    if (!this.ws || !this.connected) return;
    this.ws.send(
      JSON.stringify({
        type: "req",
        id: `abort-${Date.now()}`,
        method: "chat.abort",
      }),
    );
  }

  private handleAgentMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as AgentWsEvent | AgentWsResponse;

      if (msg.type !== "event") return;
      const ev = msg as AgentWsEvent;

      // Route streaming events to relay clients
      switch (ev.event) {
        case "chat.delta": {
          const payload = ev.payload as { text: string };
          // Broadcast to all subscribed clients with active stream
          for (const [id, sessionToken] of this.pendingStreams) {
            if (id.startsWith("reqId-") || id.startsWith("threadId-")) continue;
            const requestId = this.pendingStreams.get(`reqId-${id}`);
            const threadId = this.pendingStreams.get(`threadId-${id}`);
            this.registry.sendTo(sessionToken, {
              type: "chat:delta",
              requestId,
              threadId,
              delta: payload.text,
              index: 0,
            });
          }
          break;
        }

        case "chat.tool": {
          const payload = ev.payload as { name: string; status: string };
          for (const [id, sessionToken] of this.pendingStreams) {
            if (id.startsWith("reqId-") || id.startsWith("threadId-")) continue;
            const requestId = this.pendingStreams.get(`reqId-${id}`);
            this.registry.sendTo(sessionToken, {
              type: "chat:tool",
              requestId,
              toolName: payload.name,
            });
          }
          break;
        }

        case "chat.final": {
          const payload = ev.payload as { text: string };
          const entries = [...this.pendingStreams.entries()].filter(
            ([id]) => !id.startsWith("reqId-") && !id.startsWith("threadId-"),
          );

          for (const [id, sessionToken] of entries) {
            const requestId = this.pendingStreams.get(`reqId-${id}`);
            const threadId = this.pendingStreams.get(`threadId-${id}`);
            this.registry.sendTo(sessionToken, {
              type: "chat:final",
              requestId,
              threadId,
              content: payload.text,
            });
            // Clean up
            this.pendingStreams.delete(id);
            if (requestId) this.pendingStreams.delete(`reqId-${id}`);
            if (threadId) this.pendingStreams.delete(`threadId-${id}`);
          }
          break;
        }

        case "chat.error": {
          const payload = ev.payload as { message: string };
          const entries = [...this.pendingStreams.entries()].filter(
            ([id]) => !id.startsWith("reqId-") && !id.startsWith("threadId-"),
          );
          for (const [id, sessionToken] of entries) {
            const requestId = this.pendingStreams.get(`reqId-${id}`);
            this.registry.sendTo(sessionToken, {
              type: "error",
              code: "AGENT_CHAT_ERROR",
              message: payload.message,
              requestId,
            });
            this.pendingStreams.delete(id);
            this.pendingStreams.delete(`reqId-${id}`);
            this.pendingStreams.delete(`threadId-${id}`);
          }
          break;
        }

        case "trace.progress": {
          // Broadcast orchestration trace progress to all subscribed relay clients
          const payload = ev.payload as {
            traceId: string;
            jobId: string;
            completedTasks: number;
            totalTasks: number;
            failedTasks: number;
            summary: string;
            latestEvent?: { spanId: string; taskId: string | null; eventType: string; message: string | null };
            timestamp: string;
          };
          this.registry.broadcastEvent("trace:progress", {
            type: "trace:progress",
            traceId: payload.traceId,
            jobId: payload.jobId,
            completedTasks: payload.completedTasks,
            totalTasks: payload.totalTasks,
            failedTasks: payload.failedTasks,
            summary: payload.summary,
            latestEvent: payload.latestEvent ?? undefined,
            timestamp: payload.timestamp,
          });
          break;
        }
      }
    } catch (err) {
      if (this.debug) {
        console.log("[agent-bridge] Failed to parse agent message:", err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.tryConnect();
      } catch {
        this.scheduleReconnect();
      }
    }, 5_000);
  }
}
