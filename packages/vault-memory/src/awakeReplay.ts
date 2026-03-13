import { Database } from "bun:sqlite";
import { Memory, bumpReplayCount, storeReplay, parseMemoryRow } from "./db.js";

export class AwakeReplayEngine {
  constructor(private db: Database, private vaultPath: string) {}

  /**
   * Reverse Replay (Credit Assignment)
   * Triggered by: job completion, task completion, [DONE:] tag
   */
  async reverseReplay(opts: {
    triggerRef: string;
    triggerSource: string;
    entities?: string[];
    timeWindowMs?: number; // default: 24h
  }): Promise<{ replayedCount: number; creditDelta: number }> {
    const timeWindow = opts.timeWindowMs ?? 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - timeWindow).toISOString();

    // 1. Find memories created during the job's lifetime or related by entities
    // We look for direct job memories and associative memories
    const directJobPattern = `%${opts.triggerRef}%`;
    
    let query = `
      SELECT * FROM memories 
      WHERE (source LIKE ? OR summary LIKE ?)
      AND created_at > ?
    `;
    const params: any[] = [directJobPattern, directJobPattern, cutoff];

    if (opts.entities && opts.entities.length > 0) {
      const entityConditions = opts.entities.map(() => "entities LIKE ?").join(" OR ");
      query += ` OR (${entityConditions})`;
      opts.entities.forEach(e => params.push(`%${e}%`));
    }

    const memories = this.db.prepare(query).all(...params).map(parseMemoryRow) as Memory[];
    
    if (memories.length === 0) {
      return { replayedCount: 0, creditDelta: 0 };
    }

    // 2. Order chronologically (ASC) to form the sequence
    const sequence = memories.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const memoryIds = sequence.map(m => m.id);

    // 3. Apply credit delta: base 0.05 + 0.01 per chain step (capped at 0.15)
    const creditDelta = Math.min(0.15, 0.05 + (memories.length * 0.01));

    // Update importance in DB
    const placeholders = memoryIds.map(() => "?").join(",");
    this.db.prepare(`
      UPDATE memories 
      SET importance = MIN(1.0, importance + ?) 
      WHERE id IN (${placeholders})
    `).run(creditDelta, ...memoryIds);

    // 4. Bump replay_count on all involved memories (bookmarking)
    bumpReplayCount(this.db, memoryIds);

    // 5. Store replay record
    storeReplay(this.db, {
      trigger_type: 'reverse',
      trigger_source: opts.triggerSource,
      trigger_ref: opts.triggerRef,
      memory_ids: memoryIds,
      sequence: memoryIds,
      credit_delta: creditDelta
    });

    return { replayedCount: memories.length, creditDelta };
  }

  /**
   * Forward Replay (Planning/Preplay)
   * Triggered by: new job creation, new task creation
   */
  async forwardReplay(opts: {
    triggerRef: string;
    triggerSource: string;
    instructionText: string;
    limit?: number; // default: 5
  }): Promise<{ precedents: Memory[]; replayedCount: number }> {
    // 1. Extract entities/topics from instruction text via fast regex
    const cues = this.extractCues(opts.instructionText);
    
    // 2. Query memories sharing entities or topics
    const precedents = this.findRelatedMemories(cues, { limit: opts.limit ?? 5 });

    if (precedents.length === 0) {
      return { precedents: [], replayedCount: 0 };
    }

    const memoryIds = precedents.map(m => m.id);

    // 3. Bump replay_count (bookmarking)
    bumpReplayCount(this.db, memoryIds);

    // 4. Store replay record
    storeReplay(this.db, {
      trigger_type: 'forward',
      trigger_source: opts.triggerSource,
      trigger_ref: opts.triggerRef,
      memory_ids: memoryIds,
      sequence: memoryIds, // Sequence is same as IDs for forward replay (ranked by importance)
      credit_delta: 0
    });

    return { precedents, replayedCount: precedents.length };
  }

  /**
   * Fast cue extraction (regex only, <50ms)
   */
  private extractCues(text: string): { entities: string[]; topics: string[] } {
    const entities = new Set<string>();
    const topics = new Set<string>();

    // Capitalized phrases (Entities)
    const capMatches = text.matchAll(/\b([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*)\b/g);
    for (const match of capMatches) {
      if (match[1].length > 3) entities.add(match[1]);
    }

    // #tags (Topics)
    const tagMatches = text.matchAll(/#([a-zA-Z0-9_]+)/g);
    for (const match of tagMatches) {
      topics.add(match[1]);
    }

    // @mentions (Entities)
    const mentionMatches = text.matchAll(/@([a-zA-Z0-9_]+)/g);
    for (const match of mentionMatches) {
      entities.add(match[1]);
    }

    // Quoted strings (Entities/Specifics)
    const quoteMatches = text.matchAll(/"([^"]+)"|'([^']+)'/g);
    for (const match of quoteMatches) {
      const val = match[1] || match[2];
      if (val && val.length > 2) entities.add(val);
    }

    return {
      entities: Array.from(entities),
      topics: Array.from(topics)
    };
  }

  /**
   * Memory retrieval by cue matching
   */
  private findRelatedMemories(cues: { entities: string[]; topics: string[] }, opts: { limit: number }): Memory[] {
    if (cues.entities.length === 0 && cues.topics.length === 0) {
      // Fallback: just return the most important recent memories
      return this.db.prepare(`
        SELECT * FROM memories 
        WHERE consolidated = 0 
        ORDER BY importance DESC, created_at DESC 
        LIMIT ?
      `).all(opts.limit).map(parseMemoryRow) as Memory[];
    }

    const conditions: string[] = [];
    const params: any[] = [];

    cues.entities.forEach(e => {
      conditions.push("entities LIKE ?");
      params.push(`%${e}%`);
    });

    cues.topics.forEach(t => {
      conditions.push("topics LIKE ?");
      params.push(`%${t}%`);
    });

    const query = `
      SELECT * FROM memories 
      WHERE (${conditions.join(" OR ")})
      ORDER BY importance DESC, created_at DESC 
      LIMIT ?
    `;
    params.push(opts.limit);

    return this.db.prepare(query).all(...params).map(parseMemoryRow) as Memory[];
  }
}
