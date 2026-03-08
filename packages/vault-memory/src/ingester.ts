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

interface ExtractedMemory {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

export class MemoryIngester {
  private db: Database;
  private available: boolean | null = null;

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

    // Check Ollama availability on first call
    if (this.available === null) {
      this.available = await checkOllamaAvailable();
    }
    if (!this.available) {
      console.warn("[vault-memory] Ollama not available — skipping ingestion");
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

      const id = storeMemory(this.db, {
        source,
        harness,
        raw_text: text.slice(0, 4000),
        summary: extracted.summary,
        entities: extracted.entities.slice(0, 10),
        topics: extracted.topics.slice(0, 5),
        importance: Math.max(0, Math.min(1, extracted.importance ?? 0.5)),
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
