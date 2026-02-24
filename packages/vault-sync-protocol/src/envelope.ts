/**
 * Envelope — Wrap/unwrap sync messages with optional E2E encryption.
 *
 * When E2E is enabled, all sync messages (except hello/hello-ack/ping/pong)
 * are wrapped in an EncryptedEnvelope before transmission.
 */

import type {
  SyncMessage,
  EncryptedEnvelope,
  WireMessage,
  SyncMessageType,
} from "./types";
import { encryptMessage, decryptMessage } from "./crypto";

/** Message types that are never encrypted (needed for protocol bootstrapping) */
const PLAINTEXT_TYPES: Set<SyncMessageType> = new Set([
  "hello",
  "hello-ack",
  "ping",
  "pong",
  "error",
  "pair-request",
  "pair-confirm",
]);

/**
 * Wrap a SyncMessage into a WireMessage, encrypting if E2E is enabled
 * and the message type is not in the plaintext whitelist.
 */
export async function wrapMessage(
  message: SyncMessage,
  encryptionKey: CryptoKey | null,
): Promise<WireMessage> {
  if (!encryptionKey || PLAINTEXT_TYPES.has(message.type)) {
    return { encrypted: false, payload: message };
  }

  const plaintext = JSON.stringify(message);
  const envelope = await encryptMessage(plaintext, encryptionKey);
  return { encrypted: true, payload: envelope };
}

/**
 * Unwrap a WireMessage, decrypting if necessary.
 */
export async function unwrapMessage(
  wire: WireMessage,
  decryptionKey: CryptoKey | null,
): Promise<SyncMessage> {
  if (!wire.encrypted) {
    return wire.payload as SyncMessage;
  }

  if (!decryptionKey) {
    throw new Error("Received encrypted message but no decryption key is set");
  }

  const envelope = wire.payload as EncryptedEnvelope;
  const plaintext = await decryptMessage(envelope, decryptionKey);
  return JSON.parse(plaintext) as SyncMessage;
}

/**
 * Serialize a WireMessage to a string for WebSocket transmission.
 */
export function serializeWireMessage(wire: WireMessage): string {
  return JSON.stringify(wire);
}

/**
 * Deserialize a string from WebSocket into a WireMessage.
 */
export function deserializeWireMessage(data: string): WireMessage {
  return JSON.parse(data) as WireMessage;
}
