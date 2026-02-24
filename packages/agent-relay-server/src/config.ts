/**
 * Relay server configuration.
 */

import {
  RELAY_DEFAULT_PORT,
  RELAY_DEFAULT_HOST,
} from "@repo/agent-relay-protocol";
import * as path from "path";

export interface RelayServerConfig {
  /** Port to bind (default: 18900) */
  port: number;
  /** Host to bind (default: "127.0.0.1") */
  host: string;
  /** Path to the vault directory */
  vaultPath: string;
  /** API key for authentication (AGENTHQ_API_KEY env var) */
  apiKey: string;
  /** Enable debug logging */
  debug: boolean;
}

function resolveVaultPath(): string {
  if (process.env.VAULT_PATH) {
    return path.resolve(process.env.VAULT_PATH);
  }
  // Default: look for .vault relative to CWD
  return path.resolve(process.cwd(), ".vault");
}

export const DEFAULT_CONFIG: RelayServerConfig = {
  port: RELAY_DEFAULT_PORT,
  host: RELAY_DEFAULT_HOST,
  vaultPath: resolveVaultPath(),
  apiKey: process.env.AGENTHQ_API_KEY ?? "",
  debug: false,
};
