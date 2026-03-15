import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Database } from "bun:sqlite";
import {
  openPlanDB,
  upsertPlan,
  getPlan,
  addQuestion,
  answerQuestion,
  getPendingQuestions,
  searchPlans,
  searchPatterns,
  upsertPattern,
  upsertCodemapEntry,
  getCodemapForProject,
  upsertConvention,
  getConventionsForProject,
  addPlanAsset,
  getPlanAssets,
  removePlanAsset
} from "../planDB.js";
import { CodemapEngine } from "../codemap.js";
import { PlanKnowledgeEngine } from "../planKnowledge.js";

let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plandb-test-"));
  db = openPlanDB(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Plan CRUD ─────────────────────────────────────────────────────────

describe("Plan CRUD", () => {
  test("upsertPlan creates a new plan", () => {
    upsertPlan(db, {
      id: "plan-test-001",
      project: "agent-hq",
      title: "Test plan",
      status: "planning",
      instruction: "Build a widget",
    });

    const plan = getPlan(db, "plan-test-001");
    expect(plan).not.toBeNull();
    expect(plan!.project).toBe("agent-hq");
    expect(plan!.title).toBe("Test plan");
    expect(plan!.status).toBe("planning");
    expect(plan!.instruction).toBe("Build a widget");
    expect(plan!.phases).toEqual([]);
    expect(plan!.files_touched).toEqual([]);
  });

  test("upsertPlan updates existing plan", () => {
    upsertPlan(db, {
      id: "plan-test-002",
      project: "test",
      title: "Original",
      instruction: "Do thing",
    });

    upsertPlan(db, {
      id: "plan-test-002",
      status: "completed",
      outcome: "It worked",
    });

    const plan = getPlan(db, "plan-test-002");
    expect(plan!.status).toBe("completed");
    expect(plan!.outcome).toBe("It worked");
    expect(plan!.title).toBe("Original"); // unchanged
  });

  test("getPlan returns null for missing plan", () => {
    expect(getPlan(db, "nonexistent")).toBeNull();
  });

  test("phases are stored as JSON array", () => {
    upsertPlan(db, {
      id: "plan-phases",
      project: "test",
      title: "Phased plan",
      instruction: "Multi-step",
      phases: [
        { phaseId: "explore", title: "Explore codebase", harness: "claude-code", role: "researcher", status: "pending" as const },
        { phaseId: "implement", title: "Write code", harness: "claude-code", role: "coder", status: "pending" as const },
      ],
    });

    const plan = getPlan(db, "plan-phases");
    expect(plan!.phases).toHaveLength(2);
    expect(plan!.phases[0].phaseId).toBe("explore");
    expect(plan!.phases[1].role).toBe("coder");
  });

  test("planning_mode and ambiguity_signals are stored", () => {
    upsertPlan(db, {
      id: "plan-multi-modal",
      project: "test",
      title: "MM Plan",
      instruction: "Do something",
      planning_mode: "sketch",
      ambiguity_signals: [{ type: "missing_actor", description: "Who?", excerpt: "it", severity: "medium" }]
    });

    const plan = getPlan(db, "plan-multi-modal");
    expect(plan!.planning_mode).toBe("sketch");
    expect(plan!.ambiguity_signals).toHaveLength(1);
    expect(plan!.ambiguity_signals[0].type).toBe("missing_actor");
  });

  test("plan_assets CRUD", () => {
    upsertPlan(db, { id: "p-asset", project: "test", title: "Asset Test", instruction: "I" });
    
    addPlanAsset(db, {
      id: "a1",
      plan_id: "p-asset",
      asset_type: "screenshot",
      filename: "assets/screenshots/s1.png",
      label: "Screenshot 1",
      source_tool: "test",
      size_bytes: 1024,
      created_at: new Date().toISOString()
    });

    const assets = getPlanAssets(db, "p-asset");
    expect(assets).toHaveLength(1);
    expect(assets[0].label).toBe("Screenshot 1");

    removePlanAsset(db, "a1");
    expect(getPlanAssets(db, "p-asset")).toHaveLength(0);
  });
});

// ── Questions ─────────────────────────────────────────────────────────

describe("Plan Questions", () => {
  test("add and retrieve pending questions", () => {
    upsertPlan(db, { id: "plan-q", project: "test", title: "Q plan", instruction: "Do it" });

    const qId = addQuestion(db, {
      plan_id: "plan-q",
      question: "Should we use SQLite or Postgres?",
      asked_by: "claude-code",
      context: "Performance concerns",
    });

    expect(qId).toBeGreaterThan(0);

    const pending = getPendingQuestions(db, "plan-q");
    expect(pending).toHaveLength(1);
    expect(pending[0].question).toBe("Should we use SQLite or Postgres?");
    expect(pending[0].asked_by).toBe("claude-code");
    expect(pending[0].answer).toBeNull();
  });

  test("answering a question removes it from pending", () => {
    upsertPlan(db, { id: "plan-qa", project: "test", title: "QA plan", instruction: "Do it" });
    const qId = addQuestion(db, { plan_id: "plan-qa", question: "Which DB?", asked_by: "gemini-cli" });

    answerQuestion(db, "plan-qa", qId, "SQLite, same as memory.db");

    const pending = getPendingQuestions(db, "plan-qa");
    expect(pending).toHaveLength(0);
  });

  test("multiple questions, partial answering", () => {
    upsertPlan(db, { id: "plan-multi-q", project: "test", title: "Multi Q", instruction: "Complex task" });

    const q1 = addQuestion(db, { plan_id: "plan-multi-q", question: "Q1?", asked_by: "claude-code" });
    const q2 = addQuestion(db, { plan_id: "plan-multi-q", question: "Q2?", asked_by: "gemini-cli" });
    addQuestion(db, { plan_id: "plan-multi-q", question: "Q3?", asked_by: "opencode" });

    answerQuestion(db, "plan-multi-q", q1, "Answer 1");

    const pending = getPendingQuestions(db, "plan-multi-q");
    expect(pending).toHaveLength(2);
  });
});

// ── FTS5 Search ───────────────────────────────────────────────────────

describe("FTS5 Search", () => {
  test("search plans by instruction text", () => {
    upsertPlan(db, { id: "plan-s1", project: "agent-hq", title: "Add authentication", instruction: "Implement JWT auth with refresh tokens" });
    upsertPlan(db, { id: "plan-s2", project: "agent-hq", title: "Fix database", instruction: "Repair corrupted SQLite index" });

    const results = searchPlans(db, "authentication JWT", undefined);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("plan-s1");
  });

  test("search plans filtered by project", () => {
    upsertPlan(db, { id: "plan-p1", project: "agent-hq", title: "HQ Feature", instruction: "Add planning tools" });
    upsertPlan(db, { id: "plan-p2", project: "kolaborate", title: "Kola Feature", instruction: "Add planning dashboard" });

    const results = searchPlans(db, "planning", "agent-hq");
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe("agent-hq");
  });
});

// ── Patterns ──────────────────────────────────────────────────────────

describe("Plan Patterns", () => {
  test("upsert pattern and search", () => {
    upsertPattern(db, {
      pattern_type: "implementation",
      project: "agent-hq",
      title: "SQLite WAL mode setup",
      description: "Use WAL mode for concurrent reads",
      approach: "Set PRAGMA journal_mode=WAL at DB open time",
      pitfalls: "Don't forget to set foreign_keys=ON too",
      files_involved: ["src/db.ts"],
      source_plan_ids: ["plan-001"],
    });

    const results = searchPatterns(db, "SQLite WAL", "agent-hq");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].approach).toContain("WAL");
  });

  test("upsert existing pattern increments times_reused", () => {
    upsertPattern(db, {
      project: "test",
      title: "Duplicate pattern",
      description: "Test",
      approach: "Original approach",
    });

    upsertPattern(db, {
      project: "test",
      title: "Duplicate pattern",
      description: "Updated description",
      approach: "Updated approach",
    });

    const row = db.prepare("SELECT times_reused FROM plan_patterns WHERE title = ?").get("Duplicate pattern") as any;
    expect(row.times_reused).toBe(1); // incremented from 0
  });
});

// ── Codemap ───────────────────────────────────────────────────────────

describe("Codemap", () => {
  test("upsert and retrieve codemap entries", () => {
    upsertCodemapEntry(db, {
      project: "agent-hq",
      file_path: "/src/index.ts",
      purpose: "Main entry point",
      key_exports: [{ name: "main", type: "function", line: 10 }],
      patterns: ["singleton"],
    });

    const entries = getCodemapForProject(db, "agent-hq");
    expect(entries).toHaveLength(1);
    expect(entries[0].purpose).toBe("Main entry point");
    expect(entries[0].key_exports).toHaveLength(1);
    expect(entries[0].confidence).toBeCloseTo(0.3);
  });

  test("upsert same file increments observations", () => {
    upsertCodemapEntry(db, { project: "test", file_path: "/a.ts", purpose: "First" });
    upsertCodemapEntry(db, { project: "test", file_path: "/a.ts", purpose: "Updated" });

    const entries = getCodemapForProject(db, "test");
    expect(entries).toHaveLength(1);
    expect(entries[0].observations).toBe(2);
    expect(entries[0].purpose).toBe("Updated");
  });

  test("conventions CRUD", () => {
    upsertConvention(db, {
      project: "agent-hq",
      category: "naming",
      rule: "camelCase for source files",
      examples: ["vaultApi.ts", "promptBuilder.ts"],
    });

    const convs = getConventionsForProject(db, "agent-hq");
    expect(convs).toHaveLength(1);
    expect(convs[0].rule).toBe("camelCase for source files");
    expect(convs[0].examples).toContain("vaultApi.ts");
  });
});

// ── CodemapEngine ─────────────────────────────────────────────────────

describe("CodemapEngine", () => {
  test("observeFile calculates confidence correctly", async () => {
    const engine = new CodemapEngine(db);

    // First observation: confidence = min(1.0, 0.2 + 0.1 * 1) = 0.3
    await engine.observeFile("test", "/file.ts", { purpose: "Helper" });
    let entries = getCodemapForProject(db, "test");
    expect(entries[0].confidence).toBeCloseTo(0.3);

    // After 5 observations: 0.2 + 0.1*5 = 0.7
    for (let i = 0; i < 4; i++) {
      await engine.observeFile("test", "/file.ts", {});
    }
    entries = getCodemapForProject(db, "test");
    expect(entries[0].confidence).toBeCloseTo(0.7);
    expect(entries[0].observations).toBe(5);
  });

  test("getSummary returns token-efficient format", () => {
    const engine = new CodemapEngine(db);

    // Populate a few entries with high confidence
    for (let i = 0; i < 8; i++) {
      upsertCodemapEntry(db, {
        project: "demo",
        file_path: `/src/file${i}.ts`,
        purpose: `Module ${i}`,
        confidence: 0.8,
        observations: 8,
      });
    }
    upsertConvention(db, { project: "demo", category: "naming", rule: "camelCase" });

    const summary = engine.getSummary("demo");
    expect(summary).toContain("demo (8 files mapped");
    expect(summary).toContain("1 conventions");
    expect(summary).toContain("Core:");
  });

  test("getSummary returns message for unknown project", () => {
    const engine = new CodemapEngine(db);
    expect(engine.getSummary("unknown")).toContain("No codemap data");
  });

  test("applyDecay reduces confidence of stale entries", () => {
    const engine = new CodemapEngine(db);

    // Insert entry with old updated_at
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO codemap_entries (project, file_path, purpose, confidence, observations, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("test", "/old.ts", "Old file", 0.8, 5, oldDate);

    engine.applyDecay();

    const entries = getCodemapForProject(db, "test");
    expect(entries[0].confidence).toBeCloseTo(0.75); // 0.8 - 0.05
  });
});

// ── PlanKnowledgeEngine ───────────────────────────────────────────────

describe("PlanKnowledgeEngine", () => {
  test("findSimilarPatterns returns empty for no data", async () => {
    const engine = new PlanKnowledgeEngine(db);
    const results = await engine.findSimilarPatterns("anything");
    expect(results).toEqual([]);
  });

  test("recordUsage increments times_reused", async () => {
    const engine = new PlanKnowledgeEngine(db);

    const id = upsertPattern(db, {
      project: "test",
      title: "Test pattern",
      description: "desc",
      approach: "approach",
    });

    await engine.recordUsage(id);

    const row = db.prepare("SELECT times_reused FROM plan_patterns WHERE id = ?").get(id) as any;
    expect(row.times_reused).toBe(1);
  });

  test("pruneStalePatterns removes old unused patterns", () => {
    const engine = new PlanKnowledgeEngine(db);
    const countBefore = (db.prepare("SELECT COUNT(*) as c FROM plan_patterns").get() as any).c;

    // Insert old unused pattern
    const oldDate = new Date(Date.now() - 100 * 86400_000).toISOString();
    db.prepare(`
      INSERT INTO plan_patterns (pattern_type, project, title, description, approach, times_reused, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("implementation", "prune-test", "Old unused", "desc", "approach", 0, oldDate);

    // Insert old used pattern (should NOT be pruned)
    db.prepare(`
      INSERT INTO plan_patterns (pattern_type, project, title, description, approach, times_reused, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("implementation", "prune-test", "Old used", "desc", "approach", 3, oldDate);

    const countAfterInsert = (db.prepare("SELECT COUNT(*) as c FROM plan_patterns").get() as any).c;
    expect(countAfterInsert).toBe(countBefore + 2);

    const pruned = engine.pruneStalePatterns(90);
    expect(pruned).toBeGreaterThanOrEqual(1);

    // The used pattern should survive
    const surviving = db.prepare("SELECT * FROM plan_patterns WHERE project = 'prune-test'").all();
    expect(surviving).toHaveLength(1);
    expect((surviving[0] as any).title).toBe("Old used");
  });

  test("extractPatterns parses LLM response", async () => {
    const engine = new PlanKnowledgeEngine(db);

    // Create a completed plan
    upsertPlan(db, {
      id: "plan-extract",
      project: "test",
      title: "Build auth",
      status: "completed",
      instruction: "Implement JWT auth",
      outcome: "Implemented with refresh tokens",
      files_touched: ["src/auth.ts"],
    });
    db.prepare("UPDATE plans SET completed_at = ? WHERE id = ?").run(new Date().toISOString(), "plan-extract");

    // Mock LLM that returns structured patterns
    const mockLLM = async () => JSON.stringify([{
      pattern_type: "implementation",
      title: "JWT refresh token flow",
      description: "Token rotation with sliding window",
      approach: "Store refresh token hash in DB, rotate on each use",
      pitfalls: "Must invalidate old tokens on rotation",
      files_involved: ["src/auth.ts"],
    }]);

    const count = await engine.extractPatterns("plan-extract", mockLLM);
    expect(count).toBe(1);

    const patterns = db.prepare("SELECT * FROM plan_patterns WHERE project = 'test'").all() as any[];
    expect(patterns).toHaveLength(1);
    expect(patterns[0].title).toBe("JWT refresh token flow");
    expect(patterns[0].approach).toContain("refresh token hash");
  });
});
