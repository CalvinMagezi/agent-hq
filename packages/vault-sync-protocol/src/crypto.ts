/**
 * E2E encryption using the WebCrypto API (SubtleCrypto).
 *
 * Works on: Node.js 15+, Bun, Obsidian Desktop, Obsidian Mobile.
 *
 * Algorithm: AES-256-GCM
 * Key derivation: PBKDF2 (SHA-256, 100k iterations)
 * Nonce: 12 random bytes per message
 */

import type { EncryptedEnvelope } from "./types";
import { PBKDF2_ITERATIONS, NONCE_SIZE, KEY_LENGTH_BITS } from "./constants";

// ─── Helpers ──────────────────────────────────────────────────

const subtle = globalThis.crypto.subtle;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stringToBuffer(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bufferToString(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

// ─── Key Derivation ───────────────────────────────────────────

/**
 * Derive an AES-256-GCM key from a passphrase and salt using PBKDF2.
 *
 * @param passphrase User-provided vault encryption passphrase
 * @param salt A stable salt (typically the vault identifier string)
 * @returns CryptoKey suitable for AES-256-GCM encrypt/decrypt
 */
export async function deriveVaultKey(
  passphrase: string,
  salt: string,
): Promise<CryptoKey> {
  const keyMaterial = await subtle.importKey(
    "raw",
    stringToBuffer(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: stringToBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: KEY_LENGTH_BITS },
    true, // extractable (needed for generateVaultId)
    ["encrypt", "decrypt"],
  );
}

/**
 * Generate a vault ID from a derived key.
 * vaultId = hex(SHA-256(raw_key_bytes)).slice(0, 32)
 *
 * This proves passphrase knowledge without transmitting the key.
 */
export async function generateVaultId(key: CryptoKey): Promise<string> {
  const rawKey = await subtle.exportKey("raw", key);
  const hash = await subtle.digest("SHA-256", rawKey);
  const hashArray = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, "0");
  }
  return hex.slice(0, 32);
}

// ─── Encrypt / Decrypt ────────────────────────────────────────

/**
 * Encrypt a plaintext JSON string into an EncryptedEnvelope.
 *
 * Uses AES-256-GCM with a 12-byte random nonce.
 * The auth tag is appended to the ciphertext by WebCrypto.
 */
export async function encryptMessage(
  plaintext: string,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_SIZE));

  const ciphertextBuf = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    stringToBuffer(plaintext),
  );

  return {
    v: 1,
    nonce: toBase64(nonce.buffer),
    ciphertext: toBase64(ciphertextBuf),
  };
}

/**
 * Decrypt an EncryptedEnvelope back to a plaintext JSON string.
 *
 * Throws if decryption fails (wrong key, tampered data, etc.)
 */
export async function decryptMessage(
  envelope: EncryptedEnvelope,
  key: CryptoKey,
): Promise<string> {
  const nonce = fromBase64(envelope.nonce);
  const ciphertext = fromBase64(envelope.ciphertext);

  const plaintextBuf = await subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ciphertext,
  );

  return bufferToString(plaintextBuf);
}

// ─── Device ID ────────────────────────────────────────────────

/**
 * Generate a stable device ID from a hostname and vault path.
 * deviceId = hex(SHA-256(hostname:vaultPath)).slice(0, 16)
 *
 * Compatible with vault-sync's `generateDeviceId()`.
 */
export async function generateDeviceId(
  hostname: string,
  vaultPath: string,
): Promise<string> {
  const input = `${hostname}:${vaultPath}`;
  const hash = await subtle.digest("SHA-256", stringToBuffer(input));
  const hashArray = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, "0");
  }
  return hex.slice(0, 16);
}

// ─── Pairing Code ─────────────────────────────────────────────

/**
 * Generate a random 6-digit numeric pairing code.
 */
export function generatePairingCode(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  const num =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(num % 1_000_000).padStart(6, "0");
}

/**
 * Hash a pairing code for safe transmission.
 */
export async function hashPairingCode(code: string): Promise<string> {
  const hash = await subtle.digest("SHA-256", stringToBuffer(code));
  const hashArray = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ─── Content Hashing ──────────────────────────────────────────

/**
 * Compute SHA-256 hash of file content using WebCrypto.
 * Returns hex string.
 */
export async function hashContent(content: string): Promise<string> {
  const hash = await subtle.digest("SHA-256", stringToBuffer(content));
  const hashArray = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, "0");
  }
  return hex;
}
