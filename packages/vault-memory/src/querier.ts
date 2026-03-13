/**
 * MemoryQuerier — retrieves relevant memories for context injection.
 *
 * Used by the ContextEngine memory layer to pull live memories
 * instead of only reading the static MEMORY.md file.
 *
 * No LLM needed for basic queries — pure SQLite filtering.
 * Differential pattern separation: when two memories share 3+ topic tags,
 * the unique "delta" is extracted via Ollama in the background (cached in DB),
 * preserving nuanced information instead of discarding overlapping memories.
 */

import type { Database } from "bun:sqlite";
import {
  getRecentMemories,
  getConsolidationHistory,
  getMemoryStats,
  touchMemory,
  storeDeltaSummary,
  parseMemoryRow,
  type Memory,
  type Consolidation,
} from "./db.js";

export interface MemoryContext {
  /** Formatted string ready for injection into a system prompt */
  formatted: string;
  /** Raw memories retrieved */
  memories: Memory[];
  /** Recent consolidation insights */
  insights: string[];
  /** Stats for debugging */
  stats: { total: number; unconsolidated: number; consolidations: number };
}

export class MemoryQuerier {
  private db: Database;
  /** Memories queued for background delta extraction */
  private pendingDeltas: Map<number, { candidateId: number; existingSummary: string }> = new Map();

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Get recent high-importance memories formatted for context injection.
   * Returns an empty context if no memories exist yet.
   */
  getRecentContext(opts: { limit?: number; topicFilter?: string[] } = {}): MemoryContext {
    const { limit = 8 } = opts;

    let memories = getRecentMemories(this.db, limit * 2);

    // Optional topic filter
    if (opts.topicFilter && opts.topicFilter.length > 0) {
      const filterSet = new Set(opts.topicFilter.map((t) => t.toLowerCase()));
      memories = memories.filter((m) =>
        m.topics.some((t) => filterSet.has(t.toLowerCase()))
      );
    }

    // Novelty deduplication with differential pattern separation
    memories = this.deduplicateByNovelty(memories, limit);

    // Touch accessed memories so the forgetter knows they're still relevant
    for (const m of memories) {
      touchMemory(this.db, m.id);
    }

    const insights = getConsolidationHistory(this.db, 3).map((c) => c.insight);
    const stats = getMemoryStats(this.db);

    return {
      memories,
      insights,
      stats,
      formatted: this.formatForContext(memories, insights),
    };
  }

  /**
   * Process queued delta extractions in the background.
   * Called from daemon during idle time (piggybacks on consolidation cycle).
   * Returns the number of deltas computed.
   */
  async processPendingDeltas(): Promise<number> {
    if (this.pendingDeltas.size === 0) return 0;

    const { ollamaChat, checkOllamaAvailable } = await import("./ollamaClient.js");

    if (!(await checkOllamaAvailable())) return 0;

    let computed = 0;
    for (const [memId, info] of this.pendingDeltas) {
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(memId);
      if (!row) {
        this.pendingDeltas.delete(memId);
        continue;
      }
      const memory = parseMemoryRow(row);

      const prompt = `Given two memories that share similar topics:

EXISTING (already in context): "${info.existingSummary}"
CANDIDATE (overlapping): "${memory.summary}"

Extract ONLY the unique information in the CANDIDATE that is NOT covered by the EXISTING memory. If there is nothing unique, respond with exactly "NO_DELTA".
Keep it to one concise sentence.`;

      try {
        const delta = await ollamaChat([
          { role: "system", content: "You extract unique differential information between two overlapping memories. Be extremely concise." },
          { role: "user", content: prompt },
        ]);

        if (delta && !delta.includes("NO_DELTA")) {
          storeDeltaSummary(this.db, memId, delta.trim());
          computed++;
        } else {
          // Mark as checked with no unique info — prevents re-computation
          storeDeltaSummary(this.db, memId, "");
        }
      } catch (err) {
        console.error(`[vault-memory/querier] Delta extraction failed for memory #${memId}:`, err);
      }

      this.pendingDeltas.delete(memId);
    }

    if (computed > 0) {
      console.log(`[vault-memory/querier] Computed ${computed} memory deltas`);
    }

    return computed;
  }

  /**
   * Format memories as a compact block for system prompt injection.
   * Keeps it short to preserve token budget.
   */
  private formatForContext(memories: Memory[], insights: string[]): string {
    if (memories.length === 0 && insights.length === 0) return "";

    const parts: string[] = [];

    if (insights.length > 0) {
      parts.push("**Recent Agent Insights:**");
      for (const insight of insights) {
        parts.push(`- ${insight}`);
      }
    }

    if (memories.length > 0) {
      parts.push("\n**Recent Memory:**");
      for (const m of memories) {
        const age = this.relativeAge(m.created_at);
        parts.push(`- [${m.source}/${age}] ${m.summary}`);
      }
    }

    return parts.join("\n");
  }

  /**
   * Differential pattern separation — keeps the injection set diverse while
   * preserving unique information from overlapping memories.
   *
   * If two memories share 3+ topic tags:
   *   - If the candidate has a cached delta_summary → include it (using the delta)
   *   - If the candidate has delta_summary="" → skip (checked, nothing unique)
   *   - If no delta cached yet → queue for background extraction, skip this round
   *
   * High-salience memories always survive regardless.
   */
  private deduplicateByNovelty(memories: Memory[], limit: number): Memory[] {
    const seen: Memory[] = [];

    for (const candidate of memories) {
      const isHighSalience = candidate.topics.includes("high-salience");

      // Always include high-salience memories, but still respect the limit.
      if (isHighSalience) {
        seen.push(candidate);
        if (seen.length >= limit) break;
        continue;
      }

      // Check overlap with already-selected memories
      let overlapWith: Memory | null = null;
      for (const existing of seen) {
        const overlap = candidate.topics.filter((t) => existing.topics.includes(t)).length;
        if (overlap >= 3) {
          overlapWith = existing;
          break;
        }
      }

      if (!overlapWith) {
        // No overlap — include normally
        seen.push(candidate);
      } else if (candidate.delta_summary) {
        // Delta already cached and non-empty — include with differential summary
        seen.push({ ...candidate, summary: candidate.delta_summary });
      } else if (candidate.delta_summary === "") {
        // Checked previously, nothing unique — skip (same as old behavior)
      } else {
        // No delta computed yet — queue for background extraction, skip this round
        this.pendingDeltas.set(candidate.id, {
          candidateId: candidate.id,
          existingSummary: overlapWith.summary,
        });
      }

      if (seen.length >= limit) break;
    }

    return seen;
  }

  private relativeAge(isoDate: string): string {
    const ms = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
}
