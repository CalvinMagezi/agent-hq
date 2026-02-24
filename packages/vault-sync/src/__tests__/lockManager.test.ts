import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { LockManager } from "../lockManager";
import { initSyncDatabase } from "../db";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSyncDatabase(db);
});

afterEach(() => {
  db.close();
});

describe("LockManager", () => {
  test("acquires and releases locks", () => {
    const mgr = new LockManager(db, "holder-1");

    expect(mgr.acquire("file.md")).toBe(true);
    expect(mgr.isLocked("file.md")).not.toBeNull();

    mgr.release("file.md");
    expect(mgr.isLocked("file.md")).toBeNull();
  });

  test("prevents concurrent acquisition by different holders", () => {
    const mgr1 = new LockManager(db, "holder-1");
    const mgr2 = new LockManager(db, "holder-2");

    expect(mgr1.acquire("file.md")).toBe(true);
    expect(mgr2.acquire("file.md")).toBe(false);

    mgr1.release("file.md");
    expect(mgr2.acquire("file.md")).toBe(true);
  });

  test("same holder can re-acquire their own lock", () => {
    const mgr = new LockManager(db, "holder-1");

    expect(mgr.acquire("file.md")).toBe(true);
    expect(mgr.acquire("file.md")).toBe(true);
  });

  test("expired locks can be acquired by others", () => {
    const mgr1 = new LockManager(db, "holder-1");
    const mgr2 = new LockManager(db, "holder-2");

    // Acquire with very short TTL
    expect(mgr1.acquire("file.md", 1)).toBe(true);

    // Manually expire the lock by setting expires_at in the past
    db.prepare(
      "UPDATE locks SET expires_at = $past WHERE path = 'file.md'",
    ).run({ $past: Date.now() - 1000 });

    // Now holder-2 should be able to acquire
    expect(mgr2.acquire("file.md")).toBe(true);
  });

  test("withLock executes callback and releases", async () => {
    const mgr = new LockManager(db, "holder-1");
    let executed = false;

    await mgr.withLock("file.md", async () => {
      executed = true;
      expect(mgr.isLocked("file.md")).not.toBeNull();
    });

    expect(executed).toBe(true);
    expect(mgr.isLocked("file.md")).toBeNull();
  });

  test("withLock releases on error", async () => {
    const mgr = new LockManager(db, "holder-1");

    try {
      await mgr.withLock("file.md", () => {
        throw new Error("test error");
      });
    } catch {
      // Expected
    }

    expect(mgr.isLocked("file.md")).toBeNull();
  });

  test("withLock throws when lock is held by another", async () => {
    const mgr1 = new LockManager(db, "holder-1");
    const mgr2 = new LockManager(db, "holder-2");

    mgr1.acquire("file.md");

    expect(
      mgr2.withLock("file.md", async () => {}),
    ).rejects.toThrow("Failed to acquire lock");
  });

  test("cleanupExpired removes stale locks", () => {
    const mgr = new LockManager(db, "holder-1");

    mgr.acquire("a.md", 1);
    mgr.acquire("b.md", 1);

    // Manually expire
    db.prepare("UPDATE locks SET expires_at = $past").run({
      $past: Date.now() - 1000,
    });

    const removed = mgr.cleanupExpired();
    expect(removed).toBe(2);
    expect(mgr.getActiveLocks()).toHaveLength(0);
  });

  test("getActiveLocks returns only unexpired locks", () => {
    const mgr = new LockManager(db, "holder-1");

    mgr.acquire("a.md", 60000);
    mgr.acquire("b.md", 60000);

    const active = mgr.getActiveLocks();
    expect(active).toHaveLength(2);
    expect(active.map((l) => l.path).sort()).toEqual(["a.md", "b.md"]);
  });
});
