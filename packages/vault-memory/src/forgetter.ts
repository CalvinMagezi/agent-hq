/**
 * MemoryForgetter — implements "Synaptic Homeostasis" for vault memory.
 *
 * Inspired by the Synaptic Homeostasis Hypothesis (SHY): the brain doesn't
 * passively forget — it actively scales down weak synapses during sleep to
 * preserve the signal-to-noise ratio of important memories.
 *
 * Applied here: a daily decay cycle that:
 *   1. Reduces importance of old unconsolidated memories (decay)
 *   2. Deletes memories that have decayed below a threshold (pruning)
 *   3. Resists decay for high-access memories (access-count protection)
 *
 * Result: important/frequently-accessed memories persist;
 *         low-value noise is quietly cleaned up over time.
 */

import type { Database } from "bun:sqlite";
import { decayOldMemories, pruneWeakMemories, getMemoryStats } from "./db.js";

export interface ForgetterResult {
  decayed: number;   // memories whose importance was reduced
  pruned: number;    // memories deleted (importance fell below threshold)
  statsAfter: { total: number; unconsolidated: number; consolidations: number };
}

export class MemoryForgetter {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Run one forgetting cycle.
   *
   * Decay schedule: importance decreases by 1.5%/day for unconsolidated
   * memories older than 7 days. At this rate, a 0.5-importance memory takes
   * ~30 days to fall below the 0.05 prune threshold (unless consolidated first).
   *
   * High-importance memories (0.9+) take ~56 days to decay to 0.05 if never
   * consolidated — giving the consolidation cycle plenty of time to preserve them.
   *
   * Protected: memories with access_count > 0 get half the decay rate,
   * since being accessed signals ongoing relevance.
   */
  runCycle(): ForgetterResult {
    // Run decay + access-protection restore as a single atomic transaction.
    // If the process is killed mid-cycle, the DB stays consistent — no partial
    // decays that strip protection from high-access memories.
    const { decayed, pruned } = this.db.transaction(() => {
      // Step 1: Standard decay — 1.5%/day for unconsolidated memories older than 7 days
      const decayed = decayOldMemories(this.db, 0.015, 7);

      // Step 2: Partial restore for frequently-accessed memories (half-rate decay after 14 days).
      // These memories are still actively used by agents, so they resist forgetting.
      this.db.prepare(`
        UPDATE memories
        SET importance = MIN(1.0, importance + 0.0075)
        WHERE access_count > 0
          AND consolidated = 0
          AND created_at < ?
      `).run(new Date(Date.now() - 14 * 86400_000).toISOString());

      // Step 3: Prune memories that have decayed below the relevance floor AND are old enough.
      // Two-phase: decay must happen first so freshly-decayed memories are included.
      const pruned = pruneWeakMemories(this.db, 0.05, 60);

      return { decayed, pruned };
    })();

    const statsAfter = getMemoryStats(this.db);

    if (decayed > 0 || pruned > 0) {
      console.log(`[vault-memory/forgetter] Decayed ${decayed} memories, pruned ${pruned}`);
    }

    return { decayed, pruned, statsAfter };
  }
}
