import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SyncState } from "../syncState";
import { initSyncDatabase } from "../db";

let db: Database;
let state: SyncState;

beforeEach(() => {
  db = new Database(":memory:");
  initSyncDatabase(db);
  state = new SyncState(db, "test-device");
});

afterEach(() => {
  db.close();
});

describe("SyncState", () => {
  test("records and retrieves file versions", () => {
    const version = state.recordVersion(
      "Notebooks/Projects/test.md",
      "hash123",
      500,
      Date.now(),
    );

    expect(version).toBe(1);

    const fileState = state.getFileState("Notebooks/Projects/test.md");
    expect(fileState).not.toBeNull();
    expect(fileState!.contentHash).toBe("hash123");
    expect(fileState!.size).toBe(500);
    expect(fileState!.version).toBe(1);
    expect(fileState!.deviceId).toBe("test-device");
  });

  test("increments version on subsequent updates", () => {
    state.recordVersion("note.md", "hash-v1", 100, 1000);
    const v2 = state.recordVersion("note.md", "hash-v2", 150, 2000);
    const v3 = state.recordVersion("note.md", "hash-v3", 200, 3000);

    expect(v2).toBe(2);
    expect(v3).toBe(3);

    const current = state.getFileState("note.md");
    expect(current!.contentHash).toBe("hash-v3");
    expect(current!.version).toBe(3);
  });

  test("returns null for unknown files", () => {
    expect(state.getFileState("nonexistent.md")).toBeNull();
  });

  test("removes file state on delete", () => {
    state.recordVersion("deleteme.md", "hash", 10, Date.now());
    expect(state.getFileState("deleteme.md")).not.toBeNull();

    state.removeFile("deleteme.md");
    expect(state.getFileState("deleteme.md")).toBeNull();
  });

  test("handles renames correctly", () => {
    state.recordVersion("_jobs/pending/job-1.md", "hash-1", 100, Date.now());
    state.handleRename("_jobs/pending/job-1.md", "_jobs/running/job-1.md");

    expect(state.getFileState("_jobs/pending/job-1.md")).toBeNull();
    const renamed = state.getFileState("_jobs/running/job-1.md");
    expect(renamed).not.toBeNull();
    expect(renamed!.contentHash).toBe("hash-1");
  });

  test("getAllPaths returns all tracked paths", () => {
    state.recordVersion("a.md", "h1", 10, Date.now());
    state.recordVersion("b.md", "h2", 20, Date.now());
    state.recordVersion("c.md", "h3", 30, Date.now());

    const paths = state.getAllPaths();
    expect(paths.size).toBe(3);
    expect(paths.has("a.md")).toBe(true);
    expect(paths.has("b.md")).toBe(true);
    expect(paths.has("c.md")).toBe(true);
  });

  test("hasChanged detects new files", () => {
    expect(state.hasChanged("new-file.md", Date.now(), 100)).toBe(true);
  });

  test("hasChanged detects mtime changes", () => {
    state.recordVersion("file.md", "hash", 100, 1000);
    expect(state.hasChanged("file.md", 2000, 100)).toBe(true);
  });

  test("hasChanged detects size changes", () => {
    state.recordVersion("file.md", "hash", 100, 1000);
    expect(state.hasChanged("file.md", 1000, 200)).toBe(true);
  });

  test("hasChanged returns false when unchanged", () => {
    state.recordVersion("file.md", "hash", 100, 1000);
    expect(state.hasChanged("file.md", 1000, 100)).toBe(false);
  });

  test("getVersionHistory returns versions in reverse order", () => {
    state.recordVersion("file.md", "v1", 100, 1000);
    state.recordVersion("file.md", "v2", 150, 2000);
    state.recordVersion("file.md", "v3", 200, 3000);

    const history = state.getVersionHistory("file.md");
    expect(history).toHaveLength(3);
    expect(history[0].version).toBe(3);
    expect(history[1].version).toBe(2);
    expect(history[2].version).toBe(1);
  });

  test("count tracks number of files", () => {
    expect(state.count()).toBe(0);
    state.recordVersion("a.md", "h", 10, Date.now());
    state.recordVersion("b.md", "h", 10, Date.now());
    expect(state.count()).toBe(2);
    state.removeFile("a.md");
    expect(state.count()).toBe(1);
  });
});
