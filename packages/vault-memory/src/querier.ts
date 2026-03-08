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

    memories = memories.slice(0, limit);

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

  private relativeAge(isoDate: string): string {
    const ms = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
}
