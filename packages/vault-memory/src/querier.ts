/**
 * MemoryQuerier — retrieves relevant memories for context injection.
 *
 * Used by the ContextEngine memory layer to pull live memories
 * instead of only reading the static MEMORY.md file.
 *
 * No LLM needed for basic queries — pure SQLite filtering.
 * Optional: Ollama-powered semantic ranking for topic-matched results.
 */

import type { Database } from "bun:sqlite";
import {
  getRecentMemories,
  getConsolidationHistory,
  getMemoryStats,
  touchMemory,
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

    // Novelty deduplication: suppress redundant memories, promote novel ones.
    // Inspired by schema-based consolidation — info already encoded in existing
    // patterns gets lower injection priority; genuinely new topics surface first.
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
   * Novelty deduplication — keeps the injection set diverse.
   *
   * If two memories share 3+ topic tags, they are "redundant" (same schema).
   * In that case, keep only the higher-importance one. This prevents a single
   * topic (e.g. "security") from flooding the context window and crowding out
   * other important signals.
   *
   * High-salience memories always survive deduplication regardless.
   */
  private deduplicateByNovelty(memories: Memory[], limit: number): Memory[] {
    const seen: Memory[] = [];

    for (const candidate of memories) {
      const isHighSalience = candidate.topics.includes("high-salience");

      // Always include high-salience memories, but still respect the limit.
      // Without this, a system generating many salience matches floods the context window.
      if (isHighSalience) {
        seen.push(candidate);
        if (seen.length >= limit) break;
        continue;
      }

      // Check overlap with already-selected memories
      let redundant = false;
      for (const existing of seen) {
        const overlap = candidate.topics.filter((t) => existing.topics.includes(t)).length;
        if (overlap >= 3) {
          redundant = true;
          break;
        }
      }

      if (!redundant) seen.push(candidate);
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
