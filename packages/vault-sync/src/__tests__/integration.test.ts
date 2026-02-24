import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { VaultSync } from "../index";
import type { VaultEvent } from "../types";
import { createTempVault, writeMd, sleep } from "./helpers";

let vaultPath: string;
let cleanup: () => void;
let sync: VaultSync;

beforeEach(() => {
  const tmp = createTempVault();
  vaultPath = tmp.vaultPath;
  cleanup = tmp.cleanup;
});

afterEach(async () => {
  if (sync?.isRunning) {
    await sync.stop();
  }
  cleanup();
});

describe("VaultSync integration", () => {
  test("initial scan detects existing files", async () => {
    // Write a file before starting sync
    writeMd(
      path.join(vaultPath, "Notebooks", "Projects", "test.md"),
      { noteType: "note", tags: ["test"] },
      "Test content",
    );

    sync = new VaultSync({
      vaultPath,
      debounceMs: 50,
      stabilityMs: 100,
      fullScanIntervalMs: 60_000_000, // Effectively disabled
    });

    const scanEvents: VaultEvent[] = [];
    sync.on("scan:completed", (e) => { scanEvents.push(e); });

    await sync.start();

    // Should have scanned and found files
    expect(sync.syncState.count()).toBeGreaterThan(0);
    expect(scanEvents).toHaveLength(1);
  });

  test("changeLog persists changes from initial scan", async () => {
    writeMd(
      path.join(vaultPath, "Notebooks", "Memory", "note.md"),
      { noteType: "note" },
      "Memory note",
    );

    sync = new VaultSync({
      vaultPath,
      debounceMs: 50,
      stabilityMs: 100,
      fullScanIntervalMs: 60_000_000,
    });

    await sync.start();

    // ChangeLog should have entries
    const changes = sync.changeLog.getChangesAfter(0);
    expect(changes.length).toBeGreaterThan(0);

    // At least one should be the note we created
    const noteChange = changes.find((c) =>
      c.path.includes("Notebooks/Memory/note.md"),
    );
    expect(noteChange).toBeDefined();
    expect(noteChange!.type).toBe("create");
  });

  test("event subscriptions fire for classified events", async () => {
    sync = new VaultSync({
      vaultPath,
      debounceMs: 50,
      stabilityMs: 100,
      fullScanIntervalMs: 60_000_000,
    });

    const noteEvents: VaultEvent[] = [];
    sync.on("note:created", (e) => { noteEvents.push(e); });

    // Write a note before starting (will be detected on initial scan)
    writeMd(
      path.join(vaultPath, "Notebooks", "Projects", "project.md"),
      { noteType: "note", pinned: true },
      "Project description",
    );

    await sync.start();

    expect(noteEvents.length).toBeGreaterThanOrEqual(1);
    expect(noteEvents[0].type).toBe("note:created");
    expect(noteEvents[0].path).toContain("Notebooks/Projects/project.md");
  });

  test("system file modifications are classified correctly", async () => {
    sync = new VaultSync({
      vaultPath,
      debounceMs: 50,
      stabilityMs: 100,
      fullScanIntervalMs: 60_000_000,
    });

    await sync.start();

    // Trigger a manual scan after modifying a system file
    const soulPath = path.join(vaultPath, "_system", "SOUL.md");
    fs.writeFileSync(soulPath, "---\ntype: system\n---\nUpdated soul content\n");

    const systemEvents: VaultEvent[] = [];
    sync.on("system:modified", (e) => { systemEvents.push(e); });

    await sync.triggerScan();

    expect(systemEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("watcher detects new files", async () => {
    sync = new VaultSync({
      vaultPath,
      debounceMs: 50,
      stabilityMs: 200,
      fullScanIntervalMs: 60_000_000,
    });

    await sync.start();

    const events: VaultEvent[] = [];
    sync.on("*", (e) => { events.push(e); });

    // Write a new file after sync started
    writeMd(
      path.join(vaultPath, "Notebooks", "Projects", "new-project.md"),
      { noteType: "note" },
      "New project content",
    );

    // Wait for debounce + stability
    await sleep(600);

    // Should detect the new file
    const noteEvent = events.find(
      (e) => e.path.includes("new-project.md"),
    );
    expect(noteEvent).toBeDefined();
  });

  test("lockManager prevents concurrent writes", async () => {
    sync = new VaultSync({
      vaultPath,
      debounceMs: 50,
      stabilityMs: 100,
      fullScanIntervalMs: 60_000_000,
    });

    await sync.start();

    const results: string[] = [];

    // Acquire lock and hold it
    const acquired = sync.lockManager.acquire("test-file.md");
    expect(acquired).toBe(true);

    // Try to acquire from "another process" (same manager but simulates contention)
    const db = (sync as any).db;
    const { LockManager } = await import("../lockManager");
    const otherManager = new LockManager(db, "other-process");
    const otherAcquired = otherManager.acquire("test-file.md");
    expect(otherAcquired).toBe(false);

    sync.lockManager.release("test-file.md");
    const nowAcquired = otherManager.acquire("test-file.md");
    expect(nowAcquired).toBe(true);
  });

  test("triggerScan detects offline changes", async () => {
    sync = new VaultSync({
      vaultPath,
      debounceMs: 50,
      stabilityMs: 100,
      fullScanIntervalMs: 60_000_000,
    });

    await sync.start();

    // Simulate "offline" change by writing directly to disk
    writeMd(
      path.join(vaultPath, "Notebooks", "Memory", "offline-note.md"),
      { noteType: "note" },
      "Written while sync was busy",
    );

    const changes = await sync.triggerScan();
    expect(changes).toBeGreaterThanOrEqual(1);

    const state = sync.syncState.getFileState(
      "Notebooks/Memory/offline-note.md",
    );
    expect(state).not.toBeNull();
  });

  test("version history is maintained", async () => {
    const notePath = path.join(vaultPath, "Notebooks", "Projects", "versioned.md");

    // Write version 1 before starting sync
    writeMd(notePath, { noteType: "note", v: 1 }, "Version 1 content here");

    sync = new VaultSync({
      vaultPath,
      debounceMs: 50,
      stabilityMs: 100,
      fullScanIntervalMs: 60_000_000,
    });

    await sync.start();

    // Initial scan should have picked up version 1
    const v1State = sync.syncState.getFileState("Notebooks/Projects/versioned.md");
    expect(v1State).not.toBeNull();
    expect(v1State!.version).toBe(1);

    // Now modify the file (different content = different hash)
    await sleep(50); // Ensure different mtime
    writeMd(notePath, { noteType: "note", v: 2 }, "Version 2 content which is different");
    await sync.triggerScan();

    // Check version history
    const history = sync.syncState.getVersionHistory(
      "Notebooks/Projects/versioned.md",
    );
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].version).toBeGreaterThan(history[1].version);
  });
});
