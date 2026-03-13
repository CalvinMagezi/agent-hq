import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { openMemoryDB, storeMemory, storeDeltaSummary, type Memory } from "../db.js";
import { MemoryQuerier } from "../querier.js";
import type { Database } from "bun:sqlite";

let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "querier-test-"));
  db = openMemoryDB(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert a memory with specific topics, returning its id */
function insertMemory(opts: {
  summary: string;
  topics: string[];
  importance?: number;
  delta_summary?: string | null;
}): number {
  const id = storeMemory(db, {
    source: "test",
    harness: "test",
    raw_text: opts.summary,
    summary: opts.summary,
    entities: [],
    topics: opts.topics,
    importance: opts.importance ?? 0.8,
  });
  if (opts.delta_summary !== undefined && opts.delta_summary !== null) {
    storeDeltaSummary(db, id, opts.delta_summary);
  }
  return id;
}

describe("MemoryQuerier — differential pattern separation", () => {
  test("includes overlapping memory when delta_summary is cached", () => {
    // Memory A: high importance, 3 overlapping topics
    insertMemory({
      summary: "Server crashed due to SSH key breach",
      topics: ["security", "server", "crash", "ssh"],
      importance: 0.9,
    });

    // Memory B: lower importance, 3+ overlapping topics, but has cached delta
    insertMemory({
      summary: "Server crashed due to power supply failure",
      topics: ["security", "server", "crash", "hardware"],
      importance: 0.7,
      delta_summary: "Power supply failure caused the crash, not a security breach",
    });

    const querier = new MemoryQuerier(db);
    const ctx = querier.getRecentContext({ limit: 8 });

    // Both should appear — the second uses its delta summary
    expect(ctx.memories.length).toBe(2);
    const summaries = ctx.memories.map((m) => m.summary);
    expect(summaries).toContain("Server crashed due to SSH key breach");
    expect(summaries).toContain("Power supply failure caused the crash, not a security breach");
  });

  test("skips overlapping memory without delta and queues for extraction", () => {
    insertMemory({
      summary: "Deployed new auth middleware",
      topics: ["auth", "middleware", "deployment"],
      importance: 0.9,
    });

    const id2 = insertMemory({
      summary: "Auth middleware rollback after timeout",
      topics: ["auth", "middleware", "deployment", "rollback"],
      importance: 0.7,
      // No delta_summary — will be queued
    });

    const querier = new MemoryQuerier(db);
    const ctx = querier.getRecentContext({ limit: 8 });

    // Only the first should appear (second is skipped, queued)
    expect(ctx.memories.length).toBe(1);
    expect(ctx.memories[0].summary).toBe("Deployed new auth middleware");
  });

  test("skips overlapping memory when delta_summary is empty string", () => {
    insertMemory({
      summary: "Fixed login bug in production",
      topics: ["login", "bugfix", "production"],
      importance: 0.9,
    });

    insertMemory({
      summary: "Fixed login bug in staging", // Checked, nothing unique
      topics: ["login", "bugfix", "production"],
      importance: 0.7,
      delta_summary: "", // Empty = checked, no unique info
    });

    const querier = new MemoryQuerier(db);
    const ctx = querier.getRecentContext({ limit: 8 });

    // Only the first should appear
    expect(ctx.memories.length).toBe(1);
    expect(ctx.memories[0].summary).toBe("Fixed login bug in production");
  });

  test("allows non-overlapping memories through normally", () => {
    insertMemory({
      summary: "Set up CI pipeline",
      topics: ["ci", "devops", "automation"],
      importance: 0.8,
    });

    insertMemory({
      summary: "Reviewed quarterly financials",
      topics: ["finance", "review", "quarterly"],
      importance: 0.7,
    });

    const querier = new MemoryQuerier(db);
    const ctx = querier.getRecentContext({ limit: 8 });

    expect(ctx.memories.length).toBe(2);
  });

  test("high-salience memories always survive deduplication", () => {
    insertMemory({
      summary: "Critical security breach detected",
      topics: ["security", "server", "crash", "high-salience"],
      importance: 0.95,
    });

    insertMemory({
      summary: "Minor security audit",
      topics: ["security", "server", "crash", "audit"],
      importance: 0.6,
      // No delta — would normally be queued, but the existing is high-salience
    });

    const querier = new MemoryQuerier(db);
    const ctx = querier.getRecentContext({ limit: 8 });

    // High-salience always included; second may be queued since it overlaps
    expect(ctx.memories.length).toBeGreaterThanOrEqual(1);
    expect(ctx.memories[0].summary).toBe("Critical security breach detected");
  });
});
