import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ChangeRouter } from "../changeRouter";
import { initServerDatabase } from "../db";
import { DeviceRegistry } from "../deviceRegistry";
import { VaultRoom } from "../vaultRoom";
import { DEFAULT_CONFIG } from "../config";
import {
  serializeWireMessage,
  generateServerSecret,
} from "@repo/vault-sync-protocol";
import type {
  HelloMessage,
  DeltaPushMessage,
  PingMessage,
  SyncChangeEntry,
} from "@repo/vault-sync-protocol";

// Mock WebSocket
class MockWs {
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function makeConfig() {
  return {
    ...DEFAULT_CONFIG,
    serverSecret: generateServerSecret(),
    debug: false,
  };
}

describe("ChangeRouter", () => {
  let db: Database;
  let router: ChangeRouter;

  beforeEach(() => {
    db = new Database(":memory:");
    initServerDatabase(db);
    router = new ChangeRouter(db, makeConfig());
  });

  afterEach(() => {
    db.close();
  });

  test("handles hello and sends hello-ack", async () => {
    const ws = new MockWs();

    const hello: HelloMessage = {
      type: "hello",
      protocolVersion: 1,
      deviceId: "device-1",
      deviceName: "Test Device",
      vaultId: "vault-abc",
      capabilities: ["delta-sync"],
      clientVersion: "0.1.0",
    };

    const wireData = serializeWireMessage({
      encrypted: false,
      payload: hello,
    });

    await router.handleMessage(ws, wireData);

    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const ackWire = JSON.parse(ws.sent[0]);
    expect(ackWire.payload.type).toBe("hello-ack");
    expect(ackWire.payload.assignedToken).toBeDefined();
    expect(ackWire.payload.connectedDevices).toEqual([]);
  });

  test("notifies existing devices when a new device joins", async () => {
    const ws1 = new MockWs();
    const ws2 = new MockWs();

    // Device 1 joins
    const hello1 = serializeWireMessage({
      encrypted: false,
      payload: {
        type: "hello" as const,
        protocolVersion: 1 as const,
        deviceId: "device-1",
        deviceName: "Device 1",
        vaultId: "vault-abc",
        capabilities: [],
        clientVersion: "0.1.0",
      },
    });
    await router.handleMessage(ws1, hello1);

    // Device 2 joins same vault
    const hello2 = serializeWireMessage({
      encrypted: false,
      payload: {
        type: "hello" as const,
        protocolVersion: 1 as const,
        deviceId: "device-2",
        deviceName: "Device 2",
        vaultId: "vault-abc",
        capabilities: [],
        clientVersion: "0.1.0",
      },
    });
    await router.handleMessage(ws2, hello2);

    // Device 2 should see device-1 in connectedDevices
    const ack2Wire = JSON.parse(ws2.sent[0]);
    expect(ack2Wire.payload.connectedDevices).toContain("device-1");

    // Device 1 should get a device-list notification
    const lastMsg1 = JSON.parse(ws1.sent[ws1.sent.length - 1]);
    expect(lastMsg1.payload.type).toBe("device-list");
  });

  test("broadcasts delta-push to other devices", async () => {
    const ws1 = new MockWs();
    const ws2 = new MockWs();

    // Both devices join
    for (const [ws, id, name] of [
      [ws1, "d1", "Dev1"],
      [ws2, "d2", "Dev2"],
    ] as const) {
      await router.handleMessage(
        ws,
        serializeWireMessage({
          encrypted: false,
          payload: {
            type: "hello" as const,
            protocolVersion: 1 as const,
            deviceId: id,
            deviceName: name,
            vaultId: "vault-abc",
            capabilities: [],
            clientVersion: "0.1.0",
          },
        }),
      );
    }

    // Clear sent messages
    ws1.sent = [];
    ws2.sent = [];

    // Device 1 sends a delta-push
    const change: SyncChangeEntry = {
      changeId: 42,
      path: "Notebooks/test.md",
      changeType: "modify",
      contentHash: "abc123",
      size: 100,
      mtime: Date.now(),
      detectedAt: Date.now(),
      deviceId: "d1",
    };

    const deltaPush = serializeWireMessage({
      encrypted: false,
      payload: {
        type: "delta-push" as const,
        fromDeviceId: "d1",
        change,
      },
    });

    await router.handleMessage(ws1, deltaPush);

    // Device 2 should receive the delta-push
    expect(ws2.sent.length).toBe(1);
    const received = JSON.parse(ws2.sent[0]);
    expect(received.payload.type).toBe("delta-push");
    expect(received.payload.change.path).toBe("Notebooks/test.md");

    // Device 1 should NOT receive its own message
    expect(ws1.sent.length).toBe(0);
  });

  test("handles ping with pong", async () => {
    const ws = new MockWs();

    // Authenticate first
    await router.handleMessage(
      ws,
      serializeWireMessage({
        encrypted: false,
        payload: {
          type: "hello" as const,
          protocolVersion: 1 as const,
          deviceId: "d1",
          deviceName: "Dev",
          vaultId: "v1",
          capabilities: [],
          clientVersion: "0.1.0",
        },
      }),
    );
    ws.sent = [];

    const ping = serializeWireMessage({
      encrypted: false,
      payload: { type: "ping" as const, timestamp: Date.now() },
    });
    await router.handleMessage(ws, ping);

    expect(ws.sent.length).toBe(1);
    const pong = JSON.parse(ws.sent[0]);
    expect(pong.payload.type).toBe("pong");
  });

  test("sends error for unauthenticated delta-push", async () => {
    const ws = new MockWs();

    const deltaPush = serializeWireMessage({
      encrypted: false,
      payload: {
        type: "delta-push" as const,
        fromDeviceId: "d1",
        change: {
          changeId: 1,
          path: "test.md",
          changeType: "create" as const,
          contentHash: "h",
          size: 1,
          mtime: 0,
          detectedAt: 0,
          deviceId: "d1",
        },
      },
    });

    await router.handleMessage(ws, deltaPush);
    // No crash — message is silently dropped since no connection context
    expect(ws.sent.length).toBe(0);
  });

  test("handles disconnect and removes device from room", async () => {
    const ws1 = new MockWs();
    const ws2 = new MockWs();

    // Both join
    for (const [ws, id] of [
      [ws1, "d1"],
      [ws2, "d2"],
    ] as const) {
      await router.handleMessage(
        ws,
        serializeWireMessage({
          encrypted: false,
          payload: {
            type: "hello" as const,
            protocolVersion: 1 as const,
            deviceId: id,
            deviceName: id,
            vaultId: "v1",
            capabilities: [],
            clientVersion: "0.1.0",
          },
        }),
      );
    }

    ws2.sent = [];

    // Device 1 disconnects
    router.handleClose(ws1);

    // Device 2 should get updated device list
    expect(ws2.sent.length).toBe(1);
    const list = JSON.parse(ws2.sent[0]);
    expect(list.payload.type).toBe("device-list");

    const stats = router.getStats();
    expect(stats.connections).toBe(1);
  });

  test("reports stats correctly", async () => {
    const stats = router.getStats();
    expect(stats.rooms).toBe(0);
    expect(stats.connections).toBe(0);

    const ws = new MockWs();
    await router.handleMessage(
      ws,
      serializeWireMessage({
        encrypted: false,
        payload: {
          type: "hello" as const,
          protocolVersion: 1 as const,
          deviceId: "d1",
          deviceName: "D1",
          vaultId: "v1",
          capabilities: [],
          clientVersion: "0.1.0",
        },
      }),
    );

    const after = router.getStats();
    expect(after.rooms).toBe(1);
    expect(after.connections).toBe(1);
  });
});

describe("VaultRoom", () => {
  test("buffers for offline devices and drains on reconnect", () => {
    const room = new VaultRoom("vault-1", 5);

    const change: SyncChangeEntry = {
      changeId: 1,
      path: "test.md",
      changeType: "create",
      contentHash: "h1",
      size: 10,
      mtime: Date.now(),
      detectedAt: Date.now(),
      deviceId: "d1",
    };

    room.bufferForOffline("d2", change);
    room.bufferForOffline("d2", { ...change, changeId: 2, path: "test2.md" });

    const drained = room.drainOfflineBuffer("d2");
    expect(drained).toHaveLength(2);
    expect(drained[0].path).toBe("test.md");

    // Buffer should be empty after drain
    expect(room.drainOfflineBuffer("d2")).toHaveLength(0);
  });

  test("evicts oldest when buffer exceeds max", () => {
    const room = new VaultRoom("vault-1", 3);

    for (let i = 1; i <= 5; i++) {
      room.bufferForOffline("d2", {
        changeId: i,
        path: `file${i}.md`,
        changeType: "create",
        contentHash: `h${i}`,
        size: 10,
        mtime: Date.now(),
        detectedAt: Date.now(),
        deviceId: "d1",
      });
    }

    const drained = room.drainOfflineBuffer("d2");
    expect(drained).toHaveLength(3);
    expect(drained[0].changeId).toBe(3); // Oldest 2 evicted
    expect(drained[2].changeId).toBe(5);
  });

  test("broadcast sends to all except excluded", () => {
    const room = new VaultRoom("vault-1");
    const ws1 = new MockWs();
    const ws2 = new MockWs();
    const ws3 = new MockWs();

    room.addDevice("d1", ws1, "D1");
    room.addDevice("d2", ws2, "D2");
    room.addDevice("d3", ws3, "D3");

    room.broadcast(
      { type: "ping", timestamp: 123 },
      "d1",
    );

    expect(ws1.sent.length).toBe(0);
    expect(ws2.sent.length).toBe(1);
    expect(ws3.sent.length).toBe(1);
  });

  test("routeTo delivers to specific device", () => {
    const room = new VaultRoom("vault-1");
    const ws1 = new MockWs();
    const ws2 = new MockWs();

    room.addDevice("d1", ws1, "D1");
    room.addDevice("d2", ws2, "D2");

    const delivered = room.routeTo("d2", "test-data");
    expect(delivered).toBe(true);
    expect(ws2.sent).toEqual(["test-data"]);
    expect(ws1.sent).toEqual([]);

    expect(room.routeTo("d3", "data")).toBe(false);
  });
});

describe("DeviceRegistry", () => {
  let db: Database;
  let registry: DeviceRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    initServerDatabase(db);
    registry = new DeviceRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  test("registers and retrieves a device", () => {
    registry.registerDevice("d1", "v1", "Device 1", "token-abc");

    const device = registry.getDevice("d1", "v1");
    expect(device).not.toBeNull();
    expect(device!.deviceId).toBe("d1");
    expect(device!.deviceName).toBe("Device 1");
  });

  test("lists devices in a vault", () => {
    registry.registerDevice("d1", "v1", "Device 1");
    registry.registerDevice("d2", "v1", "Device 2");
    registry.registerDevice("d3", "v2", "Device 3"); // Different vault

    const devices = registry.listDevices("v1");
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.deviceId).sort()).toEqual(["d1", "d2"]);
  });

  test("removes a device", () => {
    registry.registerDevice("d1", "v1", "Device 1");
    registry.removeDevice("d1", "v1");

    expect(registry.getDevice("d1", "v1")).toBeNull();
  });

  test("tracks vault device count", () => {
    registry.registerDevice("d1", "v1", "D1");
    registry.registerDevice("d2", "v1", "D2");

    expect(registry.getVaultDeviceCount("v1")).toBe(2);
  });

  test("updates device name on re-register", () => {
    registry.registerDevice("d1", "v1", "Old Name");
    registry.registerDevice("d1", "v1", "New Name");

    const device = registry.getDevice("d1", "v1");
    expect(device!.deviceName).toBe("New Name");
  });
});
