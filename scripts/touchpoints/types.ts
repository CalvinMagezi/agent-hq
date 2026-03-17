/**
 * Touch Points — Core Types
 *
 * Thin layer on the EventBus that adds content inspection to raw vault events.
 * Touch points are declarative — they describe what they react to and what they
 * do. The TouchPointEngine handles registration, debouncing, circuit breaking,
 * and chain propagation.
 */

import type { SyncedVaultClient } from "@repo/vault-sync";
import type { SearchClient } from "@repo/vault-client/search";
import type { VaultEvent, VaultEventType } from "@repo/vault-sync";
import type { ChannelRouter } from "./channelRouter.js";

// ─── Context ──────────────────────────────────────────────────────────────────

export interface MemoryIngester {
  ingest(opts: {
    text: string;
    source: string;
    harness?: string;
  }): Promise<number | null>;
}

export interface TouchPointContext {
  vault: SyncedVaultClient;
  search: SearchClient;
  /** LLM call with Ollama → Gemini fallback cascade */
  llm: (prompt: string, systemPrompt?: string) => Promise<string>;
  memoryIngester: MemoryIngester;
  notify: ChannelRouter;
  vaultPath: string;
  /** Whether dry-run mode is active — observe + log but don't write */
  dryRun: boolean;
}

// ─── Result ───────────────────────────────────────────────────────────────────

export interface TouchPointEmit {
  touchPoint: string;
  data: Record<string, unknown>;
}

export interface TouchPointResult {
  observation: string;
  actions: string[];
  emit?: TouchPointEmit[];
  meaningful: boolean; // whether to notify the user
}

// ─── Touch Point ──────────────────────────────────────────────────────────────

export interface TouchPoint {
  /** kebab-case identifier */
  name: string;
  description: string;
  /** Which EventBus event types trigger this touch point */
  triggers: VaultEventType[];
  /** Vault path prefix filter — only fire for events matching this prefix */
  pathFilter?: string;
  /** Per-path debounce in ms (default: 5000) */
  debounceMs?: number;
  evaluate(
    event: VaultEvent,
    ctx: TouchPointContext,
    incomingData?: Record<string, unknown>
  ): Promise<TouchPointResult | null>;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface TouchPointConfig {
  enabled: boolean;     // master kill switch
  dryRun: boolean;      // observe + log, no file writes
  touchPoints: Record<string, boolean>;
  chains: Record<string, boolean>;
}

export const DEFAULT_CONFIG: TouchPointConfig = {
  enabled: true,
  dryRun: false,
  touchPoints: {
    "frontmatter-fixer": true,
    "size-watchdog": true,
    "tag-suggester": true,
    "folder-organizer": true,
    "conversation-learner": true,
    "stale-thread-detector": true,
    "connection-weaver": true,
    "daily-synthesis": true,
    "vault-health": true,
  },
  chains: {
    "new-note-quality": true,
    "conversation-harvest": true,
    "growth-alert": true,
    "daily-synthesis": true,
    "vault-health": true,
  },
};
