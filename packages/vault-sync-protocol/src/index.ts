/**
 * @repo/vault-sync-protocol — Shared sync protocol for Agent-HQ vault sync.
 */

// Types
export type {
  SyncChangeEntry,
  HelloMessage,
  HelloAckMessage,
  IndexRequestMessage,
  IndexResponseMessage,
  DeltaPushMessage,
  DeltaAckMessage,
  FileRequestMessage,
  FileResponseMessage,
  PairRequestMessage,
  PairConfirmMessage,
  DeviceListMessage,
  DeviceInfo,
  PingMessage,
  PongMessage,
  ErrorMessage,
  EncryptedEnvelope,
  SyncMessage,
  SyncMessageType,
  WireMessage,
} from "./types";

// Crypto
export {
  deriveVaultKey,
  generateVaultId,
  encryptMessage,
  decryptMessage,
  generateDeviceId,
  generatePairingCode,
  hashPairingCode,
  hashContent,
} from "./crypto";

// Device Auth
export {
  generateDeviceToken,
  verifyDeviceToken,
  generateServerSecret,
} from "./deviceAuth";

// Envelope
export {
  wrapMessage,
  unwrapMessage,
  serializeWireMessage,
  deserializeWireMessage,
} from "./envelope";

// Constants
export {
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  DEFAULT_HOST,
  PING_INTERVAL_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  OFFLINE_BUFFER_SIZE,
  DEFAULT_BATCH_SIZE,
  MAX_DEVICES_PER_VAULT,
  IGNORE_PATTERNS,
  CAPABILITIES,
  CLIENT_VERSION,
  SERVER_VERSION,
} from "./constants";
