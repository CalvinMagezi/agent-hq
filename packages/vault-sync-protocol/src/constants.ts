/**
 * Protocol constants and defaults.
 */

/** Current protocol version */
export const PROTOCOL_VERSION = 1 as const;

/** Default relay server port */
export const DEFAULT_PORT = 18800;

/** Default relay server host (LAN-only) */
export const DEFAULT_HOST = "127.0.0.1";

/** WebSocket ping interval (ms) */
export const PING_INTERVAL_MS = 30_000;

/** Reconnect backoff: initial delay (ms) */
export const RECONNECT_INITIAL_MS = 1_000;

/** Reconnect backoff: max delay (ms) */
export const RECONNECT_MAX_MS = 30_000;

/** Max changes buffered per offline device on the server */
export const OFFLINE_BUFFER_SIZE = 1_000;

/** Default batch size for index exchange */
export const DEFAULT_BATCH_SIZE = 500;

/** Max devices per vault group */
export const MAX_DEVICES_PER_VAULT = 10;

/** PBKDF2 iterations for key derivation */
export const PBKDF2_ITERATIONS = 100_000;

/** AES-256-GCM nonce size in bytes */
export const NONCE_SIZE = 12;

/** Derived key length in bits */
export const KEY_LENGTH_BITS = 256;

/** Device token expiry (30 days in ms) */
export const DEVICE_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Paths that should never be synced */
export const IGNORE_PATTERNS = [
  ".obsidian/",
  "_embeddings/",
  ".git/",
  ".DS_Store",
  "node_modules/",
  ".sync-conflict-",
  ".trash/",
] as const;

/** Client capabilities advertised during handshake */
export const CAPABILITIES = [
  "e2e-aes256gcm",
  "delta-sync",
  "conflict-resolve",
] as const;

/** Software version string */
export const CLIENT_VERSION = "0.1.0";

/** Server version string */
export const SERVER_VERSION = "0.1.0";
