/**
 * Agent Relay Protocol — Constants.
 */

/** Protocol version */
export const RELAY_PROTOCOL_VERSION = 1 as const;

/** Default relay server port */
export const RELAY_DEFAULT_PORT = 18900;

/** Default relay server host (localhost by default) */
export const RELAY_DEFAULT_HOST = "127.0.0.1";

/** WebSocket ping interval (ms) */
export const RELAY_PING_INTERVAL_MS = 30_000;

/** Reconnect backoff: initial delay (ms) */
export const RELAY_RECONNECT_INITIAL_MS = 1_000;

/** Reconnect backoff: max delay (ms) */
export const RELAY_RECONNECT_MAX_MS = 30_000;

/** Server version */
export const RELAY_SERVER_VERSION = "0.1.0";

/** Client version */
export const RELAY_CLIENT_VERSION = "0.1.0";

/** Max streaming chunk size (bytes) */
export const RELAY_MAX_CHUNK_SIZE = 4096;

/** Job result max size (chars) */
export const RELAY_MAX_RESULT_SIZE = 100_000;
