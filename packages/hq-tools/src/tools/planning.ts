import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";
import { 
  openPlanDB, 
  upsertPlan, 
  getPlan, 
  getPendingQuestions, 
  answerQuestion, 
  searchPlans, 
  searchPatterns,
  upsertCodemapEntry,
  upsertConvention,
  getCodemapForProject,
  getConventionsForProject
} from "../planDB.js";
import { CodemapEngine } from "../codemap.js";
import { PlanKnowledgeEngine } from "../planKnowledge.js";

// Helper to get or open planDB from ctx
function getPlanDB(ctx: HQContext) {
  if (ctx.planDB) return ctx.planDB;
  return openPlanDB(ctx.vaultPath);
}

/**
 * Auto-detect project from instruction text by matching against
 * vault project folders and git remote name.
 */
function detectProject(instruction: string, vaultPath: string): string {
  const lower = instruction.toLowerCase();

  // Check vault project folders
  const projectsDir = path.join(vaultPath, "Notebooks", "Projects");
  if (fs.existsSync(projectsDir)) {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const proj of projects) {
      // Match project name (case-insensitive, with common separators)
      const variants = [
        proj.toLowerCase(),
        proj.toLowerCase().replace(/-/g, " "),
        proj.toLowerCase().replace(/-/g, ""),
      ];
      if (variants.some(v => lower.includes(v))) return proj;
    }
  }

  // Check git remote for project name
  const projectRoot = path.resolve(vaultPath, "..");
  try {
    const gitConfig = fs.readFileSync(path.join(projectRoot, ".git", "config"), "utf-8");
    const match = gitConfig.match(/url\s*=\s*.*[/:]([^/\s]+?)(?:\.git)?\s*$/m);
    if (match) return match[1];
  } catch { /* ignore */ }

  // Check package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
    if (pkg.name) return pkg.name.replace(/^@[^/]+\//, "");
  } catch { /* ignore */ }

  return "default";
}

// ── 1. plan_create ─────────────────────────────────────────────────

export const PlanCreateTool: HQTool<
  { instruction: string; project?: string; mode?: "quick" | "standard" | "thorough" }, 
  any
> = {
  name: "plan_create",
  description: "Create a new cross-agent plan with progressive codebase understanding context (fire-and-observe).",
  tags: ["plan", "create", "architecture", "delegation"],
  requiresWriteAccess: true,
  schema: Type.Object({
    instruction: Type.String({ description: "High-level goal or instruction for the plan." }),
    project: Type.Optional(Type.String({ description: "Project name. Auto-detected from vault structure if omitted." })),
    mode: Type.Optional(
      Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("thorough")], { 
        description: "Planning depth. Default standard." 
      })
    )
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const knowledge = new PlanKnowledgeEngine(db);
    const codemap = new CodemapEngine(db);

    const project = input.project || detectProject(input.instruction, ctx.vaultPath);
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    const similarPatterns = await knowledge.findSimilarPatterns(input.instruction, project);
    const codemapSummary = codemap.getSummary(project);

    upsertPlan(db, {
      id: planId,
      project,
      title: input.instruction.slice(0, 100),
      status: "delegated",
      instruction: input.instruction,
    });

    const plansDir = path.join(ctx.vaultPath, "_plans", "active");
    if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
    
    const planFile = path.join(plansDir, `${planId}.md`);
    const frontmatter = {
      planId,
      project,
      status: "delegated",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    const content = `# Plan: ${input.instruction}\n\n## Instruction\n\n${input.instruction}\n\n## Questions\n\n_No questions yet._\n\n## Phases\n\n_Phases will be populated by the planner._\n`;
    fs.writeFileSync(planFile, matter.stringify(content, frontmatter));

    // Create delegation task
    const jobFilename = `${planId}-delegation.md`;
    const jobPath = path.join(ctx.vaultPath, "_jobs", "pending", jobFilename);
    const jobFrontmatter = {
      jobId: `${planId}-delegation`,
      planId,
      status: "pending",
      role: "planner",
      priority: 80,
      createdAt: new Date().toISOString()
    };
    
    const jobBody = `# Task: Planning for ${planId}\n\n## Instruction\n\n${input.instruction}\n\n## Context\n\n### Similar Patterns\n${JSON.stringify(similarPatterns.slice(0, 3), null, 2)}\n\n### Codebase Summary\n${codemapSummary}\n\n## Requirements\n- Draft the phases in _plans/active/${planId}.md\n- Post clarifying questions to the ## Questions section of that file.`;
    fs.writeFileSync(jobPath, matter.stringify(jobBody, jobFrontmatter));

    return { 
      planId, 
      status: "delegated", 
      similarPatterns: similarPatterns.slice(0, 3).map(p => ({ title: p.title, description: p.description })), 
      codemapSummary 
    };
  }
};

// ── 2. plan_status ─────────────────────────────────────────────────

export const PlanStatusTool: HQTool<{ planId: string }, any> = {
  name: "plan_status",
  description: "Get the current status of a plan, including pending questions and progress.",
  tags: ["plan", "status", "progress", "questions"],
  schema: Type.Object({
    planId: Type.String({ description: "Plan ID (e.g. plan-1741...)" })
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);

    const questions = getPendingQuestions(db, input.planId);

    return {
      planId: plan.id,
      status: plan.status,
      title: plan.title,
      phases: plan.phases,
      pendingQuestions: questions.map(q => ({ id: q.id, question: q.question, askedBy: q.asked_by, context: q.context })),
      updatedAt: plan.updated_at
    };
  }
};

// ── 3. plan_answer ─────────────────────────────────────────────────

export const PlanAnswerTool: HQTool<{ planId: string; questionId: number; answer: string }, any> = {
  name: "plan_answer",
  description: "Provide an answer to a clarifying question in a plan.",
  tags: ["plan", "answer", "clarification"],
  requiresWriteAccess: true,
  schema: Type.Object({
    planId: Type.String({ description: "Plan ID" }),
    questionId: Type.Number({ description: "Question ID" }),
    answer: Type.String({ description: "Your answer to the question" })
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);

    answerQuestion(db, input.planId, input.questionId, input.answer);

    // Write signal file for planner polling
    const signalsDir = path.join(ctx.vaultPath, "_plans", "signals");
    if (!fs.existsSync(signalsDir)) fs.mkdirSync(signalsDir, { recursive: true });
    
    const signalFile = path.join(signalsDir, `answer-${input.planId}-${input.questionId}.md`);
    fs.writeFileSync(signalFile, `# Answer for Question ${input.questionId}\n\n${input.answer}`);

    const remaining = getPendingQuestions(db, input.planId);

    return { acknowledged: true, remainingQuestions: remaining.length };
  }
};

// ── 4. plan_search ─────────────────────────────────────────────────

export const PlanSearchTool: HQTool<{ query: string; project?: string }, any> = {
  name: "plan_search",
  description: "Search across past plans and reusable patterns using keyword search.",
  tags: ["plan", "search", "patterns", "discovery"],
  schema: Type.Object({
    query: Type.String({ description: "Search query" }),
    project: Type.Optional(Type.String({ description: "Filter by project name" }))
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    let plans: any[] = [];
    let patterns: any[] = [];

    try { plans = searchPlans(db, input.query, input.project); } catch { /* FTS5 match can fail on empty table */ }
    try { patterns = searchPatterns(db, input.query, input.project); } catch { /* same */ }

    return {
      plans: plans.slice(0, 5).map(p => ({ id: p.id, title: p.title, status: p.status })),
      patterns: patterns.slice(0, 5).map(p => ({ title: p.title, description: p.description, approach: p.approach }))
    };
  }
};

// ── 5. plan_update ─────────────────────────────────────────────────

export const PlanUpdateTool: HQTool<{ planId: string; status?: string; outcome?: string; phasesUpdate?: any[]; filesTouched?: string[] }, any> = {
  name: "plan_update",
  description: "Update plan status, outcome, or phases metadata.",
  tags: ["plan", "update", "metadata", "completion"],
  requiresWriteAccess: true,
  schema: Type.Object({
    planId: Type.String({ description: "Plan ID" }),
    status: Type.Optional(Type.String()),
    outcome: Type.Optional(Type.String()),
    phasesUpdate: Type.Optional(Type.Array(Type.Any())),
    filesTouched: Type.Optional(Type.Array(Type.String()))
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);

    const updates: any = { id: input.planId };
    if (input.status) updates.status = input.status;
    if (input.outcome) updates.outcome = input.outcome;
    if (input.phasesUpdate) updates.phases = input.phasesUpdate;
    if (input.filesTouched) updates.files_touched = input.filesTouched;

    if (input.status === "completed") {
      updates.completed_at = new Date().toISOString();
    }

    upsertPlan(db, updates);
    return { updated: true };
  }
};

// ── 6. codemap_query ─────────────────────────────────────────────────

export const CodemapQueryTool: HQTool<{ project: string; query?: string; filePatterns?: string[] }, any> = {
  name: "codemap_query",
  description: "Query the progressive codebase understanding for a project (token-efficient).",
  tags: ["codemap", "context", "codebase", "understanding"],
  schema: Type.Object({
    project: Type.String({ description: "Project name (e.g. agent-hq)" }),
    query: Type.Optional(Type.String({ description: "Optional specific query/keyword filter" })),
    filePatterns: Type.Optional(Type.Array(Type.String()))
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const codemap = new CodemapEngine(db);

    // Get summary and raw data
    const summary = codemap.getSummary(input.project);
    let entries = getCodemapForProject(db, input.project);
    const conventions = getConventionsForProject(db, input.project);

    // Filter by query if provided
    if (input.query) {
      const q = input.query.toLowerCase();
      entries = entries.filter(e =>
        (e.purpose && e.purpose.toLowerCase().includes(q)) ||
        e.file_path.toLowerCase().includes(q) ||
        e.key_exports.some(exp => exp.name.toLowerCase().includes(q))
      );
    }

    // Filter by file patterns if provided
    if (input.filePatterns && input.filePatterns.length > 0) {
      entries = entries.filter(e =>
        input.filePatterns!.some(pattern => e.file_path.includes(pattern))
      );
    }

    return {
      summary,
      files: entries.filter(e => e.confidence > 0.3).slice(0, 20),
      conventions,
      mappedFiles: getCodemapForProject(db, input.project).length
    };
  }
};

// ── 7. codemap_update ─────────────────────────────────────────────────

export const CodemapUpdateTool: HQTool<
  { project: string; entries: Array<{ file_path: string; purpose?: string; key_exports?: any[]; patterns?: string[] }> },
  any
> = {
  name: "codemap_update",
  description: "Record codebase observations — agents call this after exploring files to grow the codemap.",
  tags: ["codemap", "update", "observe", "codebase"],
  requiresWriteAccess: true,
  schema: Type.Object({
    project: Type.String({ description: "Project name" }),
    entries: Type.Array(Type.Object({
      file_path: Type.String({ description: "Absolute or relative file path" }),
      purpose: Type.Optional(Type.String({ description: "1-line description of what this file does" })),
      key_exports: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        type: Type.String(),
        line: Type.Optional(Type.Number())
      }))),
      patterns: Type.Optional(Type.Array(Type.String({ description: "Design patterns found" })))
    }))
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const codemap = new CodemapEngine(db);

    let updated = 0;
    for (const entry of input.entries.slice(0, 50)) {
      await codemap.observeFile(input.project, entry.file_path, {
        purpose: entry.purpose,
        key_exports: entry.key_exports || [],
        patterns: entry.patterns || [],
      });
      updated++;
    }

    return { updated, project: input.project };
  }
};
