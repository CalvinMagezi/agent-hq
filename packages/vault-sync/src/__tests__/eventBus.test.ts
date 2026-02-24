import { describe, test, expect, beforeEach } from "bun:test";
import { EventBus } from "../eventBus";
import type { FileChange, VaultEvent, VaultEventType } from "../types";

let bus: EventBus;

beforeEach(() => {
  bus = new EventBus();
});

describe("EventBus", () => {
  test("emits events to type-specific handlers", async () => {
    const received: VaultEvent[] = [];
    bus.on("job:created", (e) => { received.push(e); });

    await bus.emit({
      type: "job:created",
      path: "_jobs/pending/job-1.md",
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("job:created");
  });

  test("wildcard handler receives all events", async () => {
    const received: VaultEvent[] = [];
    bus.on("*", (e) => { received.push(e); });

    await bus.emit({ type: "job:created", path: "a.md", timestamp: Date.now() });
    await bus.emit({ type: "note:modified", path: "b.md", timestamp: Date.now() });

    expect(received).toHaveLength(2);
  });

  test("unsubscribe stops delivery", async () => {
    const received: VaultEvent[] = [];
    const unsub = bus.on("job:created", (e) => { received.push(e); });

    await bus.emit({ type: "job:created", path: "a.md", timestamp: Date.now() });
    unsub();
    await bus.emit({ type: "job:created", path: "b.md", timestamp: Date.now() });

    expect(received).toHaveLength(1);
  });

  test("filter-based subscription by event type", async () => {
    const received: VaultEvent[] = [];
    bus.subscribe(
      { eventTypes: ["note:created", "note:modified"] },
      (e) => { received.push(e); },
    );

    await bus.emit({ type: "note:created", path: "a.md", timestamp: Date.now() });
    await bus.emit({ type: "job:created", path: "b.md", timestamp: Date.now() });
    await bus.emit({ type: "note:modified", path: "c.md", timestamp: Date.now() });

    expect(received).toHaveLength(2);
  });

  test("filter-based subscription by directory", async () => {
    const received: VaultEvent[] = [];
    bus.subscribe(
      { directories: ["_jobs/", "_delegation/"] },
      (e) => { received.push(e); },
    );

    await bus.emit({ type: "job:created", path: "_jobs/pending/j.md", timestamp: Date.now() });
    await bus.emit({ type: "note:created", path: "Notebooks/n.md", timestamp: Date.now() });
    await bus.emit({ type: "task:created", path: "_delegation/pending/t.md", timestamp: Date.now() });

    expect(received).toHaveLength(2);
  });

  test("handler errors are isolated", async () => {
    const received: string[] = [];

    bus.on("job:created", () => { throw new Error("boom"); });
    bus.on("job:created", (e) => { received.push(e.path); });

    await bus.emit({ type: "job:created", path: "test.md", timestamp: Date.now() });

    // Second handler still runs despite first one throwing
    expect(received).toHaveLength(1);
  });

  test("classifyChange maps job:created correctly", () => {
    const change: FileChange = {
      changeId: 1,
      path: "_jobs/pending/job-123.md",
      type: "create",
      contentHash: "abc",
      size: 100,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d1",
    };

    const event = bus.classifyChange(change);
    expect(event.type).toBe("job:created");
  });

  test("classifyChange maps job:claimed from running/ create", () => {
    const change: FileChange = {
      changeId: 2,
      path: "_jobs/running/job-123.md",
      type: "create",
      contentHash: "abc",
      size: 100,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d1",
    };

    const event = bus.classifyChange(change);
    expect(event.type).toBe("job:claimed");
  });

  test("classifyChange maps task:created", () => {
    const change: FileChange = {
      changeId: 3,
      path: "_delegation/pending/task-1.md",
      type: "create",
      contentHash: "xyz",
      size: 50,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d1",
    };

    const event = bus.classifyChange(change);
    expect(event.type).toBe("task:created");
  });

  test("classifyChange maps system:modified", () => {
    const change: FileChange = {
      changeId: 4,
      path: "_system/HEARTBEAT.md",
      type: "modify",
      contentHash: "def",
      size: 200,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d1",
    };

    const event = bus.classifyChange(change);
    expect(event.type).toBe("system:modified");
  });

  test("classifyChange maps note:created", () => {
    const change: FileChange = {
      changeId: 5,
      path: "Notebooks/Projects/test.md",
      type: "create",
      contentHash: "ghi",
      size: 300,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "scan",
      deviceId: "d1",
    };

    const event = bus.classifyChange(change);
    expect(event.type).toBe("note:created");
  });

  test("classifyChange maps approval:created", () => {
    const change: FileChange = {
      changeId: 6,
      path: "_approvals/pending/approval-1.md",
      type: "create",
      contentHash: "jkl",
      size: 150,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d1",
    };

    const event = bus.classifyChange(change);
    expect(event.type).toBe("approval:created");
  });

  test("classifyChange falls back to generic file events", () => {
    const change: FileChange = {
      changeId: 7,
      path: "_logs/2026-02-24/log.md",
      type: "create",
      contentHash: "mno",
      size: 50,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d1",
    };

    const event = bus.classifyChange(change);
    expect(event.type).toBe("file:created");
  });

  test("subscriberCount tracks active subscriptions", () => {
    expect(bus.subscriberCount).toBe(0);

    const unsub1 = bus.on("job:created", () => {});
    const unsub2 = bus.on("*", () => {});
    bus.subscribe({ eventTypes: ["note:created"] }, () => {});

    expect(bus.subscriberCount).toBe(3);

    unsub1();
    expect(bus.subscriberCount).toBe(2);
  });

  test("clear removes all subscriptions", () => {
    bus.on("job:created", () => {});
    bus.on("*", () => {});
    bus.subscribe({}, () => {});

    expect(bus.subscriberCount).toBe(3);
    bus.clear();
    expect(bus.subscriberCount).toBe(0);
  });
});
