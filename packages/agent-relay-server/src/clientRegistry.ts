/**
 * ClientRegistry — Tracks connected WebSocket clients and their subscriptions.
 */

import type { ServerWebSocket } from "bun";

export interface ClientData {
  sessionToken: string;
  clientId: string;
  clientType: string;
  connectedAt: number;
  /** Glob patterns for event subscriptions */
  subscriptions: Set<string>;
}

export class ClientRegistry {
  private clients = new Map<ServerWebSocket<ClientData>, ClientData>();

  add(ws: ServerWebSocket<ClientData>, data: ClientData): void {
    this.clients.set(ws, data);
    ws.data = data;
  }

  remove(ws: ServerWebSocket<ClientData>): void {
    this.clients.delete(ws);
  }

  get(ws: ServerWebSocket<ClientData>): ClientData | undefined {
    return this.clients.get(ws);
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * Broadcast a message to all authenticated clients.
   */
  broadcast(msg: object): void {
    const json = JSON.stringify(msg);
    for (const ws of this.clients.keys()) {
      try {
        ws.send(json);
      } catch {
        // Client may have disconnected
      }
    }
  }

  /**
   * Broadcast to clients subscribed to the given event pattern.
   */
  broadcastEvent(eventType: string, msg: object): void {
    const json = JSON.stringify(msg);
    for (const [ws, data] of this.clients.entries()) {
      if (this.matchesSubscription(eventType, data.subscriptions)) {
        try {
          ws.send(json);
        } catch {
          // Client may have disconnected
        }
      }
    }
  }

  /**
   * Send a message to a specific client by session token.
   */
  sendTo(sessionToken: string, msg: object): boolean {
    const json = JSON.stringify(msg);
    for (const [ws, data] of this.clients.entries()) {
      if (data.sessionToken === sessionToken) {
        try {
          ws.send(json);
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Subscribe a client to event patterns.
   */
  subscribe(ws: ServerWebSocket<ClientData>, patterns: string[]): void {
    const data = this.clients.get(ws);
    if (data) {
      for (const p of patterns) data.subscriptions.add(p);
    }
  }

  /**
   * Check if an event type matches any subscription pattern.
   * Supports "*" wildcard and "prefix:*" patterns.
   */
  private matchesSubscription(eventType: string, subscriptions: Set<string>): boolean {
    for (const pattern of subscriptions) {
      if (pattern === "*") return true;
      if (pattern === eventType) return true;
      if (pattern.endsWith(":*")) {
        const prefix = pattern.slice(0, -1); // "job:"
        if (eventType.startsWith(prefix)) return true;
      }
    }
    return false;
  }
}
