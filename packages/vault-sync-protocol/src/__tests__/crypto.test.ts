import { describe, test, expect } from "bun:test";
import {
  deriveVaultKey,
  generateVaultId,
  encryptMessage,
  decryptMessage,
  generateDeviceId,
  generatePairingCode,
  hashPairingCode,
  hashContent,
} from "../crypto";

describe("deriveVaultKey", () => {
  test("derives a CryptoKey from passphrase and salt", async () => {
    const key = await deriveVaultKey("my-secret-passphrase", "vault-salt-123");
    expect(key).toBeDefined();
    expect(key.type).toBe("secret");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });

  test("same inputs produce same key", async () => {
    const key1 = await deriveVaultKey("passphrase", "salt");
    const key2 = await deriveVaultKey("passphrase", "salt");

    const raw1 = await globalThis.crypto.subtle.exportKey("raw", key1);
    const raw2 = await globalThis.crypto.subtle.exportKey("raw", key2);

    expect(new Uint8Array(raw1)).toEqual(new Uint8Array(raw2));
  });

  test("different passphrases produce different keys", async () => {
    const key1 = await deriveVaultKey("passphrase-a", "salt");
    const key2 = await deriveVaultKey("passphrase-b", "salt");

    const raw1 = await globalThis.crypto.subtle.exportKey("raw", key1);
    const raw2 = await globalThis.crypto.subtle.exportKey("raw", key2);

    expect(new Uint8Array(raw1)).not.toEqual(new Uint8Array(raw2));
  });
});

describe("generateVaultId", () => {
  test("returns a 32-char hex string", async () => {
    const key = await deriveVaultKey("passphrase", "salt");
    const vaultId = await generateVaultId(key);
    expect(vaultId).toHaveLength(32);
    expect(vaultId).toMatch(/^[0-9a-f]+$/);
  });

  test("same key produces same vault ID", async () => {
    const key = await deriveVaultKey("passphrase", "salt");
    const id1 = await generateVaultId(key);
    const id2 = await generateVaultId(key);
    expect(id1).toBe(id2);
  });
});

describe("encryptMessage / decryptMessage", () => {
  test("round-trips a message", async () => {
    const key = await deriveVaultKey("test-passphrase", "test-salt");
    const plaintext = JSON.stringify({ type: "delta-push", data: "hello" });

    const envelope = await encryptMessage(plaintext, key);
    const decrypted = await decryptMessage(envelope, key);

    expect(decrypted).toBe(plaintext);
  });

  test("envelope has expected structure", async () => {
    const key = await deriveVaultKey("test-passphrase", "test-salt");
    const envelope = await encryptMessage("test data", key);

    expect(envelope.v).toBe(1);
    expect(typeof envelope.nonce).toBe("string");
    expect(typeof envelope.ciphertext).toBe("string");
    expect(envelope.nonce.length).toBeGreaterThan(0);
    expect(envelope.ciphertext.length).toBeGreaterThan(0);
  });

  test("different nonces for each encryption", async () => {
    const key = await deriveVaultKey("test-passphrase", "test-salt");
    const e1 = await encryptMessage("same data", key);
    const e2 = await encryptMessage("same data", key);

    expect(e1.nonce).not.toBe(e2.nonce);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  test("fails with wrong key", async () => {
    const key1 = await deriveVaultKey("passphrase-1", "salt");
    const key2 = await deriveVaultKey("passphrase-2", "salt");

    const envelope = await encryptMessage("secret data", key1);

    await expect(decryptMessage(envelope, key2)).rejects.toThrow();
  });

  test("handles large payloads", async () => {
    const key = await deriveVaultKey("test", "salt");
    const largePlaintext = "x".repeat(100_000);

    const envelope = await encryptMessage(largePlaintext, key);
    const decrypted = await decryptMessage(envelope, key);

    expect(decrypted).toBe(largePlaintext);
  });

  test("handles unicode content", async () => {
    const key = await deriveVaultKey("test", "salt");
    const unicode = "Hello, world! Emojis: \u{1F600}\u{1F680}\u{1F30D} CJK: \u4F60\u597D\u4E16\u754C";

    const envelope = await encryptMessage(unicode, key);
    const decrypted = await decryptMessage(envelope, key);

    expect(decrypted).toBe(unicode);
  });
});

describe("generateDeviceId", () => {
  test("returns a 16-char hex string", async () => {
    const id = await generateDeviceId("my-host", "/path/to/vault");
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  test("same inputs produce same ID", async () => {
    const id1 = await generateDeviceId("host", "/vault");
    const id2 = await generateDeviceId("host", "/vault");
    expect(id1).toBe(id2);
  });

  test("different inputs produce different IDs", async () => {
    const id1 = await generateDeviceId("host-a", "/vault");
    const id2 = await generateDeviceId("host-b", "/vault");
    expect(id1).not.toBe(id2);
  });
});

describe("generatePairingCode", () => {
  test("returns a 6-digit string", () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^\d{6}$/);
  });

  test("generates different codes", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generatePairingCode());
    }
    // With 6-digit codes and 100 samples, we should get many unique values
    expect(codes.size).toBeGreaterThan(90);
  });
});

describe("hashPairingCode", () => {
  test("returns a hex string", async () => {
    const hash = await hashPairingCode("123456");
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash.length).toBe(64); // SHA-256 = 64 hex chars
  });

  test("same code produces same hash", async () => {
    const h1 = await hashPairingCode("123456");
    const h2 = await hashPairingCode("123456");
    expect(h1).toBe(h2);
  });
});

describe("hashContent", () => {
  test("returns SHA-256 hex of content", async () => {
    const hash = await hashContent("hello world");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test("deterministic", async () => {
    const h1 = await hashContent("test content");
    const h2 = await hashContent("test content");
    expect(h1).toBe(h2);
  });
});
