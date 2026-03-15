/**
 * Daemon Task: Plan Maintenance
 *
 * Three background tasks:
 * 1. planStatusSync — syncs plan frontmatter from _plans/active/*.md into plans.db
 * 2. planKnowledgeExtraction — extracts reusable patterns from completed plans via LLM
 * 3. planArchival — moves old plans to archive, prunes unused patterns
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { openPlanDB, upsertPlan, getPlan } from "../../packages/hq-tools/src/planDB.js";
import { PlanKnowledgeEngine } from "../../packages/hq-tools/src/planKnowledge.js";
import { CodemapEngine } from "../../packages/hq-tools/src/codemap.js";
import type { DaemonContext } from "./context.js";

// ── Frontmatter helper ──────────────────────────────────────────────

/**
 * Update specific fields in a plan.md frontmatter without clobbering the body.
 * Uses gray-matter's stringify so the body markdown is preserved exactly.
 */
function writePlanFrontmatter(planMd: string, updates: Record<string, any>): void {
  try {
    const raw = fs.readFileSync(planMd, "utf-8");
    const file = matter(raw);
    const newData = { ...file.data, ...updates, updatedAt: new Date().toISOString() };
    fs.writeFileSync(planMd, matter.stringify(file.content, newData));
  } catch (err) {
    console.warn(`[writePlanFrontmatter] Failed to update ${planMd}:`, err);
  }
}

// ── LLM wrapper matching vault-workers pattern ──────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.VAULT_WORKER_MODEL ?? "qwen3.5:9b";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function truncate(text: string, maxChars = 8000): string {
  return text.length > maxChars ? text.substring(0, maxChars) + "\n...[truncated]" : text;
}

async function llmCall(prompt: string, systemPrompt?: string): Promise<string> {
  const truncatedPrompt = truncate(prompt);

  // Try Ollama first (free, local)
  try {
    const body: Record<string, unknown> = {
      model: OLLAMA_MODEL,
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        { role: "user", content: truncatedPrompt },
      ],
      max_tokens: 1024,
      stream: false,
    };
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0]?.message?.content;
      if (content) return content;
    }
  } catch { /* fall through */ }

  // Gemini fallback
  if (!GEMINI_API_KEY) throw new Error("Plan maintenance LLM: Ollama unavailable and GEMINI_API_KEY not set");

  for (const model of ["gemini-2.5-flash-lite", "gemini-2.5-flash"]) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const body = {
        contents: [
          ...(systemPrompt ? [{
            role: "user", parts: [{ text: systemPrompt }],
          }, {
            role: "model", parts: [{ text: "Understood." }],
          }] : []),
          { role: "user", parts: [{ text: truncatedPrompt }] },
        ],
        generationConfig: { maxOutputTokens: 1024 },
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
        };
        const text = data.candidates[0]?.content?.parts[0]?.text;
        if (text) return text;
      }
    } catch { /* try next model */ }
  }

  throw new Error("Plan maintenance LLM: all models failed");
}

// ── 1. Plan Status Sync ─────────────────────────────────────────────

/**
 * Syncs plan frontmatter from _plans/active/*.md into plans.db.
 * Also checks delegation results and updates plan status accordingly.
 */
export async function planStatusSync(ctx: DaemonContext): Promise<void> {
  const plansDir = path.join(ctx.vaultPath, "_plans", "active");
  if (!fs.existsSync(plansDir)) return;

  const db = openPlanDB(ctx.vaultPath);
  const entries = fs.readdirSync(plansDir, { withFileTypes: true });

  for (const entry of entries) {
    try {
      let planMd: string;
      let manifestPath: string | undefined;

      if (entry.isDirectory()) {
        planMd = path.join(plansDir, entry.name, "plan.md");
        manifestPath = path.join(plansDir, entry.name, "manifest.json");
        if (!fs.existsSync(planMd)) continue;
      } else if (entry.name.endsWith(".md")) {
        planMd = path.join(plansDir, entry.name);
      } else {
        continue;
      }

      const raw = fs.readFileSync(planMd, "utf-8");
      const { data } = matter(raw);
      if (!data.planId || !/^plan-[a-zA-Z0-9_-]+$/.test(data.planId)) continue;

      // Sync into DB
      upsertPlan(db, {
        id: data.planId,
        project: data.project || "default",
        title: data.title || (entry.isDirectory() ? entry.name : entry.name.replace(".md", "")),
        status: data.status,
      });

      // Check if delegation job is done
      const delegationJobId = `${data.planId}-delegation`;
      const doneJob = path.join(ctx.vaultPath, "_jobs", "done", `${delegationJobId}.md`);
      const failedJob = path.join(ctx.vaultPath, "_jobs", "failed", `${delegationJobId}.md`);

      if (fs.existsSync(doneJob) && data.status !== "completed") {
        upsertPlan(db, { id: data.planId, status: "completed", completed_at: new Date().toISOString() });
        writePlanFrontmatter(planMd, { status: "completed", completedAt: new Date().toISOString() });
      } else if (fs.existsSync(failedJob) && data.status !== "failed") {
        upsertPlan(db, { id: data.planId, status: "failed" });
        writePlanFrontmatter(planMd, { status: "failed" });
      }

      // Stale detection: "delegated" plans with no live job for >48h → abandon
      const terminalStatuses = ["completed", "failed", "abandoned"];
      if (!terminalStatuses.includes(data.status) && data.status === "delegated") {
        const createdAt = data.createdAt ? new Date(data.createdAt).getTime() : 0;
        const twoDaysAgo = Date.now() - 48 * 3600_000;
        if (createdAt > 0 && createdAt < twoDaysAgo) {
          const pendingJob = path.join(ctx.vaultPath, "_jobs", "pending", `${delegationJobId}.md`);
          const runningJob = path.join(ctx.vaultPath, "_jobs", "running", `${delegationJobId}.md`);
          const jobAlive = fs.existsSync(pendingJob) || fs.existsSync(runningJob);
          if (!jobAlive) {
            upsertPlan(db, { id: data.planId, status: "abandoned" });
            writePlanFrontmatter(planMd, { status: "abandoned" });
            console.log(`[planStatusSync] Marked stale plan as abandoned: ${data.planId}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[planStatusSync] Failed for ${entry.name}:`, err);
    }
  }
}

// ── 2. Knowledge Extraction ─────────────────────────────────────────

/**
 * Extracts reusable patterns from completed plans that haven't been processed.
 * Uses LLM (Ollama → Gemini fallback) to identify what worked and what to avoid.
 */
export async function planKnowledgeExtraction(ctx: DaemonContext): Promise<void> {
  const db = openPlanDB(ctx.vaultPath);
  const knowledge = new PlanKnowledgeEngine(db);
  const codemap = new CodemapEngine(db);

  // Find completed plans that haven't had patterns extracted yet
  // We use a marker: plans with status=completed but no patterns referencing them
  const completedPlans = db.prepare(`
    SELECT p.* FROM plans p
    WHERE p.status = 'completed'
      AND p.completed_at IS NOT NULL
      AND p.completed_at < ?
      AND p.id NOT IN (
        SELECT DISTINCT json_each.value FROM plan_patterns, json_each(plan_patterns.source_plan_ids)
      )
    ORDER BY p.completed_at DESC
    LIMIT 5
  `).all(new Date(Date.now() - 60 * 60_000).toISOString()) as any[];

  for (const plan of completedPlans) {
    try {
      console.log(`[planKnowledgeExtraction] Extracting patterns from: ${plan.id}`);
      const count = await knowledge.extractPatterns(plan.id, llmCall);
      console.log(`[planKnowledgeExtraction] Extracted ${count} patterns from ${plan.id}`);

      // Also update codemap with files_touched
      const filesTouched = JSON.parse(plan.files_touched || "[]") as string[];
      for (const filePath of filesTouched.slice(0, 10)) {
        await codemap.observeFile(plan.project || "default", filePath, {});
      }

      ctx.recordTaskRun("plan-extraction", true);
    } catch (err) {
      console.warn(`[planKnowledgeExtraction] Failed for ${plan.id}:`, err);
      ctx.recordTaskRun("plan-extraction", false, String(err));
    }
  }
}

// ── 3. Plan Archival + Pattern Decay ────────────────────────────────

/**
 * Moves completed plans from _plans/active/ to _plans/archive/.
 * Prunes unused patterns older than 90 days.
 * Cleans up stale signal files.
 */
export async function planArchival(ctx: DaemonContext): Promise<void> {
  const activeDir = path.join(ctx.vaultPath, "_plans", "active");
  const archiveDir = path.join(ctx.vaultPath, "_plans", "archive");
  const signalsDir = path.join(ctx.vaultPath, "_plans", "signals");

  // Archive completed/failed plans older than 7 days
  if (fs.existsSync(activeDir)) {
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

    const entries = fs.readdirSync(activeDir, { withFileTypes: true });
    const sevenDaysAgo = Date.now() - 7 * 86400_000;

    for (const entry of entries) {
      try {
        let planMd: string;
        const entryPath = path.join(activeDir, entry.name);

        if (entry.isDirectory()) {
          planMd = path.join(entryPath, "plan.md");
          if (!fs.existsSync(planMd)) continue;
        } else if (entry.name.endsWith(".md")) {
          planMd = entryPath;
        } else {
          continue;
        }

        const raw = fs.readFileSync(planMd, "utf-8");
        const { data } = matter(raw);

        const isTerminal = data.status === "completed" || data.status === "failed" || data.status === "abandoned";
        const completedAt = data.completedAt ? new Date(data.completedAt).getTime() : 0;
        const isOldEnough = completedAt > 0 && completedAt < sevenDaysAgo;

        if (isTerminal && isOldEnough) {
          fs.renameSync(entryPath, path.join(archiveDir, entry.name));
          console.log(`[planArchival] Archived ${entry.name}`);
        }
      } catch (err) {
        console.warn(`[planArchival] Failed for ${entry.name}:`, err);
      }
    }
  }

  // Clean up stale signal files (>24hr)
  if (fs.existsSync(signalsDir)) {
    const oneDayAgo = Date.now() - 86400_000;
    for (const f of fs.readdirSync(signalsDir).filter(f => f.endsWith(".md"))) {
      try {
        const stat = fs.statSync(path.join(signalsDir, f));
        if (stat.mtimeMs < oneDayAgo) {
          fs.unlinkSync(path.join(signalsDir, f));
        }
      } catch { /* ignore */ }
    }
  }

  // Prune unused patterns older than 90 days
  const db = openPlanDB(ctx.vaultPath);
  const knowledge = new PlanKnowledgeEngine(db);
  const pruned = knowledge.pruneStalePatterns(90);
  if (pruned > 0) {
    console.log(`[planArchival] Pruned ${pruned} unused patterns older than 90 days`);
  }
}
