/**
 * Device authentication — HMAC-signed tokens for fast reconnection.
 *
 * After initial pairing, the server issues a token. On subsequent
 * connections, the device presents this token instead of going through
 * the full pairing flow.
 *
 * Token format: base64(payload):hmac
 * Where payload = JSON { deviceId, vaultId, expiresAt }
 * And hmac = hex(HMAC-SHA256(payload, serverSecret))
 */

import { DEVICE_TOKEN_EXPIRY_MS } from "./constants";

const subtle = globalThis.crypto.subtle;

function stringToBuffer(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ─── Token Generation ─────────────────────────────────────────

interface TokenPayload {
  deviceId: string;
  vaultId: string;
  expiresAt: number;
}

/**
 * Import a server secret string as an HMAC-SHA256 key.
 */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  return subtle.importKey(
    "raw",
    stringToBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Generate a device token for a paired device.
 *
 * @param deviceId The device's unique identifier
 * @param vaultId The vault group identifier
 * @param serverSecret Server-side secret for signing
 * @returns Signed token string (base64(payload):hmac_hex)
 */
export async function generateDeviceToken(
  deviceId: string,
  vaultId: string,
  serverSecret: string,
): Promise<string> {
  const payload: TokenPayload = {
    deviceId,
    vaultId,
    expiresAt: Date.now() + DEVICE_TOKEN_EXPIRY_MS,
  };

  const payloadStr = JSON.stringify(payload);
  const payloadB64 = btoa(payloadStr);

  const key = await importHmacKey(serverSecret);
  const sig = await subtle.sign("HMAC", key, stringToBuffer(payloadB64));
  const hmacHex = bufferToHex(sig);

  return `${payloadB64}:${hmacHex}`;
}

/**
 * Verify and decode a device token.
 *
 * @returns The decoded payload, or null if invalid/expired.
 */
export async function verifyDeviceToken(
  token: string,
  serverSecret: string,
): Promise<TokenPayload | null> {
  const colonIdx = token.lastIndexOf(":");
  if (colonIdx === -1) return null;

  const payloadB64 = token.slice(0, colonIdx);
  const hmacHex = token.slice(colonIdx + 1);

  // Verify HMAC
  const key = await importHmacKey(serverSecret);
  const expectedSig = await subtle.sign(
    "HMAC",
    key,
    stringToBuffer(payloadB64),
  );
  const expectedHex = bufferToHex(expectedSig);

  if (hmacHex !== expectedHex) return null;

  // Decode payload
  try {
    const payloadStr = atob(payloadB64);
    const payload = JSON.parse(payloadStr) as TokenPayload;

    // Check expiry
    if (payload.expiresAt < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a server secret for HMAC signing.
 * Returns a 32-byte hex string.
 */
export function generateServerSecret(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
