import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { AwakeReplayEngine } from "../awakeReplay.js";
import { openMemoryDB, storeMemory, Memory } from "../db.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("AwakeReplayEngine", () => {
  let db: Database;
  let engine: AwakeReplayEngine;
  let tempVault: string;

  beforeEach(() => {
    tempVault = path.join(os.tmpdir(), `vault-memory-test-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tempVault, { recursive: true });
    
    // We'll use a real DB file in temp vault because openMemoryDB expects a path
    db = openMemoryDB(tempVault);
    engine = new AwakeReplayEngine(db, tempVault);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempVault, { recursive: true, force: true });
  });

  it("should perform reverse replay and boost importance", async () => {
    // 1. Setup: ingest some memories
    const id1 = storeMemory(db, {
      source: "job-123",
      harness: "test",
      raw_text: "doing step 1",
      summary: "step 1 summary",
      entities: ["NodeJS"],
      topics: ["coding"],
      importance: 0.5
    });

    const id2 = storeMemory(db, {
      source: "job-123",
      harness: "test",
      raw_text: "doing step 2",
      summary: "step 2 summary",
      entities: ["Bun"],
      topics: ["coding"],
      importance: 0.5
    });

    // 2. Trigger reverse replay
    const result = await engine.reverseReplay({
      triggerRef: "123",
      triggerSource: "job:status-changed"
    });

    expect(result.replayedCount).toBe(2);
    expect(result.creditDelta).toBeGreaterThan(0.05);

    // 3. Verify DB updates
    const m1 = db.prepare("SELECT * FROM memories WHERE id = ?").get(id1) as any;
    const m2 = db.prepare("SELECT * FROM memories WHERE id = ?").get(id2) as any;

    expect(m1.importance).toBeGreaterThan(0.5);
    expect(m1.replay_count).toBe(1);
    expect(m2.importance).toBeGreaterThan(0.5);
    expect(m2.replay_count).toBe(1);

    // 4. Verify replay record
    const replay = db.prepare("SELECT * FROM replays").get() as any;
    expect(replay.trigger_type).toBe("reverse");
    expect(replay.trigger_ref).toBe("123");
    expect(JSON.parse(replay.memory_ids)).toContain(id1);
    expect(JSON.parse(replay.memory_ids)).toContain(id2);
  });

  it("should perform forward replay and find precedents", async () => {
    // 1. Setup: ingest a background memory
    const id1 = storeMemory(db, {
      source: "previous-job",
      harness: "test",
      raw_text: "important info about TypeScript",
      summary: "TS details",
      entities: ["TypeScript"],
      topics: ["coding"],
      importance: 0.8
    });

    // 2. Trigger forward replay with matching cues
    const result = await engine.forwardReplay({
      triggerRef: "job-456",
      triggerSource: "job:created",
      instructionText: "I need to write some TypeScript code"
    });

    expect(result.replayedCount).toBe(1);
    expect(result.precedents[0].id).toBe(id1);

    // 3. Verify bookmarking
    const m1 = db.prepare("SELECT * FROM memories WHERE id = ?").get(id1) as any;
    expect(m1.replay_count).toBe(1);

    // 4. Verify replay record
    const replay = db.prepare("SELECT * FROM replays").get() as any;
    expect(replay.trigger_type).toBe("forward");
    expect(replay.trigger_ref).toBe("job-456");
  });

  it("should extract cues accurately", () => {
    const text = 'Help me with "Project X" and @calvin regarding TypeScript and #deployment. Use "Bun"';
    const cues = (engine as any).extractCues(text);

    expect(cues.entities).toContain("Project X");
    expect(cues.entities).toContain("calvin");
    expect(cues.entities).toContain("TypeScript");
    expect(cues.entities).toContain("Bun");
    expect(cues.topics).toContain("deployment");
  });
});
