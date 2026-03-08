/**
 * MemoryIngester — converts raw text into a structured memory entry.
 *
 * Calls Ollama (qwen3.5:9b) to extract:
 *   - summary (1-2 sentences)
 *   - entities (key people, projects, tools)
 *   - topics (2-4 tags)
 *   - importance (0.0 - 1.0)
 *
 * Then stores the result in the memory DB.
 */

import type { Database } from "bun:sqlite";
import { storeMemory } from "./db.js";
import { ollamaJSON, checkOllamaAvailable } from "./ollamaClient.js";

const SYSTEM_PROMPT = `You are a memory extraction assistant for a personal AI agent hub called Agent-HQ.

Your job is to read a piece of text and extract structured memory from it.

Return a JSON object with exactly these fields:
{
  "summary": "1-2 sentence summary of what happened or was learned",
  "entities": ["array", "of", "key", "names", "projects", "tools"],
  "topics": ["2-4", "topic", "tags"],
  "importance": 0.7
}

importance scale:
- 0.9-1.0: critical decisions, major achievements, key user preferences
- 0.7-0.8: significant work done, useful insights, project updates
- 0.5-0.6: routine task completions, minor notes
- 0.3-0.4: low-value background info
`;

/**
 * Salience detector — implements "Synaptic Tagging" from neuroscience.
 *
 * When important events occur (decisions, failures, milestones), the brain
 * tags those synapses for priority consolidation. We do the same: scan for
 * salience markers in raw text and boost the importance score immediately
 * at encoding time, before the memory enters the consolidation queue.
 */
const SALIENCE_PATTERN = /\b(deadline|urgent|critical|blocker|blocked|decision|breakthrough|failed|failure|error|crash|security|vulnerability|breach|approved|rejected|milestone|launch|shipped|signed|cancelled|crisis|risk|escalat|budget|contract|deal|acquisition|pivot|layoff|hire|resign|fund(ing|ed)?|raise|partnership)\b/i;

function applySalienceBoost(text: string, importance: number, topics: string[]): { importance: number; topics: string[] } {
  if (!SALIENCE_PATTERN.test(text)) return { importance, topics };
  const boosted = Math.min(importance * 1.5, 1.0);
  const updatedTopics = topics.includes("high-salience") ? topics : [...topics, "high-salience"];
  return { importance: boosted, topics: updatedTopics };
}

interface ExtractedMemory {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

export class MemoryIngester {
  private db: Database;
  private available: boolean | null = null;
  private lastAvailabilityCheck = 0;
  private static readonly RETRY_AFTER_MS = 5 * 60_000; // re-check Ollama every 5 min on failure

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Ingest a piece of text as a memory.
   * Returns the new memory ID, or null if Ollama is unavailable or text is too short.
   */
  async ingest(opts: {
    text: string;
    source: string;   // e.g. 'discord', 'job-abc123', 'vault-note'
    harness?: string; // e.g. 'claude-code', 'gemini-cli', 'relay'
  }): Promise<number | null> {
    const { text, source, harness = "unknown" } = opts;

    // Skip very short or empty content
    if (text.trim().length < 30) return null;

    // Check Ollama availability — re-check after RETRY_AFTER_MS so the daemon
    // self-heals if Ollama restarts without needing a process restart.
    const now = Date.now();
    if (this.available === null || (!this.available && now - this.lastAvailabilityCheck > MemoryIngester.RETRY_AFTER_MS)) {
      this.lastAvailabilityCheck = now;
      this.available = await checkOllamaAvailable();
      if (this.available) console.log("[vault-memory] Ollama connection restored");
    }
    if (!this.available) {
      console.warn("[vault-memory] Ollama not available — skipping ingestion (will retry in 5m)");
      return null;
    }

    try {
      const extracted = await ollamaJSON<ExtractedMemory>(
        SYSTEM_PROMPT,
        `Extract memory from this text:\n\n${text.slice(0, 2000)}`
      );

      // Validate shape
      if (!extracted.summary || !Array.isArray(extracted.entities) || !Array.isArray(extracted.topics)) {
        console.warn("[vault-memory] Invalid extraction shape, skipping");
        return null;
      }

      // Apply salience boost (synaptic tagging) — important events get flagged
      // immediately at encoding time so they survive the consolidation queue.
      const baseImportance = Math.max(0, Math.min(1, extracted.importance ?? 0.5));
      const { importance, topics } = applySalienceBoost(
        text,
        baseImportance,
        extracted.topics.slice(0, 5)
      );

      const id = storeMemory(this.db, {
        source,
        harness,
        raw_text: text.slice(0, 4000),
        summary: extracted.summary,
        entities: extracted.entities.slice(0, 10),
        topics,
        importance,
      });

      console.log(`[vault-memory] Ingested memory #${id} from ${source}: ${extracted.summary.slice(0, 80)}`);
      return id;
    } catch (err) {
      console.error("[vault-memory] Ingestion failed:", err);
      return null;
    }
  }

  /**
   * Batch ingest multiple texts. Useful for job completion summaries.
   */
  async ingestBatch(items: Array<{ text: string; source: string; harness?: string }>): Promise<number[]> {
    const ids: number[] = [];
    for (const item of items) {
      const id = await this.ingest(item);
      if (id !== null) ids.push(id);
    }
    return ids;
  }
}
