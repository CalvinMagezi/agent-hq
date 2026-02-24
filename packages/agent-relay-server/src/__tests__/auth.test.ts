/**
 * Tests for AuthManager.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { AuthManager } from "../auth";
import type { RelayServerConfig } from "../config";

function makeConfig(apiKey = "test-api-key"): RelayServerConfig {
  return {
    port: 18900,
    host: "127.0.0.1",
    vaultPath: "/tmp/test-vault",
    apiKey,
    debug: false,
  };
}

describe("AuthManager", () => {
  describe("with API key configured", () => {
    let auth: AuthManager;

    beforeEach(() => {
      auth = new AuthManager(makeConfig("secret-key"));
    });

    test("rejects wrong API key", () => {
      const token = auth.validateApiKey("wrong-key");
      expect(token).toBeNull();
    });

    test("accepts correct API key and returns session token", () => {
      const token = auth.validateApiKey("secret-key", "client-1", "cli");
      expect(token).not.toBeNull();
      expect(token).toMatch(/^sess-/);
    });

    test("session token can be looked up", () => {
      const token = auth.validateApiKey("secret-key", "client-1", "cli");
      expect(token).not.toBeNull();
      const session = auth.validateSession(token!);
      expect(session).not.toBeNull();
      expect(session?.clientId).toBe("client-1");
      expect(session?.clientType).toBe("cli");
    });

    test("removing a session invalidates it", () => {
      const token = auth.validateApiKey("secret-key");
      expect(auth.validateSession(token!)).not.toBeNull();
      auth.removeSession(token!);
      expect(auth.validateSession(token!)).toBeNull();
    });

    test("validates Bearer header with raw API key", () => {
      expect(auth.validateBearer("Bearer secret-key")).toBe(true);
    });

    test("validates Bearer header with session token", () => {
      const token = auth.validateApiKey("secret-key");
      expect(auth.validateBearer(`Bearer ${token}`)).toBe(true);
    });

    test("rejects Bearer header with wrong key", () => {
      expect(auth.validateBearer("Bearer wrong-key")).toBe(false);
    });

    test("rejects missing Authorization header", () => {
      expect(auth.validateBearer(null)).toBe(false);
    });
  });

  describe("with no API key configured (open mode)", () => {
    let auth: AuthManager;

    beforeEach(() => {
      auth = new AuthManager(makeConfig("")); // Empty = open
    });

    test("accepts any API key when no key configured", () => {
      const token = auth.validateApiKey("anything");
      expect(token).not.toBeNull();
    });

    test("validateBearer returns true for any value when open", () => {
      expect(auth.validateBearer(null)).toBe(true);
      expect(auth.validateBearer("Bearer anything")).toBe(true);
    });
  });
});
