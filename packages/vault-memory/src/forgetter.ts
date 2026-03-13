/**
 * MemoryForgetter — implements "Synaptic Homeostasis" for vault memory.
 *
 * Inspired by the Synaptic Homeostasis Hypothesis (SHY): the brain doesn't
 * passively forget — it actively scales down weak synapses during sleep to
 * preserve the signal-to-noise ratio of important memories.
 *
 * Applied here: a daily decay cycle with schema-guided tiered rates:
 *   1. Standard decay (1.5%/day) for unconsolidated memories
 *   2. Accelerated decay (5%/day) for consolidated memories with low vault connectivity
 *   3. Protected decay (0.5%/day) for consolidated memories anchoring well-linked schemas
 *   4. Resist decay for high-access and replayed memories
 *   5. Prune memories below threshold after 60 days
 *
 * Result: important/schema-anchoring memories persist;
 *         already-synthesized raw data is cleaned up faster;
 *         low-value noise is quietly pruned over time.
 */

import type { Database } from "bun:sqlite";
import { decayOldMemories, pruneWeakMemories, getMemoryStats } from "./db.js";
import { getBacklinks } from "@repo/vault-client/graph";

/** Minimum backlinks on an insight note to qualify as "well-connected schema" */
const HIGH_LINK_THRESHOLD = 3;

export interface ForgetterResult {
  decayed: number;   // memories whose importance was reduced
  pruned: number;    // memories deleted (importance fell below threshold)
  statsAfter: { total: number; unconsolidated: number; consolidations: number };
}

export class MemoryForgetter {
  private db: Database;
  private vaultPath: string;

  constructor(db: Database, vaultPath: string) {
    this.db = db;
    this.vaultPath = vaultPath;
  }

  /**
   * Run one forgetting cycle with schema-guided tiered decay.
   *
   * Tier 1 (Standard): 1.5%/day for unconsolidated memories >7 days old.
   *   A 0.5-importance memory takes ~30 days to reach the 0.05 prune threshold.
   *
   * Tier 2 (Accelerated): 5%/day for consolidated memories whose insight notes
   *   have few backlinks (<3). The core insight has been extracted — raw data
   *   can be cleaned up faster.
   *
   * Tier 3 (Protected): 0.5%/day for consolidated memories whose insight notes
   *   are well-linked (3+ backlinks). These anchor important knowledge schemas
   *   and should resist decay strongly.
   *
   * Protected: memories with access_count > 0 or replay_count > 0 get partial
   * restore, since being accessed/replayed signals ongoing relevance.
   */
  runCycle(): ForgetterResult {
    const { decayed, pruned } = this.db.transaction(() => {
      // ── Tier 1: Standard decay — unconsolidated memories ──────────────
      const standardDecayed = decayOldMemories(this.db, 0.015, 7);

      // ── Tiers 2 & 3: Schema-guided decay for consolidated memories ───
      const { lowLink, highLink } = this.classifyConsolidatedMemories();
      let acceleratedDecayed = 0;
      let protectedDecayed = 0;

      const cutoff7d = new Date(Date.now() - 7 * 86400_000).toISOString();

      if (lowLink.length > 0) {
        const placeholders = lowLink.map(() => "?").join(",");
        acceleratedDecayed = this.db.prepare(`
          UPDATE memories
          SET importance = MAX(0.01, importance - 0.05)
          WHERE id IN (${placeholders}) AND created_at < ?
        `).run(...lowLink, cutoff7d).changes;
      }

      if (highLink.length > 0) {
        const placeholders = highLink.map(() => "?").join(",");
        protectedDecayed = this.db.prepare(`
          UPDATE memories
          SET importance = MAX(0.01, importance - 0.005)
          WHERE id IN (${placeholders}) AND created_at < ?
        `).run(...highLink, cutoff7d).changes;
      }

      const decayed = standardDecayed + acceleratedDecayed + protectedDecayed;

      // ── Access-count protection (unchanged) ───────────────────────────
      const cutoff14d = new Date(Date.now() - 14 * 86400_000).toISOString();
      this.db.prepare(`
        UPDATE memories
        SET importance = MIN(1.0, importance + 0.0075)
        WHERE access_count > 0
          AND consolidated = 0
          AND created_at < ?
      `).run(cutoff14d);

      // ── Replay-count protection (unchanged) ───────────────────────────
      this.db.prepare(`
        UPDATE memories
        SET importance = MIN(1.0, importance + 0.0075)
        WHERE replay_count > 0
          AND consolidated = 0
          AND created_at < ?
      `).run(cutoff14d);

      // ── Prune memories below relevance floor ──────────────────────────
      const pruned = pruneWeakMemories(this.db, 0.05, 60);

      return { decayed, pruned };
    })();

    const statsAfter = getMemoryStats(this.db);

    if (decayed > 0 || pruned > 0) {
      console.log(`[vault-memory/forgetter] Decayed ${decayed} memories, pruned ${pruned}`);
    }

    return { decayed, pruned, statsAfter };
  }

  /**
   * Classify consolidated memories by the link density of their insight notes.
   *
   * Queries the consolidations table for source_ids, derives each insight note's
   * path, then counts backlinks via the vault graph. Memories whose insight notes
   * have 3+ backlinks are "high link" (schema anchors); the rest are "low link"
   * (insight extracted, raw data expendable).
   *
   * Runs once per 24hr cycle — filesystem scan cost is acceptable.
   */
  private classifyConsolidatedMemories(): { lowLink: number[]; highLink: number[] } {
    const consolidations = this.db.prepare(
      "SELECT source_ids, created_at FROM consolidations ORDER BY created_at DESC"
    ).all() as Array<{ source_ids: string; created_at: string }>;

    if (consolidations.length === 0) return { lowLink: [], highLink: [] };

    const lowLink: number[] = [];
    const highLink: number[] = [];

    for (const c of consolidations) {
      const sourceIds = JSON.parse(c.source_ids) as number[];
      if (sourceIds.length === 0) continue;

      // Derive insight note path — matches consolidator.ts:230-232 pattern
      const date = c.created_at.slice(0, 10);
      const time = c.created_at.slice(11, 19).replace(/:/g, "-");
      const notePath = `Notebooks/Memories/${date}-${time}-insight.md`;

      // Count backlinks in the vault graph
      let linkCount = 0;
      try {
        const backlinks = getBacklinks(this.vaultPath, notePath);
        linkCount = backlinks.length;
      } catch { /* note may not exist or vault scan failed — treat as low link */ }

      const bucket = linkCount >= HIGH_LINK_THRESHOLD ? highLink : lowLink;
      for (const id of sourceIds) {
        bucket.push(id);
      }
    }

    return { lowLink, highLink };
  }
}
