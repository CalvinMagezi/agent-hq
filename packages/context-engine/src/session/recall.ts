/**
 * Recall Engine — Full-recall search across archived conversation history.
 *
 * Searches checkpoints (via FTS5) and raw messages to find relevant past context.
 * Results can be injected into frames via extraInjections.
 */

import type { SessionStore } from "./sessionStore.js";
import type { SessionMessage, Checkpoint, RecallResult } from "./types.js";

export class RecallEngine {
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /**
   * Search past conversation by query text.
   * Searches both checkpoint summaries (FTS5) and raw messages (FTS5).
   * Results ranked by relevance score.
   */
  recallByQuery(sessionId: string, query: string, limit: number = 5): RecallResult[] {
    const results: RecallResult[] = [];

    // Sanitize query for FTS5 (remove special chars that break FTS syntax)
    const safeQuery = query.replace(/[^\w\s]/g, " ").trim();
    if (!safeQuery) return [];

    // Search checkpoints
    try {
      const checkpoints = this.store.searchCheckpoints(sessionId, safeQuery, limit);
      for (const cp of checkpoints) {
        // Create a synthetic message from the checkpoint summary
        results.push({
          message: {
            seq: cp.messageSeqStart,
            sessionId,
            segmentIndex: cp.segmentIndex,
            role: "assistant",
            surface: "agent",
            content: `[Checkpoint ${cp.segmentIndex}] ${cp.summary}`,
            timestamp: cp.createdAt,
            status: "final",
          },
          checkpoint: cp,
          relevanceScore: 0.9, // Checkpoint matches are high-value
        });
      }
    } catch {
      // FTS5 query may fail on edge cases — non-critical
    }

    // Search raw messages
    try {
      const messages = this.store.searchMessages(sessionId, safeQuery, limit);
      for (const msg of messages) {
        // Skip if we already have this segment via checkpoint
        if (results.some((r) => r.checkpoint?.segmentIndex === msg.segmentIndex)) continue;

        results.push({
          message: msg,
          relevanceScore: 0.7,
        });
      }
    } catch {
      // FTS5 query may fail — non-critical
    }

    // Sort by relevance, deduplicate, limit
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results.slice(0, limit);
  }

  /**
   * Retrieve messages within a time range.
   */
  recallByTimeRange(
    sessionId: string,
    startTime: string,
    endTime: string
  ): SessionMessage[] {
    // Get all messages and filter by time range
    // (SessionStore doesn't have a time-range query, so we use getRecentMessages
    // with a high limit and filter client-side)
    const all = this.store.getRecentMessages(sessionId, 1000);
    return all.filter((m) => {
      if (!m.timestamp) return false;
      return m.timestamp >= startTime && m.timestamp <= endTime;
    });
  }

  /**
   * Retrieve all messages from a specific segment.
   */
  recallBySegment(sessionId: string, segmentIndex: number): SessionMessage[] {
    return this.store.getSegmentMessages(sessionId, segmentIndex);
  }

  /**
   * Check if a user message seems to reference past conversation.
   * Used to decide whether to trigger recall injection.
   */
  static looksLikePastReference(text: string): boolean {
    const patterns = [
      /\bearlier\b/i,
      /\bbefore\b/i,
      /\bremember when\b/i,
      /\bwe discussed\b/i,
      /\bwe talked about\b/i,
      /\byou (said|mentioned|told)\b/i,
      /\bgo back to\b/i,
      /\bpreviously\b/i,
      /\blast time\b/i,
      /\bwhat (did|was)\b.*\b(say|decide|agree)\b/i,
    ];
    return patterns.some((p) => p.test(text));
  }
}
