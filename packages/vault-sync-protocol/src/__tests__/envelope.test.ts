import { describe, test, expect } from "bun:test";
import {
  wrapMessage,
  unwrapMessage,
  serializeWireMessage,
  deserializeWireMessage,
} from "../envelope";
import { deriveVaultKey } from "../crypto";
import type { DeltaPushMessage, HelloMessage, PingMessage } from "../types";

describe("wrapMessage / unwrapMessage", () => {
  test("encrypts non-plaintext messages when key is provided", async () => {
    const key = await deriveVaultKey("test", "salt");

    const msg: DeltaPushMessage = {
      type: "delta-push",
      fromDeviceId: "device-1",
      change: {
        changeId: 42,
        path: "Notebooks/test.md",
        changeType: "modify",
        contentHash: "abc123",
        size: 100,
        mtime: Date.now(),
        detectedAt: Date.now(),
        deviceId: "device-1",
      },
    };

    const wire = await wrapMessage(msg, key);
    expect(wire.encrypted).toBe(true);
    expect((wire.payload as any).v).toBe(1);
    expect((wire.payload as any).nonce).toBeDefined();
    expect((wire.payload as any).ciphertext).toBeDefined();

    const unwrapped = await unwrapMessage(wire, key);
    expect(unwrapped).toEqual(msg);
  });

  test("does NOT encrypt hello messages", async () => {
    const key = await deriveVaultKey("test", "salt");

    const msg: HelloMessage = {
      type: "hello",
      protocolVersion: 1,
      deviceId: "device-1",
      deviceName: "Test Device",
      vaultId: "vault-abc",
      capabilities: ["e2e-aes256gcm"],
      clientVersion: "0.1.0",
    };

    const wire = await wrapMessage(msg, key);
    expect(wire.encrypted).toBe(false);
    expect(wire.payload).toEqual(msg);
  });

  test("does NOT encrypt ping messages", async () => {
    const key = await deriveVaultKey("test", "salt");

    const msg: PingMessage = { type: "ping", timestamp: Date.now() };

    const wire = await wrapMessage(msg, key);
    expect(wire.encrypted).toBe(false);
  });

  test("passes through plaintext when no key is provided", async () => {
    const msg: DeltaPushMessage = {
      type: "delta-push",
      fromDeviceId: "device-1",
      change: {
        changeId: 1,
        path: "test.md",
        changeType: "create",
        contentHash: "hash",
        size: 10,
        mtime: Date.now(),
        detectedAt: Date.now(),
        deviceId: "device-1",
      },
    };

    const wire = await wrapMessage(msg, null);
    expect(wire.encrypted).toBe(false);
    expect(wire.payload).toEqual(msg);

    const unwrapped = await unwrapMessage(wire, null);
    expect(unwrapped).toEqual(msg);
  });

  test("throws when receiving encrypted message without key", async () => {
    const key = await deriveVaultKey("test", "salt");
    const msg: DeltaPushMessage = {
      type: "delta-push",
      fromDeviceId: "d1",
      change: {
        changeId: 1,
        path: "test.md",
        changeType: "create",
        contentHash: "h",
        size: 1,
        mtime: 0,
        detectedAt: 0,
        deviceId: "d1",
      },
    };

    const wire = await wrapMessage(msg, key);
    await expect(unwrapMessage(wire, null)).rejects.toThrow(
      "no decryption key",
    );
  });
});

describe("serializeWireMessage / deserializeWireMessage", () => {
  test("round-trips a wire message", () => {
    const wire = {
      encrypted: false,
      payload: { type: "ping" as const, timestamp: 12345 },
    };

    const serialized = serializeWireMessage(wire);
    const deserialized = deserializeWireMessage(serialized);

    expect(deserialized).toEqual(wire);
  });

  test("serializes to valid JSON", () => {
    const wire = {
      encrypted: true,
      payload: { v: 1 as const, nonce: "abc", ciphertext: "def" },
    };

    const serialized = serializeWireMessage(wire);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});
