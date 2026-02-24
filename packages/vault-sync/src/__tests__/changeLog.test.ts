import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ChangeLog } from "../changeLog";
import { initSyncDatabase } from "../db";

let db: Database;
let log: ChangeLog;

beforeEach(() => {
  db = new Database(":memory:");
  initSyncDatabase(db);
  log = new ChangeLog(db);
});

afterEach(() => {
  db.close();
});

describe("ChangeLog", () => {
  test("appends changes and assigns incremental IDs", () => {
    const id1 = log.append({
      path: "_jobs/pending/job-1.md",
      type: "create",
      contentHash: "abc123",
      size: 100,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "device-1",
    });

    const id2 = log.append({
      path: "_jobs/pending/job-2.md",
      type: "create",
      contentHash: "def456",
      size: 200,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "device-1",
    });

    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(log.count()).toBe(2);
  });

  test("retrieves changes after a cursor position", () => {
    log.append({
      path: "file-1.md",
      type: "create",
      contentHash: "a",
      size: 10,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "scan",
      deviceId: "d1",
    });
    log.append({
      path: "file-2.md",
      type: "modify",
      contentHash: "b",
      size: 20,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d1",
    });
    log.append({
      path: "file-3.md",
      type: "delete",
      contentHash: null,
      size: null,
      mtime: null,
      detectedAt: Date.now(),
      source: "scan",
      deviceId: "d1",
    });

    const afterFirst = log.getChangesAfter(1);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0].path).toBe("file-2.md");
    expect(afterFirst[1].path).toBe("file-3.md");

    const afterSecond = log.getChangesAfter(2);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].type).toBe("delete");
  });

  test("supports consumer cursors for resume", () => {
    log.append({
      path: "a.md",
      type: "create",
      contentHash: "x",
      size: 5,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "api",
      deviceId: "d1",
    });
    log.append({
      path: "b.md",
      type: "create",
      contentHash: "y",
      size: 5,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "api",
      deviceId: "d1",
    });

    // Initial cursor is 0
    expect(log.getCursor("consumer-a")).toBe(0);

    // Update cursor
    log.updateCursor("consumer-a", 1);
    expect(log.getCursor("consumer-a")).toBe(1);

    // Update again
    log.updateCursor("consumer-a", 2);
    expect(log.getCursor("consumer-a")).toBe(2);

    // Different consumer has independent cursor
    expect(log.getCursor("consumer-b")).toBe(0);
  });

  test("getLatestChangeId returns 0 when empty", () => {
    expect(log.getLatestChangeId()).toBe(0);
  });

  test("getLatestChangeId returns highest ID", () => {
    log.append({
      path: "x.md",
      type: "create",
      contentHash: "a",
      size: 1,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d",
    });
    log.append({
      path: "y.md",
      type: "modify",
      contentHash: "b",
      size: 2,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d",
    });
    expect(log.getLatestChangeId()).toBe(2);
  });

  test("compact removes old changes", () => {
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    log.append({
      path: "old.md",
      type: "create",
      contentHash: "a",
      size: 1,
      mtime: oldTime,
      detectedAt: oldTime,
      source: "scan",
      deviceId: "d",
    });
    log.append({
      path: "new.md",
      type: "create",
      contentHash: "b",
      size: 2,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "scan",
      deviceId: "d",
    });

    const removed = log.compact(7);
    expect(removed).toBe(1);
    expect(log.count()).toBe(1);
  });

  test("preserves rename oldPath", () => {
    log.append({
      path: "_jobs/running/job-1.md",
      oldPath: "_jobs/pending/job-1.md",
      type: "rename",
      contentHash: "abc",
      size: 100,
      mtime: Date.now(),
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: "d1",
    });

    const changes = log.getChangesAfter(0);
    expect(changes[0].oldPath).toBe("_jobs/pending/job-1.md");
    expect(changes[0].type).toBe("rename");
  });
});
