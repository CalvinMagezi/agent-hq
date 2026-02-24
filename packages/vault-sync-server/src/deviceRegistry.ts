/**
 * DeviceRegistry — Manages device registrations and vault groups in SQLite.
 */

import { Database } from "bun:sqlite";
import type { DeviceInfo } from "@repo/vault-sync-protocol";

export class DeviceRegistry {
  private upsertDeviceStmt;
  private getDeviceStmt;
  private listDevicesStmt;
  private touchDeviceStmt;
  private upsertVaultGroupStmt;
  private getVaultGroupStmt;
  private removeDeviceStmt;

  constructor(private db: Database) {
    this.upsertDeviceStmt = db.prepare(`
      INSERT INTO devices (device_id, vault_id, device_name, device_token, first_seen, last_seen)
      VALUES ($deviceId, $vaultId, $deviceName, $deviceToken, $now, $now)
      ON CONFLICT(device_id, vault_id) DO UPDATE SET
        device_name = $deviceName,
        device_token = COALESCE($deviceToken, device_token),
        last_seen = $now
    `);

    this.getDeviceStmt = db.prepare(`
      SELECT device_id, vault_id, device_name, device_token, first_seen, last_seen
      FROM devices WHERE device_id = $deviceId AND vault_id = $vaultId
    `);

    this.listDevicesStmt = db.prepare(`
      SELECT device_id, device_name, last_seen
      FROM devices WHERE vault_id = $vaultId
    `);

    this.touchDeviceStmt = db.prepare(`
      UPDATE devices SET last_seen = $now
      WHERE device_id = $deviceId AND vault_id = $vaultId
    `);

    this.upsertVaultGroupStmt = db.prepare(`
      INSERT INTO vault_groups (vault_id, created_at, device_count)
      VALUES ($vaultId, $now, 1)
      ON CONFLICT(vault_id) DO UPDATE SET
        device_count = (SELECT COUNT(*) FROM devices WHERE vault_id = $vaultId)
    `);

    this.getVaultGroupStmt = db.prepare(`
      SELECT vault_id, created_at, device_count
      FROM vault_groups WHERE vault_id = $vaultId
    `);

    this.removeDeviceStmt = db.prepare(`
      DELETE FROM devices WHERE device_id = $deviceId AND vault_id = $vaultId
    `);
  }

  /**
   * Register or update a device in a vault group.
   */
  registerDevice(
    deviceId: string,
    vaultId: string,
    deviceName: string,
    deviceToken?: string,
  ): void {
    const now = Date.now();
    this.upsertDeviceStmt.run({
      $deviceId: deviceId,
      $vaultId: vaultId,
      $deviceName: deviceName,
      $deviceToken: deviceToken ?? null,
      $now: now,
    });
    this.upsertVaultGroupStmt.run({ $vaultId: vaultId, $now: now });
  }

  /**
   * Get a specific device.
   */
  getDevice(
    deviceId: string,
    vaultId: string,
  ): { deviceId: string; vaultId: string; deviceName: string; lastSeen: number } | null {
    const row = this.getDeviceStmt.get({
      $deviceId: deviceId,
      $vaultId: vaultId,
    }) as any;
    if (!row) return null;
    return {
      deviceId: row.device_id,
      vaultId: row.vault_id,
      deviceName: row.device_name,
      lastSeen: row.last_seen,
    };
  }

  /**
   * List all devices in a vault group.
   */
  listDevices(vaultId: string): DeviceInfo[] {
    const rows = this.listDevicesStmt.all({ $vaultId: vaultId }) as any[];
    return rows.map((row) => ({
      deviceId: row.device_id,
      deviceName: row.device_name,
      lastSeen: row.last_seen,
      status: "offline" as const, // Caller sets online status from VaultRoom
    }));
  }

  /**
   * Update a device's last-seen timestamp.
   */
  touchDevice(deviceId: string, vaultId: string): void {
    this.touchDeviceStmt.run({
      $deviceId: deviceId,
      $vaultId: vaultId,
      $now: Date.now(),
    });
  }

  /**
   * Remove a device from a vault group.
   */
  removeDevice(deviceId: string, vaultId: string): void {
    this.removeDeviceStmt.run({
      $deviceId: deviceId,
      $vaultId: vaultId,
    });
    this.upsertVaultGroupStmt.run({ $vaultId: vaultId, $now: Date.now() });
  }

  /**
   * Get the device count for a vault group.
   */
  getVaultDeviceCount(vaultId: string): number {
    const row = this.getVaultGroupStmt.get({ $vaultId: vaultId }) as any;
    return row?.device_count ?? 0;
  }
}
