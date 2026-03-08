/**
 * MemoryConsolidator — the "brain during sleep" cycle.
 *
 * Runs periodically (default: every 30 minutes via daemon).
 * Takes unconsolidated memories, finds connections, generates insights,
 * then writes them back to:
 *   1. The consolidations table (SQLite)
 *   2. Notebooks/Memories/ as a markdown note (visible in Obsidian)
 */

import type { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import {
  getUnconsolidatedMemories,
  getConsolidationHistory,
  storeConsolidation,
  type Memory,
} from "./db.js";
import { ollamaJSON, ollamaChat, checkOllamaAvailable } from "./ollamaClient.js";

const CONSOLIDATE_SYSTEM = `You are a memory consolidation agent for Agent-HQ, a personal AI hub.

You receive a list of recent memories from various agent harnesses (Claude Code, Gemini CLI, Discord relay, etc).

Your job is to:
1. Find meaningful connections between memories
2. Identify cross-cutting patterns or insights
3. Generate one key insight that synthesizes all of them

Return a JSON object with exactly:
{
  "connections": [
    { "from_id": 1, "to_id": 3, "relationship": "brief description of how they relate" }
  ],
  "insight": "One key cross-cutting insight or pattern discovered across these memories"
}

Be concise. Focus on what's actionable or meaningful for the user (Calvin Magezi, CTO building AI systems).`;

interface ConsolidationResult {
  connections: Array<{ from_id: number; to_id: number; relationship: string }>;
  insight: string;
}

export class MemoryConsolidator {
  private db: Database;
  private vaultPath: string;

  constructor(db: Database, vaultPath: string) {
    this.db = db;
    this.vaultPath = vaultPath;
  }

  /**
   * Run one consolidation cycle using topic clustering.
   *
   * Inspired by hippocampal sharp-wave ripple replay: the brain doesn't replay
   * all memories at once — it replays related memories in clusters, strengthening
   * connections within each cluster before doing cross-cluster integration.
   *
   * Here: we group unconsolidated memories by their most common topic, process
   * the densest cluster first (most related memories), then do a cross-cluster
   * synthesis if multiple clusters were consolidated.
   *
   * Returns the final insight generated, or null if nothing to consolidate.
   */
  async runCycle(): Promise<string | null> {
    const memories = getUnconsolidatedMemories(this.db, 30);

    if (memories.length < 3) {
      console.log(`[vault-memory] Consolidation skipped — only ${memories.length} unconsolidated memories (need 3+)`);
      return null;
    }

    const available = await checkOllamaAvailable();
    if (!available) {
      console.warn("[vault-memory] Ollama not available — skipping consolidation");
      return null;
    }

    // ── Cluster memories by topic (hippocampal replay grouping) ──────────
    const clusters = this.clusterByTopic(memories);
    const sortedClusters = [...clusters.entries()]
      .sort((a, b) => b[1].length - a[1].length); // largest cluster first

    const clusterInsights: string[] = [];
    let lastInsight: string | null = null;

    for (const [topic, cluster] of sortedClusters) {
      if (cluster.length < 2) continue; // skip singletons
      const insight = await this.consolidateCluster(cluster, topic);
      if (insight) {
        clusterInsights.push(insight);
        lastInsight = insight;
      }
    }

    // ── Cross-cluster synthesis (schema integration) ──────────────────────
    // If multiple clusters produced insights, synthesize a meta-insight.
    if (clusterInsights.length >= 2) {
      const metaInsight = await this.synthesizeClusters(clusterInsights);
      if (metaInsight) lastInsight = metaInsight;
    }

    // Fallback: if no clusters with 2+ memories, consolidate all together
    if (clusterInsights.length === 0 && memories.length >= 3) {
      lastInsight = await this.consolidateCluster(memories.slice(0, 15), "general");
    }

    return lastInsight;
  }

  // ── Private: Clustering ───────────────────────────────────────────────

  /** Group memories by their most frequent topic across the batch. */
  private clusterByTopic(memories: Memory[]): Map<string, Memory[]> {
    const clusters = new Map<string, Memory[]>();

    for (const memory of memories) {
      // Assign to the first topic (highest priority tag from ingester)
      const primaryTopic = memory.topics[0] ?? "general";
      const existing = clusters.get(primaryTopic) ?? [];
      existing.push(memory);
      clusters.set(primaryTopic, existing);
    }

    return clusters;
  }

  /** Consolidate one topic cluster. Returns the insight or null. */
  private async consolidateCluster(cluster: Memory[], topic: string): Promise<string | null> {
    // Cap cluster size to prevent oversized Ollama payloads
    const capped = cluster.slice(0, 12);
    console.log(`[vault-memory] Consolidating cluster "${topic}" (${capped.length}/${cluster.length} memories)...`);

    const memorySummary = capped
      .map((m) => `[Memory #${m.id}] (${m.source}/${m.harness}) ${m.summary.slice(0, 200)}`)
      .join("\n");

    try {
      const result = await ollamaJSON<ConsolidationResult>(
        CONSOLIDATE_SYSTEM,
        `Consolidate these memories (topic cluster: "${topic}"):\n\n${memorySummary}`
      );

      if (!result.insight) return null;

      const validIds = new Set(capped.map((m) => m.id));
      const validConnections = (result.connections ?? []).filter(
        (c) => validIds.has(c.from_id) && validIds.has(c.to_id)
      );

      storeConsolidation(this.db, capped.map((m) => m.id), result.insight, validConnections);
      await this.writeInsightNote(capped, result);

      console.log(`[vault-memory] Cluster "${topic}" insight: ${result.insight.slice(0, 100)}`);
      return result.insight;
    } catch (err) {
      console.error(`[vault-memory] Cluster "${topic}" consolidation failed:`, err);
      return null;
    }
  }

  /** Cross-cluster meta-synthesis: find patterns spanning multiple topic clusters. */
  private async synthesizeClusters(insights: string[]): Promise<string | null> {
    const META_SYSTEM = `You are a meta-synthesis agent. Given a list of insights from different topic clusters,
identify the single most important cross-cutting pattern or connection that spans them all.
Return JSON: { "insight": "one concise cross-cluster insight", "connections": [] }`;

    try {
      const result = await ollamaJSON<ConsolidationResult>(
        META_SYSTEM,
        `Find the cross-cluster pattern in these insights:\n\n${insights.map((i, n) => `${n + 1}. ${i}`).join("\n")}`
      );
      if (!result.insight) return null;
      console.log(`[vault-memory] Cross-cluster insight: ${result.insight.slice(0, 100)}`);
      return result.insight;
    } catch {
      return null;
    }
  }

  /**
   * Update _system/MEMORY.md with top insights from the consolidation history.
   * Called after consolidation to keep the shared memory file fresh.
   */
  async refreshMemoryFile(): Promise<void> {
    const history = getConsolidationHistory(this.db, 10);
    if (history.length === 0) return;

    const memoryPath = path.join(this.vaultPath, "_system", "MEMORY.md");
    if (!fs.existsSync(memoryPath)) return;

    const existing = fs.readFileSync(memoryPath, "utf-8");

    // Find or create the "## Agent Insights" section
    const SECTION = "## Agent Insights (Auto-Generated)";
    const insightLines = history.map((c, i) =>
      `- [${c.created_at.slice(0, 10)}] ${c.insight}`
    );
    const section = `${SECTION}\n\n${insightLines.join("\n")}\n`;

    let updated: string;
    if (existing.includes(SECTION)) {
      // Replace the section — escape SECTION so metacharacters in the string don't break the regex
      const escapedSection = SECTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      updated = existing.replace(
        new RegExp(`${escapedSection}[\\s\\S]*?(?=\n## |$)`, "m"),
        section
      );
    } else {
      // Append at end
      updated = existing.trimEnd() + "\n\n" + section;
    }

    fs.writeFileSync(memoryPath, updated, "utf-8");
    console.log("[vault-memory] Updated _system/MEMORY.md with agent insights");
  }

  // ── Private ─────────────────────────────────────────────────────────

  private async writeInsightNote(
    memories: Memory[],
    result: ConsolidationResult
  ): Promise<void> {
    const notesDir = path.join(this.vaultPath, "Notebooks", "Memories");
    fs.mkdirSync(notesDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toISOString().slice(11, 19).replace(/:/g, "-");
    const filename = `${date}-${time}-insight.md`;
    const filePath = path.join(notesDir, filename);

    const sources = [...new Set(memories.map((m) => m.source))].join(", ");
    const harnesses = [...new Set(memories.map((m) => m.harness))].join(", ");
    const allTopics = [...new Set(memories.flatMap((m) => m.topics))].slice(0, 8);

    const connectionLines = result.connections
      .map((c) => `- Memory #${c.from_id} ↔ #${c.to_id}: ${c.relationship}`)
      .join("\n");

    const memorySummaries = memories
      .map((m) => `- **#${m.id}** (${m.source}): ${m.summary}`)
      .join("\n");

    const content = `---
noteType: consolidation-insight
tags: [${allTopics.map((t) => `"${t}"`).join(", ")}]
sources: [${sources}]
harnesses: [${harnesses}]
memoriesConsolidated: ${memories.length}
createdAt: "${new Date().toISOString()}"
---

# Agent Memory Insight — ${date}

## Key Insight

${result.insight}

## Connections Found

${connectionLines || "_No connections identified_"}

## Source Memories

${memorySummaries}
`;

    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`[vault-memory] Wrote insight note: Notebooks/Memories/${filename}`);
  }
}
