/**
 * @repo/hq-tools/planKnowledge
 *
 * Pattern extraction from completed plans + similarity search.
 * Uses same Ollama client as vault-memory (qwen3.5:9b → Gemini fallback).
 */

import { Database } from "bun:sqlite";
import { searchPatterns, upsertPattern, getPlan, type PlanPattern, type Plan } from "./planDB.js";

const EXTRACTION_SYSTEM_PROMPT = `You are a pattern extraction assistant for Agent-HQ, a multi-agent orchestration system.

Given a completed plan with its instruction, phases, and outcome, extract reusable patterns.

Return a JSON array of pattern objects:
[
  {
    "pattern_type": "implementation|architecture|refactor|debug|workflow",
    "title": "Short descriptive title (max 60 chars)",
    "description": "1-2 sentence description of the pattern",
    "approach": "What approach worked and why",
    "pitfalls": "What to avoid or watch out for (null if none)",
    "files_involved": ["relevant/file/paths"]
  }
]

Rules:
- Extract 1-3 patterns max — only genuinely reusable ones
- Focus on the approach and reasoning, not implementation details
- "pitfalls" captures mistakes or dead-ends encountered
- Return [] if no reusable patterns exist
`;

export class PlanKnowledgeEngine {
  constructor(private db: Database) {}

  /**
   * Search for patterns similar to a given query or instruction.
   */
  async findSimilarPatterns(query: string, project?: string): Promise<PlanPattern[]> {
    try {
      return searchPatterns(this.db, query, project);
    } catch {
      // FTS5 match can fail on empty tables or bad query syntax
      return [];
    }
  }

  /**
   * Record that a pattern was reused (bumps times_reused).
   */
  async recordUsage(patternId: number): Promise<void> {
    this.db.prepare("UPDATE plan_patterns SET times_reused = times_reused + 1 WHERE id = ?").run(patternId);
  }

  /**
   * Extract reusable patterns from a completed plan using an LLM.
   * Returns the number of patterns extracted.
   */
  async extractPatterns(
    planId: string,
    llmCall: (prompt: string, systemPrompt?: string) => Promise<string>
  ): Promise<number> {
    const plan = getPlan(this.db, planId);
    if (!plan || plan.status !== "completed") return 0;

    const prompt = [
      `## Plan: ${plan.title}`,
      `**Project:** ${plan.project}`,
      `**Instruction:** ${plan.instruction}`,
      plan.phases.length > 0 ? `**Phases:**\n${plan.phases.map(p => `- ${p.title} (${p.role}/${p.harness}): ${p.status}${p.output ? ` — ${p.output.slice(0, 200)}` : ""}`).join("\n")}` : "",
      plan.outcome ? `**Outcome:** ${plan.outcome}` : "",
      plan.files_touched.length > 0 ? `**Files touched:** ${plan.files_touched.join(", ")}` : "",
    ].filter(Boolean).join("\n\n");

    const raw = await llmCall(prompt, EXTRACTION_SYSTEM_PROMPT);

    // Parse JSON from response
    const cleaned = raw.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "").trim();
    let patterns: any[];
    try {
      patterns = JSON.parse(cleaned);
      if (!Array.isArray(patterns)) patterns = [patterns];
    } catch {
      return 0;
    }

    let count = 0;
    for (const p of patterns.slice(0, 3)) {
      if (!p.title || !p.approach) continue;
      upsertPattern(this.db, {
        pattern_type: p.pattern_type || "implementation",
        project: plan.project,
        title: p.title,
        description: p.description || "",
        approach: p.approach,
        pitfalls: p.pitfalls || null,
        files_involved: p.files_involved || plan.files_touched,
        source_plan_ids: [planId],
      });
      count++;
    }

    return count;
  }

  /**
   * Prune unused patterns older than the given age.
   * Returns the number of patterns pruned.
   */
  pruneStalePatterns(maxAgeDays = 90): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
    const result = this.db.prepare(
      "DELETE FROM plan_patterns WHERE times_reused = 0 AND created_at < ?"
    ).run(cutoff);
    return result.changes as number;
  }
}
