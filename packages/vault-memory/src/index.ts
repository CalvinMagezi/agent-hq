/**
 * @repo/vault-memory
 *
 * Always-on persistent memory for Agent-HQ.
 * Powered by Ollama + qwen3.5:9b (free, local, always available).
 *
 * Usage:
 *   import { createMemorySystem } from "@repo/vault-memory";
 *
 *   const { ingester, consolidator, querier, db } = createMemorySystem("/path/to/.vault");
 *
 *   // Ingest anything
 *   await ingester.ingest({ text: "Job completed: ...", source: "job-abc", harness: "claude-code" });
 *
 *   // Consolidate (run every 30min via daemon)
 *   await consolidator.runCycle();
 *   await consolidator.refreshMemoryFile();
 *
 *   // Query for context injection
 *   const ctx = querier.getRecentContext({ limit: 8 });
 *   // ctx.formatted → inject into system prompt
 */

export { openMemoryDB, storeMemory, getMemoryStats, decayOldMemories, pruneWeakMemories } from "./db.js";
export type { Memory, Consolidation } from "./db.js";

export { MemoryIngester } from "./ingester.js";
export { MemoryConsolidator } from "./consolidator.js";
export { MemoryQuerier } from "./querier.js";
export type { MemoryContext } from "./querier.js";
export { MemoryForgetter } from "./forgetter.js";
export type { ForgetterResult } from "./forgetter.js";

export { ollamaChat, checkOllamaAvailable, MEMORY_MODEL } from "./ollamaClient.js";
export type { OllamaChatMessage } from "./ollamaClient.js";

import { openMemoryDB } from "./db.js";
import { MemoryIngester } from "./ingester.js";
import { MemoryConsolidator } from "./consolidator.js";
import { MemoryQuerier } from "./querier.js";
import { MemoryForgetter } from "./forgetter.js";

/**
 * Create the full memory system from a vault path.
 * Call once at startup, share the returned objects.
 */
export function createMemorySystem(vaultPath: string) {
  const db = openMemoryDB(vaultPath);
  const ingester = new MemoryIngester(db);
  const consolidator = new MemoryConsolidator(db, vaultPath);
  const querier = new MemoryQuerier(db);
  const forgetter = new MemoryForgetter(db);

  return { db, ingester, consolidator, querier, forgetter };
}
