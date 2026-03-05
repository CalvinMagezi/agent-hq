/**
 * Vault Workers — Core Types
 *
 * Lightweight AI agents that proactively improve vault quality.
 * Workers are write-light: they only CREATE new notes, never modify existing ones.
 */

import type { VaultClient } from "@repo/vault-client";
import type { SearchClient } from "@repo/vault-client/search";
import type { AuditLog } from "./auditLog.js";

// ── Worker Interface ──────────────────────────────────────────────────

export interface VaultWorker {
    /** kebab-case identifier, e.g. "gap-detector" */
    name: string;
    /** One-liner shown in status display */
    description: string;
    /** How often this worker runs (milliseconds) */
    intervalMs: number;
    /** Maximum items processed per run */
    batchSize: number;
    /** Execute the worker logic */
    run(ctx: WorkerContext): Promise<WorkerResult>;
}

// ── Worker Context ────────────────────────────────────────────────────

export interface WorkerContext {
    /** Reuses the daemon's VaultClient instance */
    vault: VaultClient;
    /** Reuses the daemon's SearchClient instance */
    search: SearchClient;
    /**
     * Make a single LLM call.
     * Tries Ollama first → Gemini Flash Lite → Gemini Flash.
     * Prompt is truncated to 8K chars. Max output: 1024 tokens.
     */
    llm: (prompt: string, systemPrompt?: string) => Promise<string>;
    /** Append-only audit log writer */
    audit: AuditLog;
    /** Abort signal — fired when daemon shuts down */
    abortSignal: AbortSignal;
    /** Vault path (absolute) */
    vaultPath: string;
    /** Local timestamp string (same format as daemon) */
    timestamp: () => string;
}

// ── Worker Result ─────────────────────────────────────────────────────

export interface WorkerResult {
    /** How many items were scanned/evaluated */
    processed: number;
    /** How many notes were created (never > batchSize) */
    created: number;
    /** Human-readable summary of what the worker did */
    summary: string;
    /** How many LLM calls were made */
    llmCalls: number;
    /** Approximate token usage */
    tokensUsed: { input: number; output: number };
}
