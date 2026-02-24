/**
 * Vault Sync Protocol — Message types and shared data structures.
 *
 * A lightweight protocol for cursor-based changelog synchronization
 * between Obsidian vault devices via a relay server.
 *
 * Inspired by Syncthing's BEP (Block Exchange Protocol) but simplified
 * for file-level delta sync rather than block-level.
 */

// ─── Sync Change Entry ────────────────────────────────────────

export interface SyncChangeEntry {
  /** Monotonic ID from the originating device's ChangeLog */
  changeId: number;
  /** Relative path from vault root (forward slashes) */
  path: string;
  /** Previous path (for renames) */
  oldPath?: string;
  /** Type of change */
  changeType: "create" | "modify" | "delete" | "rename";
  /** SHA-256 hash of file content after change (null for deletes) */
  contentHash: string | null;
  /** File size in bytes (null for deletes) */
  size: number | null;
  /** File mtime as Unix epoch ms */
  mtime: number | null;
  /** When the change was detected on the originating device */
  detectedAt: number;
  /** Device ID that detected this change */
  deviceId: string;
}

// ─── Handshake ────────────────────────────────────────────────

export interface HelloMessage {
  type: "hello";
  /** Protocol version (currently 1) */
  protocolVersion: 1;
  /** SHA-256-derived device identifier */
  deviceId: string;
  /** Human-readable device name */
  deviceName: string;
  /** SHA-256(derived_vault_key) — proves passphrase knowledge */
  vaultId: string;
  /** Supported capabilities */
  capabilities: string[];
  /** Client software version */
  clientVersion: string;
  /** HMAC device token for fast re-auth (set after first pairing) */
  deviceToken?: string;
}

export interface HelloAckMessage {
  type: "hello-ack";
  /** Server's device ID (or server identifier) */
  deviceId: string;
  /** Server software version */
  serverVersion: string;
  /** Token for subsequent reconnections */
  assignedToken?: string;
  /** Other device IDs currently online in this vault group */
  connectedDevices: string[];
}

// ─── Index Exchange (initial sync / catchup) ──────────────────

export interface IndexRequestMessage {
  type: "index-request";
  /** The requester's last known changeId from this peer */
  sinceChangeId: number;
  /** Max changes to return per batch */
  batchSize: number;
}

export interface IndexResponseMessage {
  type: "index-response";
  /** Device ID that produced these changes */
  fromDeviceId: string;
  /** Batch of changes since the requested cursor */
  changes: SyncChangeEntry[];
  /** True if more changes are available beyond this batch */
  hasMore: boolean;
  /** Highest changeId in this batch */
  latestChangeId: number;
}

// ─── Real-time Delta Push ─────────────────────────────────────

export interface DeltaPushMessage {
  type: "delta-push";
  /** Device ID that originated this change */
  fromDeviceId: string;
  /** The change entry */
  change: SyncChangeEntry;
}

export interface DeltaAckMessage {
  type: "delta-ack";
  /** The changeId being acknowledged */
  changeId: number;
  /** Device acknowledging receipt */
  fromDeviceId: string;
}

// ─── File Content Transfer ────────────────────────────────────

export interface FileRequestMessage {
  type: "file-request";
  /** Relative vault path */
  path: string;
  /** SHA-256 hash of the requested version */
  contentHash: string;
  /** Target device that should respond */
  targetDeviceId: string;
  /** Requesting device */
  fromDeviceId: string;
}

export interface FileResponseMessage {
  type: "file-response";
  /** Relative vault path */
  path: string;
  /** SHA-256 hash of this content */
  contentHash: string;
  /** Base64-encoded file content */
  content: string;
  /** File size in bytes */
  size: number;
  /** File mtime as Unix epoch ms */
  mtime: number;
  /** Device sending the content */
  fromDeviceId: string;
}

// ─── Device Pairing ───────────────────────────────────────────

export interface PairRequestMessage {
  type: "pair-request";
  /** New device's ID */
  deviceId: string;
  /** Human-readable device name */
  deviceName: string;
  /** SHA-256 of the 6-digit pairing code */
  pairingCodeHash: string;
}

export interface PairConfirmMessage {
  type: "pair-confirm";
  /** Confirming device's ID */
  deviceId: string;
  /** Whether pairing was approved */
  approved: boolean;
}

export interface DeviceListMessage {
  type: "device-list";
  devices: DeviceInfo[];
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  lastSeen: number;
  status: "online" | "offline";
}

// ─── Heartbeat ────────────────────────────────────────────────

export interface PingMessage {
  type: "ping";
  timestamp: number;
}

export interface PongMessage {
  type: "pong";
  timestamp: number;
}

// ─── Error ────────────────────────────────────────────────────

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

// ─── Encrypted Envelope ───────────────────────────────────────

export interface EncryptedEnvelope {
  /** Envelope version */
  v: 1;
  /** Base64-encoded 12-byte nonce/IV */
  nonce: string;
  /** Base64-encoded ciphertext (AES-256-GCM encrypted JSON) */
  ciphertext: string;
}

// ─── Union Type ───────────────────────────────────────────────

export type SyncMessage =
  | HelloMessage
  | HelloAckMessage
  | IndexRequestMessage
  | IndexResponseMessage
  | DeltaPushMessage
  | DeltaAckMessage
  | FileRequestMessage
  | FileResponseMessage
  | PairRequestMessage
  | PairConfirmMessage
  | DeviceListMessage
  | PingMessage
  | PongMessage
  | ErrorMessage;

/** Extract the `type` field from any SyncMessage */
export type SyncMessageType = SyncMessage["type"];

// ─── Wrapper (envelope or plaintext) ──────────────────────────

export interface WireMessage {
  /** If true, `payload` is an EncryptedEnvelope. Otherwise it's a SyncMessage. */
  encrypted: boolean;
  payload: EncryptedEnvelope | SyncMessage;
}
