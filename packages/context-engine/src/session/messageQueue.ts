/**
 * Message Queue — Per-session batching and interrupt detection.
 *
 * Handles rapid-fire user messages by batching them within a debounce window.
 * Also detects interrupts (new user messages arriving during assistant streaming).
 */

import type { SurfaceType, MessageBatchConfig, BatchedInput } from "./types.js";

interface PendingMessage {
  content: string;
  surface: SurfaceType;
  timestamp: string;
}

interface PendingBatch {
  messages: PendingMessage[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: BatchedInput) => void;
}

const DEFAULT_BATCH_CONFIG: MessageBatchConfig = {
  batchWindowMs: 1500,
  maxBatchMessages: 10,
};

const SURFACE_DEFAULTS: Partial<Record<SurfaceType, MessageBatchConfig>> = {
  discord: { batchWindowMs: 2000, maxBatchMessages: 10 },
  cli: { batchWindowMs: 500, maxBatchMessages: 5 },
  rest: { batchWindowMs: 500, maxBatchMessages: 5 },
  whatsapp: { batchWindowMs: 2000, maxBatchMessages: 10 },
  telegram: { batchWindowMs: 2000, maxBatchMessages: 10 },
  agent: { batchWindowMs: 0, maxBatchMessages: 1 }, // no batching for agent-to-agent
};

export class MessageQueue {
  private batches: Map<string, PendingBatch> = new Map();
  private configOverrides: Partial<Record<SurfaceType, MessageBatchConfig>>;

  constructor(configOverrides?: Partial<Record<SurfaceType, MessageBatchConfig>>) {
    this.configOverrides = configOverrides ?? {};
  }

  /**
   * Enqueue a user message. Returns a promise that resolves when the batch
   * window closes (or max batch size is reached), with all batched messages merged.
   *
   * For surfaces with batchWindowMs=0 (agent), resolves immediately.
   */
  enqueue(
    sessionId: string,
    msg: { content: string; surface: SurfaceType }
  ): Promise<BatchedInput> {
    const config = this.getConfig(msg.surface);

    // No batching — return immediately
    if (config.batchWindowMs <= 0) {
      const now = new Date().toISOString();
      return Promise.resolve({
        messages: [{ content: msg.content, surface: msg.surface, timestamp: now }],
        mergedContent: msg.content,
        batchSize: 1,
      });
    }

    const key = `${sessionId}:${msg.surface}`;
    const existing = this.batches.get(key);
    const now = new Date().toISOString();
    const pending: PendingMessage = {
      content: msg.content,
      surface: msg.surface,
      timestamp: now,
    };

    if (existing) {
      // Add to existing batch, reset timer
      clearTimeout(existing.timer);
      existing.messages.push(pending);

      // If max batch size reached, flush immediately
      if (existing.messages.length >= config.maxBatchMessages) {
        this.batches.delete(key);
        const result = this.buildBatch(existing.messages);
        existing.resolve(result);
        return Promise.resolve(result);
      }

      // Reset debounce timer
      return new Promise<BatchedInput>((resolve) => {
        existing.resolve = resolve;
        existing.timer = setTimeout(() => {
          this.batches.delete(key);
          resolve(this.buildBatch(existing.messages));
        }, config.batchWindowMs);
      });
    }

    // New batch
    return new Promise<BatchedInput>((resolve) => {
      const timer = setTimeout(() => {
        const batch = this.batches.get(key);
        if (batch) {
          this.batches.delete(key);
          resolve(this.buildBatch(batch.messages));
        }
      }, config.batchWindowMs);

      this.batches.set(key, {
        messages: [pending],
        timer,
        resolve,
      });
    });
  }

  /** Force-flush any pending batch for a session+surface. */
  flush(sessionId: string, surface: SurfaceType): BatchedInput | null {
    const key = `${sessionId}:${surface}`;
    const batch = this.batches.get(key);
    if (!batch) return null;

    clearTimeout(batch.timer);
    this.batches.delete(key);
    const result = this.buildBatch(batch.messages);
    batch.resolve(result);
    return result;
  }

  /** Flush all pending batches for a session (all surfaces). */
  flushAll(sessionId: string): BatchedInput[] {
    const results: BatchedInput[] = [];
    for (const [key, batch] of this.batches.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        clearTimeout(batch.timer);
        this.batches.delete(key);
        const result = this.buildBatch(batch.messages);
        batch.resolve(result);
        results.push(result);
      }
    }
    return results;
  }

  /** Get the number of pending batches (for testing/debugging). */
  get pendingCount(): number {
    return this.batches.size;
  }

  // ─── Private ──────────────────────────────────────────────

  private getConfig(surface: SurfaceType): MessageBatchConfig {
    return (
      this.configOverrides[surface] ??
      SURFACE_DEFAULTS[surface] ??
      DEFAULT_BATCH_CONFIG
    );
  }

  private buildBatch(messages: PendingMessage[]): BatchedInput {
    return {
      messages: messages.map((m) => ({
        content: m.content,
        surface: m.surface,
        timestamp: m.timestamp,
      })),
      mergedContent: messages.map((m) => m.content).join("\n"),
      batchSize: messages.length,
    };
  }
}
