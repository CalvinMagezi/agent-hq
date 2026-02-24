import { describe, test, expect } from "bun:test";
import {
  generateDeviceToken,
  verifyDeviceToken,
  generateServerSecret,
} from "../deviceAuth";

describe("generateServerSecret", () => {
  test("returns a 64-char hex string", () => {
    const secret = generateServerSecret();
    expect(secret).toHaveLength(64);
    expect(secret).toMatch(/^[0-9a-f]+$/);
  });

  test("generates unique secrets", () => {
    const s1 = generateServerSecret();
    const s2 = generateServerSecret();
    expect(s1).not.toBe(s2);
  });
});

describe("generateDeviceToken / verifyDeviceToken", () => {
  const serverSecret = "test-server-secret-for-hmac-signing";

  test("generates a valid token", async () => {
    const token = await generateDeviceToken("device-1", "vault-abc", serverSecret);
    expect(typeof token).toBe("string");
    expect(token).toContain(":");
  });

  test("token verifies with correct secret", async () => {
    const token = await generateDeviceToken("device-1", "vault-abc", serverSecret);
    const payload = await verifyDeviceToken(token, serverSecret);

    expect(payload).not.toBeNull();
    expect(payload!.deviceId).toBe("device-1");
    expect(payload!.vaultId).toBe("vault-abc");
    expect(payload!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("token fails with wrong secret", async () => {
    const token = await generateDeviceToken("device-1", "vault-abc", serverSecret);
    const payload = await verifyDeviceToken(token, "wrong-secret");
    expect(payload).toBeNull();
  });

  test("token fails with tampered payload", async () => {
    const token = await generateDeviceToken("device-1", "vault-abc", serverSecret);
    const [payloadB64, hmac] = token.split(":");

    // Tamper with payload
    const decoded = JSON.parse(atob(payloadB64));
    decoded.deviceId = "evil-device";
    const tampered = btoa(JSON.stringify(decoded));

    const payload = await verifyDeviceToken(`${tampered}:${hmac}`, serverSecret);
    expect(payload).toBeNull();
  });

  test("returns null for malformed tokens", async () => {
    expect(await verifyDeviceToken("no-colon-here", serverSecret)).toBeNull();
    expect(await verifyDeviceToken("", serverSecret)).toBeNull();
    expect(await verifyDeviceToken("invalid:hmac", serverSecret)).toBeNull();
  });
});
