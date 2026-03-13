/**
 * Shared context type for daemon task modules.
 *
 * All daemon tasks receive a DaemonContext object that provides access
 * to shared infrastructure (vault, search, memory) and daemon utilities
 * (logging, notification, timestamps).
 */

import type { SyncedVaultClient } from "@repo/vault-sync";
import type { SearchClient } from "@repo/vault-client/search";

export interface MemorySystem {
  forgetter: { runCycle: () => { decayed: number; pruned: number; statsAfter: { total: number } } };
  consolidator: { runCycle: () => Promise<any>; refreshMemoryFile: () => Promise<void> };
  /** Memory ingester — converts raw text into structured memory entries via Ollama */
  ingester: {
    ingest(opts: { text: string; source: string; harness?: string }): Promise<number | null>;
    ingestBatch(items: Array<{ text: string; source: string; harness?: string }>): Promise<number[]>;
  };
  awakeReplay: {
    reverseReplay(opts: { triggerRef: string; triggerSource: string; entities?: string[]; timeWindowMs?: number }): Promise<{ replayedCount: number; creditDelta: number }>;
    forwardReplay(opts: { triggerRef: string; triggerSource: string; instructionText: string; limit?: number }): Promise<{ precedents: any[]; replayedCount: number }>;
  };
}

export interface DaemonContext {
  vault: SyncedVaultClient;
  search: SearchClient;
  memorySystem: MemorySystem;
  vaultPath: string;
  openrouterApiKey: string | undefined;
  embeddingModel: string;

  // Daemon utilities
  localTimestamp: () => string;
  recordTaskRun: (taskName: string, success: boolean, error?: string) => void;
  recordDailyActivity: (task: string, detail: string) => void;

  // Notification helpers (imported from notificationService)
  notify: (message: string, dedupeKey?: string) => Promise<void>;
  notifyIfMeaningful: (
    taskName: string,
    summary: string,
    isMeaningful: boolean,
    formatter: (s: string) => string,
  ) => Promise<void>;
}
