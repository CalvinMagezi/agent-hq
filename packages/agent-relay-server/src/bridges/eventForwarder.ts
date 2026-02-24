/**
 * EventForwarder — Bridges VaultSync EventBus events to relay WebSocket clients.
 *
 * Subscribes to all vault events and forwards them to subscribed relay clients
 * as system:event messages.
 */

import type { ClientRegistry } from "../clientRegistry";
import type { VaultBridge } from "./vaultBridge";
import type { SystemEventMessage } from "@repo/agent-relay-protocol";

// VaultSync event types to forward
const VAULT_EVENTS = [
  "job:created",
  "job:claimed",
  "job:completed",
  "job:failed",
  "task:created",
  "task:claimed",
  "task:completed",
  "task:cancelled",
  "note:created",
  "note:modified",
  "note:deleted",
  "system:modified",
  "change:detected",
];

export class EventForwarder {
  private registry: ClientRegistry;
  private bridge: VaultBridge;
  private cleanups: Array<() => void> = [];
  private debug: boolean;

  constructor(registry: ClientRegistry, bridge: VaultBridge, debug = false) {
    this.registry = registry;
    this.bridge = bridge;
    this.debug = debug;
  }

  /**
   * Start forwarding vault events to subscribed relay clients.
   */
  start(): void {
    for (const event of VAULT_EVENTS) {
      const unsub = this.bridge.on(event, (data?: any) => {
        this.forwardEvent(event, data);
      });
      this.cleanups.push(unsub);
    }

    if (this.debug) {
      console.log(`[event-forwarder] Subscribed to ${VAULT_EVENTS.length} vault events`);
    }
  }

  /**
   * Stop forwarding events.
   */
  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }

  private forwardEvent(event: string, data?: any): void {
    const msg: SystemEventMessage = {
      type: "system:event",
      event,
      data: data ? (typeof data === "object" ? data : { value: data }) : undefined,
      timestamp: new Date().toISOString(),
    };

    if (this.debug) {
      console.log(`[event-forwarder] Forwarding event: ${event}`);
    }

    this.registry.broadcastEvent(event, msg);
  }
}
