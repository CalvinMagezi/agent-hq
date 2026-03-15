/**
 * @repo/hq-tools/planDB
 *
 * SQLite schema + CRUD for Cross-Agent Planning System.
 * Database lives at {vaultPath}/_embeddings/plans.db
 */

import { Database } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";

export interface PlanPhase {
  phaseId: string;
  title: string;
  harness: string;
  role: string;
  output?: string;
  notes?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
}

export interface AmbiguitySignal {
  type: "missing_actor" | "undefined_scope" | "conflicting_requirements" |
        "unreferenced_entity" | "vague_quantifier";
  description: string;
  excerpt: string;           // triggering text fragment
  severity: "low" | "medium" | "high";
  suggestedQuestion?: string;
}

export interface Plan {
  id: string;
  project: string;
  title: string;
  status: 'planning' | 'delegated' | 'in_progress' | 'completed' | 'failed' | 'abandoned';
  created_by: string;
  instruction: string;
  phases: PlanPhase[];
  outcome?: string;
  files_touched: string[];
  created_at: string;
  updated_at: string;
  completed_at?: string;
  planning_mode: 'act' | 'sketch' | 'blueprint';
  ambiguity_signals: AmbiguitySignal[];
}

export interface PlanAsset {
  id: string;                // asset-{timestamp}-{hash6}
  plan_id: string;
  asset_type: "screenshot" | "diagram" | "scenario";
  filename: string;          // relative path within plan folder (e.g. "assets/screenshots/desktop.png")
  label: string;             // human-readable description
  phase_id?: string;         // which phase this relates to
  source_tool: string;       // tool that created it (e.g. "browser_screenshot", "create_diagram")
  size_bytes: number;
  created_at: string;
}

export interface PlanManifest {
  planId: string;
  version: number;
  planningMode: "act" | "sketch" | "blueprint";
  ambiguitySignals: AmbiguitySignal[];
  assets: Omit<PlanAsset, "plan_id">[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanQuestion {
  id?: number;
  plan_id: string;
  question: string;
  asked_by: string;
  context?: string;
  answer?: string;
  created_at: string;
  answered_at?: string;
}

export interface PlanPattern {
  id?: number;
  pattern_type: 'implementation' | 'architecture' | 'refactor' | 'debug' | 'workflow';
  project: string;
  title: string;
  description: string;
  approach: string;
  pitfalls?: string;
  files_involved: string[];
  source_plan_ids: string[];
  times_reused: number;
  created_at: string;
}

export interface CodemapEntry {
  id?: number;
  project: string;
  file_path: string;
  purpose?: string;
  key_exports: Array<{ name: string; type: string; line: number }>;
  imports_from: string[];
  patterns: string[];
  confidence: number;
  observations: number;
  last_file_mtime?: string;
  updated_at: string;
}

export interface CodemapConvention {
  id?: number;
  project: string;
  category: 'naming' | 'imports' | 'patterns' | 'testing' | 'structure' | 'tooling';
  rule: string;
  examples: string[];
  confidence: number;
  updated_at: string;
}

/**
 * Open the plans database and initialize schema if needed.
 */
export function openPlanDB(vaultPath: string): Database {
  const embeddingsDir = path.join(vaultPath, "_embeddings");
  if (!fs.existsSync(embeddingsDir)) {
    fs.mkdirSync(embeddingsDir, { recursive: true });
  }

  const db = new Database(path.join(embeddingsDir, "plans.db"), { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  // Core plan tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      created_by TEXT NOT NULL DEFAULT '',
      instruction TEXT NOT NULL,
      phases TEXT NOT NULL DEFAULT '[]',
      outcome TEXT,
      files_touched TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plan_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL,
      question TEXT NOT NULL,
      asked_by TEXT NOT NULL,
      context TEXT,
      answer TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plan_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_type TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      approach TEXT NOT NULL,
      pitfalls TEXT,
      files_involved TEXT DEFAULT '[]',
      source_plan_ids TEXT DEFAULT '[]',
      times_reused INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(project, title)
    );

    CREATE TABLE IF NOT EXISTS codemap_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      file_path TEXT NOT NULL,
      purpose TEXT,
      key_exports TEXT DEFAULT '[]',
      imports_from TEXT DEFAULT '[]',
      patterns TEXT DEFAULT '[]',
      confidence REAL DEFAULT 0.3,
      observations INTEGER DEFAULT 1,
      last_file_mtime TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(project, file_path)
    );

    CREATE TABLE IF NOT EXISTS codemap_conventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      rule TEXT NOT NULL,
      examples TEXT DEFAULT '[]',
      confidence REAL DEFAULT 0.5,
      updated_at TEXT NOT NULL,
      UNIQUE(project, category, rule)
    );

    CREATE TABLE IF NOT EXISTS plan_assets (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      label TEXT NOT NULL,
      phase_id TEXT,
      source_tool TEXT,
      size_bytes INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE
    );
  `);

  // Safe migrations
  try { db.exec("ALTER TABLE plans ADD COLUMN planning_mode TEXT DEFAULT 'sketch'"); } catch { /* col exists */ }
  try { db.exec("ALTER TABLE plans ADD COLUMN ambiguity_signals TEXT DEFAULT '[]'"); } catch { /* col exists */ }

  // FTS5 for search
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS plans_fts USING fts5(title, instruction, outcome, content=plans, content_rowid=rowid);");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts USING fts5(title, description, approach, content=plan_patterns, content_rowid=rowid);");
  } catch (err) {
    console.error("[planDB] FTS5 initialization failed:", err);
  }

  // Triggers to sync FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS plans_ai AFTER INSERT ON plans BEGIN
      INSERT INTO plans_fts(rowid, title, instruction, outcome) VALUES (new.rowid, new.title, new.instruction, new.outcome);
    END;
    CREATE TRIGGER IF NOT EXISTS plans_ad AFTER DELETE ON plans BEGIN
      INSERT INTO plans_fts(plans_fts, rowid, title, instruction, outcome) VALUES('delete', old.rowid, old.title, old.instruction, old.outcome);
    END;
    CREATE TRIGGER IF NOT EXISTS plans_au AFTER UPDATE ON plans BEGIN
      INSERT INTO plans_fts(plans_fts, rowid, title, instruction, outcome) VALUES('delete', old.rowid, old.title, old.instruction, old.outcome);
      INSERT INTO plans_fts(rowid, title, instruction, outcome) VALUES (new.rowid, new.title, new.instruction, new.outcome);
    END;

    CREATE TRIGGER IF NOT EXISTS patterns_ai AFTER INSERT ON plan_patterns BEGIN
      INSERT INTO patterns_fts(rowid, title, description, approach) VALUES (new.rowid, new.title, new.description, new.approach);
    END;
    CREATE TRIGGER IF NOT EXISTS patterns_ad AFTER DELETE ON plan_patterns BEGIN
      INSERT INTO patterns_fts(patterns_fts, rowid, title, description, approach) VALUES('delete', old.rowid, old.title, old.description, old.approach);
    END;
    CREATE TRIGGER IF NOT EXISTS patterns_au AFTER UPDATE ON plan_patterns BEGIN
      INSERT INTO patterns_fts(patterns_fts, rowid, title, description, approach) VALUES('delete', old.rowid, old.title, old.description, old.approach);
      INSERT INTO patterns_fts(rowid, title, description, approach) VALUES (new.rowid, new.title, new.description, new.approach);
    END;
  `);

  return db;
}

// ── CRUD Helpers ──────────────────────────────────────────────────────

export function getPlan(db: Database, id: string): Plan | null {
  const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as any;
  if (!row) return null;
  return parsePlanRow(row);
}

export function upsertPlan(db: Database, plan: Partial<Plan> & { id: string }): void {
  const existing = getPlan(db, plan.id);
  const now = new Date().toISOString();

  if (existing) {
    const ALLOWED_COLUMNS = new Set([
      "project", "title", "status", "created_by", "instruction",
      "phases", "outcome", "files_touched", "completed_at",
      "planning_mode", "ambiguity_signals",
    ]);
    const updates: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(plan)) {
      if (key === "id" || !ALLOWED_COLUMNS.has(key)) continue;
      updates.push(`${key} = ?`);
      values.push(Array.isArray(val) ? JSON.stringify(val) : val);
    }
    updates.push("updated_at = ?");
    values.push(now);
    values.push(plan.id);

    db.prepare(`UPDATE plans SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  } else {
    db.prepare(`
      INSERT INTO plans (id, project, title, status, created_by, instruction, phases, files_touched, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      plan.project || "",
      plan.title || "Untitled Plan",
      plan.status || "planning",
      plan.created_by || "",
      plan.instruction || "",
      JSON.stringify(plan.phases || []),
      JSON.stringify(plan.files_touched || []),
      now,
      now
    );
  }

  // Handle new columns if provided
  if (plan.planning_mode || plan.ambiguity_signals) {
    const sets = [];
    const vals = [];
    if (plan.planning_mode) { sets.push("planning_mode = ?"); vals.push(plan.planning_mode); }
    if (plan.ambiguity_signals) { sets.push("ambiguity_signals = ?"); vals.push(JSON.stringify(plan.ambiguity_signals)); }
    vals.push(plan.id);
    db.prepare(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
}

export function addPlanAsset(db: Database, asset: PlanAsset): string {
  db.prepare(`
    INSERT INTO plan_assets (id, plan_id, asset_type, filename, label, phase_id, source_tool, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    asset.id,
    asset.plan_id,
    asset.asset_type,
    asset.filename,
    asset.label,
    asset.phase_id || null,
    asset.source_tool,
    asset.size_bytes,
    asset.created_at
  );
  return asset.id;
}

export function getPlanAssets(db: Database, planId: string, type?: string): PlanAsset[] {
  let sql = "SELECT * FROM plan_assets WHERE plan_id = ?";
  const params: any[] = [planId];
  if (type) {
    sql += " AND asset_type = ?";
    params.push(type);
  }
  return db.prepare(sql).all(...params) as PlanAsset[];
}

export function removePlanAsset(db: Database, assetId: string): void {
  db.prepare("DELETE FROM plan_assets WHERE id = ?").run(assetId);
}

export function addQuestion(db: Database, q: Omit<PlanQuestion, "id" | "created_at">): number {
  const result = db.prepare(`
    INSERT INTO plan_questions (plan_id, question, asked_by, context, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(q.plan_id, q.question, q.asked_by, q.context || null, new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function answerQuestion(db: Database, planId: string, questionId: number, answer: string): void {
  db.prepare(`
    UPDATE plan_questions SET answer = ?, answered_at = ?
    WHERE id = ? AND plan_id = ?
  `).run(answer, new Date().toISOString(), questionId, planId);
}

export function getPendingQuestions(db: Database, planId: string): PlanQuestion[] {
  return db.prepare("SELECT * FROM plan_questions WHERE plan_id = ? AND answer IS NULL").all(planId) as PlanQuestion[];
}

export function searchPlans(db: Database, query: string, project?: string): Plan[] {
  let sql = "SELECT p.* FROM plans p JOIN plans_fts f ON p.rowid = f.rowid WHERE plans_fts MATCH ?";
  const params: any[] = [query];
  if (project) {
    sql += " AND p.project = ?";
    params.push(project);
  }
  return db.prepare(sql).all(...params).map(parsePlanRow);
}

export function searchPatterns(db: Database, query: string, project?: string): PlanPattern[] {
  let sql = "SELECT p.* FROM plan_patterns p JOIN patterns_fts f ON p.rowid = f.rowid WHERE patterns_fts MATCH ?";
  const params: any[] = [query];
  if (project) {
    sql += " AND p.project = ?";
    params.push(project);
  }
  return db.prepare(sql).all(...params).map(parsePatternRow);
}

export function upsertPattern(db: Database, pattern: Partial<PlanPattern> & { title: string; project: string }): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO plan_patterns (pattern_type, project, title, description, approach, pitfalls, files_involved, source_plan_ids, times_reused, created_at)
    VALUES ($pattern_type, $project, $title, $description, $approach, $pitfalls, $files_involved, $source_plan_ids, $times_reused, $created_at)
    ON CONFLICT(project, title) DO UPDATE SET
      description = EXCLUDED.description,
      approach = EXCLUDED.approach,
      pitfalls = EXCLUDED.pitfalls,
      files_involved = EXCLUDED.files_involved,
      source_plan_ids = EXCLUDED.source_plan_ids,
      times_reused = plan_patterns.times_reused + 1
  `).run({
    $pattern_type: pattern.pattern_type || 'implementation',
    $project: pattern.project,
    $title: pattern.title,
    $description: pattern.description || "",
    $approach: pattern.approach || "",
    $pitfalls: pattern.pitfalls || null,
    $files_involved: JSON.stringify(pattern.files_involved || []),
    $source_plan_ids: JSON.stringify(pattern.source_plan_ids || []),
    $times_reused: pattern.times_reused || 0,
    $created_at: now
  });
  return result.lastInsertRowid as number;
}

export function upsertCodemapEntry(db: Database, entry: Partial<CodemapEntry> & { project: string; file_path: string }): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO codemap_entries (project, file_path, purpose, key_exports, imports_from, patterns, confidence, observations, last_file_mtime, updated_at)
    VALUES ($project, $file_path, $purpose, $key_exports, $imports_from, $patterns, $confidence, $observations, $last_file_mtime, $updated_at)
    ON CONFLICT(project, file_path) DO UPDATE SET
      purpose = COALESCE(excluded.purpose, codemap_entries.purpose),
      key_exports = COALESCE(excluded.key_exports, codemap_entries.key_exports),
      imports_from = COALESCE(excluded.imports_from, codemap_entries.imports_from),
      patterns = COALESCE(excluded.patterns, codemap_entries.patterns),
      confidence = excluded.confidence,
      observations = codemap_entries.observations + 1,
      last_file_mtime = COALESCE(excluded.last_file_mtime, codemap_entries.last_file_mtime),
      updated_at = excluded.updated_at
  `).run({
    $project: entry.project,
    $file_path: entry.file_path,
    $purpose: entry.purpose || null,
    $key_exports: JSON.stringify(entry.key_exports || []),
    $imports_from: JSON.stringify(entry.imports_from || []),
    $patterns: JSON.stringify(entry.patterns || []),
    $confidence: entry.confidence ?? 0.3,
    $observations: entry.observations ?? 1,
    $last_file_mtime: entry.last_file_mtime || null,
    $updated_at: now
  });
}

export function getCodemapForProject(db: Database, project: string): CodemapEntry[] {
  return db.prepare("SELECT * FROM codemap_entries WHERE project = ?").all(project).map(parseCodemapRow);
}

export function upsertConvention(db: Database, conv: Partial<CodemapConvention> & { project: string; category: string; rule: string }): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO codemap_conventions (project, category, rule, examples, confidence, updated_at)
    VALUES ($project, $category, $rule, $examples, $confidence, $updated_at)
    ON CONFLICT(project, category, rule) DO UPDATE SET
      examples = COALESCE(excluded.examples, codemap_conventions.examples),
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `).run({
    $project: conv.project,
    $category: conv.category,
    $rule: conv.rule,
    $examples: JSON.stringify(conv.examples || []),
    $confidence: conv.confidence ?? 0.5,
    $updated_at: now
  });
}

export function getConventionsForProject(db: Database, project: string): CodemapConvention[] {
  return db.prepare("SELECT * FROM codemap_conventions WHERE project = ?").all(project).map(parseConventionRow);
}

// ── Private Parsers ───────────────────────────────────────────────────

function parsePlanRow(r: any): Plan {
  return {
    ...r,
    phases: JSON.parse(r.phases || "[]"),
    files_touched: JSON.parse(r.files_touched || "[]"),
    ambiguity_signals: JSON.parse(r.ambiguity_signals || "[]")
  };
}

function parsePatternRow(r: any): PlanPattern {
  return {
    ...r,
    files_involved: JSON.parse(r.files_involved || "[]"),
    source_plan_ids: JSON.parse(r.source_plan_ids || "[]")
  };
}

function parseCodemapRow(r: any): CodemapEntry {
  return {
    ...r,
    key_exports: JSON.parse(r.key_exports || "[]"),
    imports_from: JSON.parse(r.imports_from || "[]"),
    patterns: JSON.parse(r.patterns || "[]")
  };
}

function parseConventionRow(r: any): CodemapConvention {
  return {
    ...r,
    examples: JSON.parse(r.examples || "[]")
  };
}
