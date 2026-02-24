/**
 * Sync server configuration.
 */

import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  MAX_DEVICES_PER_VAULT,
  OFFLINE_BUFFER_SIZE,
  SERVER_VERSION,
} from "@repo/vault-sync-protocol";

export interface SyncServerConfig {
  /** Port to bind WebSocket server (default: 18800) */
  port: number;
  /** Host to bind (default: "127.0.0.1" for LAN-only) */
  host: string;
  /** Path to server SQLite database (default: "./sync-server.db") */
  dbPath: string;
  /** Server secret for signing device tokens (auto-generated on first run) */
  serverSecret: string;
  /** Max devices per vault group */
  maxDevicesPerVault: number;
  /** Max offline buffer entries per device */
  offlineBufferSize: number;
  /** Enable TLS */
  enableTls: boolean;
  /** Path to TLS certificate file */
  tlsCertPath?: string;
  /** Path to TLS private key file */
  tlsKeyPath?: string;
  /** Enable debug logging */
  debug: boolean;
}

export const DEFAULT_CONFIG: SyncServerConfig = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  dbPath: "./sync-server.db",
  serverSecret: "",
  maxDevicesPerVault: MAX_DEVICES_PER_VAULT,
  offlineBufferSize: OFFLINE_BUFFER_SIZE,
  enableTls: false,
  debug: false,
};

export { SERVER_VERSION };
