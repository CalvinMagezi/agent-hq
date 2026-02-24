/**
 * VaultRoom — Manages connected devices for a single vault group.
 *
 * Handles broadcasting, direct routing, and offline message buffering.
 */

import type { SyncChangeEntry, SyncMessage } from "@repo/vault-sync-protocol";
import { serializeWireMessage } from "@repo/vault-sync-protocol";
import { OFFLINE_BUFFER_SIZE } from "@repo/vault-sync-protocol";

interface ConnectedDevice {
  ws: any; // ServerWebSocket from Bun.serve
  deviceName: string;
  lastSeen: number;
}

export class VaultRoom {
  readonly vaultId: string;
  private devices = new Map<string, ConnectedDevice>();
  private offlineBuffer = new Map<string, SyncChangeEntry[]>();
  private maxBufferSize: number;

  constructor(vaultId: string, maxBufferSize = OFFLINE_BUFFER_SIZE) {
    this.vaultId = vaultId;
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Add a device to this room.
   */
  addDevice(deviceId: string, ws: any, deviceName: string): void {
    this.devices.set(deviceId, { ws, deviceName, lastSeen: Date.now() });
  }

  /**
   * Remove a device from this room.
   */
  removeDevice(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  /**
   * Check if a device is currently connected.
   */
  isOnline(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  /**
   * Get IDs of all online devices.
   */
  getOnlineDeviceIds(): string[] {
    return Array.from(this.devices.keys());
  }

  /**
   * Get count of connected devices.
   */
  get deviceCount(): number {
    return this.devices.size;
  }

  /**
   * Broadcast a message to all devices in the room, except the excluded one.
   */
  broadcast(message: SyncMessage, excludeDeviceId?: string): void {
    const data = serializeWireMessage({ encrypted: false, payload: message });

    for (const [id, device] of this.devices) {
      if (id === excludeDeviceId) continue;
      try {
        device.ws.send(data);
      } catch {
        // Device may have disconnected; it will be cleaned up on close
      }
    }
  }

  /**
   * Broadcast raw string data (already serialized, possibly encrypted).
   */
  broadcastRaw(data: string, excludeDeviceId?: string): void {
    for (const [id, device] of this.devices) {
      if (id === excludeDeviceId) continue;
      try {
        device.ws.send(data);
      } catch {
        // Ignore send errors
      }
    }
  }

  /**
   * Route a message directly to a specific device.
   * Returns false if the device is not online.
   */
  routeTo(targetDeviceId: string, data: string): boolean {
    const device = this.devices.get(targetDeviceId);
    if (!device) return false;

    try {
      device.ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Buffer a change for an offline device.
   * Drops oldest entries if buffer exceeds max size.
   */
  bufferForOffline(deviceId: string, change: SyncChangeEntry): void {
    let buffer = this.offlineBuffer.get(deviceId);
    if (!buffer) {
      buffer = [];
      this.offlineBuffer.set(deviceId, buffer);
    }

    buffer.push(change);

    // Evict oldest if over limit
    while (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }
  }

  /**
   * Drain the offline buffer for a device that just reconnected.
   * Returns the buffered changes and clears the buffer.
   */
  drainOfflineBuffer(deviceId: string): SyncChangeEntry[] {
    const buffer = this.offlineBuffer.get(deviceId) ?? [];
    this.offlineBuffer.delete(deviceId);
    return buffer;
  }

  /**
   * Get the list of all known device IDs (for offline buffering decisions).
   */
  getKnownDeviceIds(): string[] {
    const online = new Set(this.devices.keys());
    const buffered = new Set(this.offlineBuffer.keys());
    return [...new Set([...online, ...buffered])];
  }

  /**
   * Check if room is empty (no connected devices and no buffered changes).
   */
  get isEmpty(): boolean {
    return this.devices.size === 0 && this.offlineBuffer.size === 0;
  }
}
