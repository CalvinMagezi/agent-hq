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
   * Run one consolidation cycle.
   * Returns the insight generated, or null if nothing to consolidate.
   */
  async runCycle(): Promise<string | null> {
    const memories = getUnconsolidatedMemories(this.db, 15);

    if (memories.length < 3) {
      console.log(`[vault-memory] Consolidation skipped — only ${memories.length} unconsolidated memories (need 3+)`);
      return null;
    }

    const available = await checkOllamaAvailable();
    if (!available) {
      console.warn("[vault-memory] Ollama not available — skipping consolidation");
      return null;
    }

    console.log(`[vault-memory] Consolidating ${memories.length} memories...`);

    const memorySummary = memories
      .map((m) => `[Memory #${m.id}] (${m.source}/${m.harness}) ${m.summary}`)
      .join("\n");

    try {
      const result = await ollamaJSON<ConsolidationResult>(
        CONSOLIDATE_SYSTEM,
        `Consolidate these memories:\n\n${memorySummary}`
      );

      if (!result.insight) {
        console.warn("[vault-memory] Consolidation returned no insight");
        return null;
      }

      // Validate connection IDs refer to real memory IDs
      const validIds = new Set(memories.map((m) => m.id));
      const validConnections = (result.connections ?? []).filter(
        (c) => validIds.has(c.from_id) && validIds.has(c.to_id)
      );

      const sourceIds = memories.map((m) => m.id);
      storeConsolidation(this.db, sourceIds, result.insight, validConnections);

      // Write back to vault as a markdown note
      await this.writeInsightNote(memories, result);

      console.log(`[vault-memory] Consolidation complete: ${result.insight.slice(0, 100)}`);
      return result.insight;
    } catch (err) {
      console.error("[vault-memory] Consolidation failed:", err);
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
      // Replace the section
      updated = existing.replace(
        new RegExp(`${SECTION}[\\s\\S]*?(?=\n## |$)`, "m"),
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
