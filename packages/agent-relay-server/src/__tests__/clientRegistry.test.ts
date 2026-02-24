/**
 * Tests for ClientRegistry.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ClientRegistry } from "../clientRegistry";
import type { ClientData } from "../clientRegistry";
import type { ServerWebSocket } from "bun";

// Mock ServerWebSocket
function makeMockWs(sent: string[] = []): ServerWebSocket<ClientData> {
  return {
    data: {} as ClientData,
    send: (msg: string) => sent.push(msg),
    remoteAddress: "127.0.0.1",
  } as unknown as ServerWebSocket<ClientData>;
}

function makeClientData(sessionToken = "sess-001", clientType = "cli"): ClientData {
  return {
    sessionToken,
    clientId: `client-${sessionToken}`,
    clientType,
    connectedAt: Date.now(),
    subscriptions: new Set(),
  };
}

describe("ClientRegistry", () => {
  let registry: ClientRegistry;

  beforeEach(() => {
    registry = new ClientRegistry();
  });

  test("starts empty", () => {
    expect(registry.size).toBe(0);
  });

  test("add and remove clients", () => {
    const ws = makeMockWs();
    const data = makeClientData("sess-001");
    registry.add(ws, data);
    expect(registry.size).toBe(1);
    registry.remove(ws);
    expect(registry.size).toBe(0);
  });

  test("get returns client data", () => {
    const ws = makeMockWs();
    const data = makeClientData("sess-001");
    registry.add(ws, data);
    expect(registry.get(ws)?.sessionToken).toBe("sess-001");
  });

  test("broadcast sends to all clients", () => {
    const sent1: string[] = [];
    const sent2: string[] = [];
    const ws1 = makeMockWs(sent1);
    const ws2 = makeMockWs(sent2);
    registry.add(ws1, makeClientData("sess-001"));
    registry.add(ws2, makeClientData("sess-002"));

    registry.broadcast({ type: "ping", timestamp: 1234 });

    expect(sent1).toHaveLength(1);
    expect(sent2).toHaveLength(1);
    expect(JSON.parse(sent1[0])).toEqual({ type: "ping", timestamp: 1234 });
  });

  test("sendTo sends only to specific session", () => {
    const sent1: string[] = [];
    const sent2: string[] = [];
    const ws1 = makeMockWs(sent1);
    const ws2 = makeMockWs(sent2);
    registry.add(ws1, makeClientData("sess-001"));
    registry.add(ws2, makeClientData("sess-002"));

    registry.sendTo("sess-001", { type: "pong", timestamp: 9999 });

    expect(sent1).toHaveLength(1);
    expect(sent2).toHaveLength(0);
  });

  test("sendTo returns false for unknown session", () => {
    const result = registry.sendTo("nonexistent", { type: "ping", timestamp: 0 });
    expect(result).toBe(false);
  });

  describe("event subscriptions", () => {
    test("subscribe adds patterns to client", () => {
      const ws = makeMockWs();
      const data = makeClientData("sess-001");
      registry.add(ws, data);
      registry.subscribe(ws, ["job:*", "system:*"]);
      expect(data.subscriptions.has("job:*")).toBe(true);
      expect(data.subscriptions.has("system:*")).toBe(true);
    });

    test("broadcastEvent sends to matching subscriptions", () => {
      const sent1: string[] = [];
      const sent2: string[] = [];
      const ws1 = makeMockWs(sent1);
      const ws2 = makeMockWs(sent2);
      const data1 = makeClientData("sess-001");
      const data2 = makeClientData("sess-002");
      registry.add(ws1, data1);
      registry.add(ws2, data2);

      // Only ws1 subscribes to job events
      registry.subscribe(ws1, ["job:*"]);

      registry.broadcastEvent("job:created", { type: "system:event", event: "job:created", timestamp: new Date().toISOString() });

      expect(sent1).toHaveLength(1);
      expect(sent2).toHaveLength(0);
    });

    test("wildcard * subscription receives all events", () => {
      const sent: string[] = [];
      const ws = makeMockWs(sent);
      const data = makeClientData("sess-001");
      registry.add(ws, data);
      registry.subscribe(ws, ["*"]);

      registry.broadcastEvent("job:created", { type: "system:event", event: "job:created", timestamp: "" });
      registry.broadcastEvent("note:modified", { type: "system:event", event: "note:modified", timestamp: "" });

      expect(sent).toHaveLength(2);
    });

    test("exact event subscription works", () => {
      const sent: string[] = [];
      const ws = makeMockWs(sent);
      const data = makeClientData("sess-001");
      registry.add(ws, data);
      registry.subscribe(ws, ["job:created"]);

      registry.broadcastEvent("job:created", { msg: "yes" });
      registry.broadcastEvent("job:completed", { msg: "no" });

      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0])).toEqual({ msg: "yes" });
    });
  });
});
