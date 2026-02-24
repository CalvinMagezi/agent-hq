/**
 * ChangeRouter — Routes sync protocol messages between devices.
 *
 * The router is the core logic of the relay server. It receives
 * raw WebSocket messages, parses them, and dispatches to the
 * appropriate handler (room broadcast, direct route, etc.)
 *
 * IMPORTANT: The router NEVER inspects encrypted payloads.
 * For encrypted messages, it looks at the outer WireMessage to
 * determine routing, then forwards the raw string as-is.
 */

import type { Database } from "bun:sqlite";
import type {
  SyncMessage,
  HelloMessage,
  WireMessage,
  DeltaPushMessage,
  IndexRequestMessage,
  FileRequestMessage,
  PingMessage,
} from "@repo/vault-sync-protocol";
import {
  deserializeWireMessage,
  serializeWireMessage,
  generateDeviceToken,
  verifyDeviceToken,
  SERVER_VERSION,
  PING_INTERVAL_MS,
} from "@repo/vault-sync-protocol";
import { VaultRoom } from "./vaultRoom";
import { DeviceRegistry } from "./deviceRegistry";
import type { SyncServerConfig } from "./config";

interface DeviceConnection {
  deviceId: string;
  vaultId: string;
  ws: any;
}

export class ChangeRouter {
  private rooms = new Map<string, VaultRoom>();
  private connections = new Map<any, DeviceConnection>(); // ws -> connection info
  private registry: DeviceRegistry;
  private config: SyncServerConfig;

  constructor(db: Database, config: SyncServerConfig) {
    this.registry = new DeviceRegistry(db);
    this.config = config;
  }

  /**
   * Handle a new WebSocket connection.
   */
  handleOpen(ws: any): void {
    if (this.config.debug) {
      console.log("[sync-server] New connection");
    }
  }

  /**
   * Handle an incoming WebSocket message.
   */
  async handleMessage(ws: any, rawData: string | Buffer): Promise<void> {
    const data = typeof rawData === "string" ? rawData : rawData.toString();

    let wire: WireMessage;
    try {
      wire = deserializeWireMessage(data);
    } catch {
      this.sendError(ws, "PARSE_ERROR", "Invalid message format");
      return;
    }

    // If the message is encrypted, we can only route based on the connection context
    // (the device must have already completed the hello handshake)
    if (wire.encrypted) {
      return this.routeEncrypted(ws, data);
    }

    const msg = wire.payload as SyncMessage;

    switch (msg.type) {
      case "hello":
        return this.handleHello(ws, msg as HelloMessage);
      case "delta-push":
        return this.handleDeltaPush(ws, data, msg as DeltaPushMessage);
      case "index-request":
        return this.handleIndexRequest(ws, data, msg as IndexRequestMessage);
      case "file-request":
        return this.handleFileRequest(ws, data, msg as FileRequestMessage);
      case "file-response":
        return this.handleFileResponse(ws, data);
      case "index-response":
        return this.handleIndexResponse(ws, data);
      case "delta-ack":
        return this.routeToDevice(ws, data);
      case "ping":
        return this.handlePing(ws, msg as PingMessage);
      default:
        // Forward unknown messages to room as-is
        this.routeEncrypted(ws, data);
    }
  }

  /**
   * Handle WebSocket close.
   */
  handleClose(ws: any): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    const room = this.rooms.get(conn.vaultId);
    if (room) {
      room.removeDevice(conn.deviceId);

      // Notify remaining devices
      const deviceList = this.buildDeviceList(conn.vaultId, room);
      room.broadcast(deviceList);

      // Clean up empty rooms
      if (room.isEmpty) {
        this.rooms.delete(conn.vaultId);
      }
    }

    this.connections.delete(ws);

    if (this.config.debug) {
      console.log(`[sync-server] Device ${conn.deviceId} disconnected from vault ${conn.vaultId}`);
    }
  }

  // ─── Message Handlers ─────────────────────────────────────

  private async handleHello(ws: any, msg: HelloMessage): Promise<void> {
    const { deviceId, deviceName, vaultId, deviceToken } = msg;

    // Verify device token if provided (fast re-auth)
    if (deviceToken) {
      const payload = await verifyDeviceToken(deviceToken, this.config.serverSecret);
      if (!payload || payload.deviceId !== deviceId || payload.vaultId !== vaultId) {
        this.sendError(ws, "AUTH_FAILED", "Invalid device token");
        return;
      }
    }

    // Check device limit
    const currentCount = this.registry.getVaultDeviceCount(vaultId);
    const existingDevice = this.registry.getDevice(deviceId, vaultId);
    if (!existingDevice && currentCount >= this.config.maxDevicesPerVault) {
      this.sendError(ws, "VAULT_FULL", `Max ${this.config.maxDevicesPerVault} devices per vault`);
      return;
    }

    // Register device
    const token = await generateDeviceToken(deviceId, vaultId, this.config.serverSecret);
    this.registry.registerDevice(deviceId, vaultId, deviceName, token);

    // Join room
    let room = this.rooms.get(vaultId);
    if (!room) {
      room = new VaultRoom(vaultId, this.config.offlineBufferSize);
      this.rooms.set(vaultId, room);
    }
    room.addDevice(deviceId, ws, deviceName);

    // Track connection
    this.connections.set(ws, { deviceId, vaultId, ws });

    // Drain offline buffer
    const bufferedChanges = room.drainOfflineBuffer(deviceId);

    // Send hello-ack
    const ack = serializeWireMessage({
      encrypted: false,
      payload: {
        type: "hello-ack" as const,
        deviceId: "server",
        serverVersion: SERVER_VERSION,
        assignedToken: token,
        connectedDevices: room.getOnlineDeviceIds().filter((id) => id !== deviceId),
      },
    });
    ws.send(ack);

    // Send buffered changes
    if (bufferedChanges.length > 0) {
      const response = serializeWireMessage({
        encrypted: false,
        payload: {
          type: "index-response" as const,
          fromDeviceId: "server",
          changes: bufferedChanges,
          hasMore: false,
          latestChangeId: bufferedChanges[bufferedChanges.length - 1].changeId,
        },
      });
      ws.send(response);
    }

    // Notify other devices in room
    const deviceList = this.buildDeviceList(vaultId, room);
    room.broadcast(deviceList, deviceId);

    if (this.config.debug) {
      console.log(
        `[sync-server] Device ${deviceId} (${deviceName}) joined vault ${vaultId}. ` +
          `Online: ${room.deviceCount}, Buffered: ${bufferedChanges.length}`,
      );
    }
  }

  private handleDeltaPush(ws: any, rawData: string, msg: DeltaPushMessage): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    const room = this.rooms.get(conn.vaultId);
    if (!room) return;

    // Broadcast to all online devices except sender
    room.broadcastRaw(rawData, conn.deviceId);

    // Buffer for offline devices
    const allKnown = this.registry.listDevices(conn.vaultId);
    for (const device of allKnown) {
      if (device.deviceId === conn.deviceId) continue;
      if (!room.isOnline(device.deviceId)) {
        room.bufferForOffline(device.deviceId, msg.change);
      }
    }
  }

  private handleIndexRequest(ws: any, rawData: string, msg: IndexRequestMessage): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    const room = this.rooms.get(conn.vaultId);
    if (!room) return;

    // Forward to all other online devices — they will respond with index-response
    room.broadcastRaw(rawData, conn.deviceId);
  }

  private handleFileRequest(ws: any, rawData: string, msg: FileRequestMessage): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    const room = this.rooms.get(conn.vaultId);
    if (!room) return;

    // Route directly to the target device
    const delivered = room.routeTo(msg.targetDeviceId, rawData);
    if (!delivered) {
      this.sendError(ws, "DEVICE_OFFLINE", `Device ${msg.targetDeviceId} is offline`);
    }
  }

  private handleFileResponse(ws: any, rawData: string): void {
    // FileResponse contains fromDeviceId — route to the original requester
    this.routeToDevice(ws, rawData);
  }

  private handleIndexResponse(ws: any, rawData: string): void {
    // Index responses should go to the device that requested them
    // Since we broadcast the request, we broadcast the response too
    const conn = this.connections.get(ws);
    if (!conn) return;

    const room = this.rooms.get(conn.vaultId);
    if (!room) return;

    room.broadcastRaw(rawData, conn.deviceId);
  }

  private handlePing(ws: any, _msg: PingMessage): void {
    const pong = serializeWireMessage({
      encrypted: false,
      payload: { type: "pong" as const, timestamp: Date.now() },
    });
    ws.send(pong);

    // Update last seen
    const conn = this.connections.get(ws);
    if (conn) {
      this.registry.touchDevice(conn.deviceId, conn.vaultId);
    }
  }

  /**
   * Route encrypted messages based on connection context.
   * We broadcast to the room since we can't inspect the content.
   */
  private routeEncrypted(ws: any, rawData: string): void {
    const conn = this.connections.get(ws);
    if (!conn) {
      this.sendError(ws, "NOT_AUTHENTICATED", "Send hello first");
      return;
    }

    const room = this.rooms.get(conn.vaultId);
    if (!room) return;

    room.broadcastRaw(rawData, conn.deviceId);
  }

  /**
   * Route a message by broadcasting to the sender's room (excluding sender).
   */
  private routeToDevice(ws: any, rawData: string): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    const room = this.rooms.get(conn.vaultId);
    if (!room) return;

    room.broadcastRaw(rawData, conn.deviceId);
  }

  // ─── Helpers ──────────────────────────────────────────────

  private buildDeviceList(vaultId: string, room: VaultRoom) {
    const allDevices = this.registry.listDevices(vaultId);
    const onlineIds = new Set(room.getOnlineDeviceIds());

    return {
      type: "device-list" as const,
      devices: allDevices.map((d) => ({
        ...d,
        status: onlineIds.has(d.deviceId) ? ("online" as const) : ("offline" as const),
      })),
    };
  }

  private sendError(ws: any, code: string, message: string): void {
    const data = serializeWireMessage({
      encrypted: false,
      payload: { type: "error" as const, code, message },
    });
    try {
      ws.send(data);
    } catch {
      // Ignore send errors
    }
  }

  /**
   * Get stats for health checks.
   */
  getStats(): { rooms: number; connections: number } {
    return {
      rooms: this.rooms.size,
      connections: this.connections.size,
    };
  }
}
