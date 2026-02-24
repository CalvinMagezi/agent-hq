/**
 * System handler — status queries, event subscriptions, agent info.
 */

import type { ServerWebSocket } from "bun";
import type { ClientData, ClientRegistry } from "../clientRegistry";
import type { VaultBridge } from "../bridges/vaultBridge";
import type { SystemSubscribeMessage } from "@repo/agent-relay-protocol";
import { RELAY_SERVER_VERSION } from "@repo/agent-relay-protocol";

export class SystemHandler {
  private registry: ClientRegistry;
  private bridge: VaultBridge;
  private startTime = Date.now();
  private debug: boolean;

  constructor(registry: ClientRegistry, bridge: VaultBridge, debug = false) {
    this.registry = registry;
    this.bridge = bridge;
    this.debug = debug;
  }

  async handleStatus(ws: ServerWebSocket<ClientData>): Promise<void> {
    try {
      const { pendingJobs, runningJobs, agentOnline } =
        await this.bridge.getSystemStatus();

      ws.send(
        JSON.stringify({
          type: "system:status-response",
          status: "healthy",
          agentOnline,
          pendingJobs,
          runningJobs,
          connectedClients: this.registry.size,
          vaultPath: this.bridge.vaultDir,
          serverVersion: RELAY_SERVER_VERSION,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
        }),
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "system:status-response",
          status: "degraded",
          agentOnline: false,
          pendingJobs: 0,
          runningJobs: 0,
          connectedClients: this.registry.size,
          vaultPath: this.bridge.vaultDir,
          serverVersion: RELAY_SERVER_VERSION,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
        }),
      );
    }
  }

  handleSubscribe(
    ws: ServerWebSocket<ClientData>,
    msg: SystemSubscribeMessage,
  ): void {
    this.registry.subscribe(ws, msg.events);

    if (this.debug) {
      console.log(
        `[system-handler] Client ${ws.data.clientId} subscribed to: ${msg.events.join(", ")}`,
      );
    }
  }
}
