import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { openMemoryDB, storeMemory, storeConsolidation, type Memory } from "../db.js";
import { MemoryForgetter } from "../forgetter.js";
import type { Database } from "bun:sqlite";

let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgetter-test-"));
  db = openMemoryDB(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert a memory with a specific created_at date (days ago) */
function insertOldMemory(opts: {
  summary: string;
  importance: number;
  daysAgo: number;
  consolidated?: boolean;
}): number {
  const createdAt = new Date(Date.now() - opts.daysAgo * 86400_000).toISOString();
  const result = db.prepare(`
    INSERT INTO memories (source, harness, raw_text, summary, entities, topics, importance, consolidated, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("test", "test", opts.summary, opts.summary, "[]", "[]", opts.importance, opts.consolidated ? 1 : 0, createdAt);
  return result.lastInsertRowid as number;
}

function getImportance(id: number): number {
  const row = db.prepare("SELECT importance FROM memories WHERE id = ?").get(id) as any;
  return row?.importance ?? -1;
}

function memoryExists(id: number): boolean {
  const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(id);
  return row !== null;
}

describe("MemoryForgetter — tiered decay", () => {
  test("unconsolidated memories decay at standard rate (1.5%/day)", () => {
    const id = insertOldMemory({
      summary: "Some old unconsolidated memory",
      importance: 0.5,
      daysAgo: 10,
    });

    const forgetter = new MemoryForgetter(db, tmpDir);
    forgetter.runCycle();

    const newImportance = getImportance(id);
    // 0.5 - 0.015 = 0.485
    expect(newImportance).toBeCloseTo(0.485, 3);
  });

  test("consolidated memories with low vault links decay at accelerated rate (5%/day)", () => {
    const id = insertOldMemory({
      summary: "Consolidated but not well-linked",
      importance: 0.5,
      daysAgo: 10,
      consolidated: true,
    });

    // Create a consolidation record referencing this memory
    const consolidatedAt = new Date(Date.now() - 5 * 86400_000).toISOString();
    db.prepare(`
      INSERT INTO consolidations (source_ids, insight, connections, created_at)
      VALUES (?, ?, ?, ?)
    `).run(JSON.stringify([id]), "Some insight", "[]", consolidatedAt);

    // No insight note in vault = 0 backlinks = low link tier

    const forgetter = new MemoryForgetter(db, tmpDir);
    forgetter.runCycle();

    const newImportance = getImportance(id);
    // Standard decay (1.5%) does NOT apply since consolidated=1
    // Accelerated decay: 0.5 - 0.05 = 0.45
    expect(newImportance).toBeCloseTo(0.45, 3);
  });

  test("consolidated memories with high vault links decay at protected rate (0.5%/day)", () => {
    const id = insertOldMemory({
      summary: "Well-connected schema anchor",
      importance: 0.5,
      daysAgo: 10,
      consolidated: true,
    });

    // Create consolidation record
    const date = new Date(Date.now() - 5 * 86400_000);
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, "-");
    const consolidatedAt = date.toISOString();

    db.prepare(`
      INSERT INTO consolidations (source_ids, insight, connections, created_at)
      VALUES (?, ?, ?, ?)
    `).run(JSON.stringify([id]), "Important insight", "[]", consolidatedAt);

    // Create the insight note in the vault
    const notesDir = path.join(tmpDir, "Notebooks", "Memories");
    fs.mkdirSync(notesDir, { recursive: true });
    const noteFilename = `${dateStr}-${timeStr}-insight.md`;
    fs.writeFileSync(path.join(notesDir, noteFilename), "---\nnoteType: consolidation-insight\n---\n# Insight\nSome important insight\n");

    // Create 3+ notes that link TO the insight note (backlinks)
    const projectsDir = path.join(tmpDir, "Notebooks", "Projects");
    fs.mkdirSync(projectsDir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(
        path.join(projectsDir, `project-${i}.md`),
        `---\ntags: []\n---\n# Project ${i}\nRelated: [[Notebooks/Memories/${noteFilename}]]\n`
      );
    }

    const forgetter = new MemoryForgetter(db, tmpDir);
    forgetter.runCycle();

    const newImportance = getImportance(id);
    // Protected decay: 0.5 - 0.005 = 0.495
    expect(newImportance).toBeCloseTo(0.495, 3);
  });

  test("pruning threshold unchanged — removes memories below 0.05 after 60 days", () => {
    const id = insertOldMemory({
      summary: "Very old, very weak memory",
      importance: 0.04,
      daysAgo: 65,
    });

    const forgetter = new MemoryForgetter(db, tmpDir);
    forgetter.runCycle();

    expect(memoryExists(id)).toBe(false);
  });

  test("access-count protection still works for unconsolidated memories", () => {
    const id = insertOldMemory({
      summary: "Frequently accessed memory",
      importance: 0.3,
      daysAgo: 20,
    });

    // Bump access count
    db.prepare("UPDATE memories SET access_count = 5 WHERE id = ?").run(id);

    const forgetter = new MemoryForgetter(db, tmpDir);
    forgetter.runCycle();

    const newImportance = getImportance(id);
    // Standard decay: 0.3 - 0.015 = 0.285
    // Access restore: 0.285 + 0.0075 = 0.2925
    expect(newImportance).toBeCloseTo(0.2925, 3);
  });

  test("returns correct stats", () => {
    insertOldMemory({ summary: "m1", importance: 0.5, daysAgo: 10 });
    insertOldMemory({ summary: "m2", importance: 0.04, daysAgo: 65 });

    const forgetter = new MemoryForgetter(db, tmpDir);
    const result = forgetter.runCycle();

    expect(result.decayed).toBeGreaterThanOrEqual(1);
    expect(result.pruned).toBe(1);
    expect(result.statsAfter.total).toBe(1); // m2 was pruned
  });
});
