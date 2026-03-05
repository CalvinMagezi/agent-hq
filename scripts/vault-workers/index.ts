/**
 * Vault Workers — Worker Runner & LLM Wrapper
 *
 * Central hub for vault workers:
 * - WorkerRunner: wraps each worker.run() with error handling + status writing
 * - llmCall: tries Ollama → Gemini Flash Lite → Gemini Flash
 * - getWorkers(): returns all six registered workers
 * - createWorkerRunner(): factory used by the daemon
 */

import * as fs from "fs";
import * as path from "path";
import type { VaultClient } from "@repo/vault-client";
import type { SearchClient } from "@repo/vault-client/search";
import type { VaultWorker, WorkerContext, WorkerResult } from "./types.js";
import { AuditLog } from "./auditLog.js";

// ── Worker Imports ────────────────────────────────────────────────────

import { gapDetector } from "./workers/gapDetector.js";
import { ideaConnector } from "./workers/ideaConnector.js";
import { projectNudger } from "./workers/projectNudger.js";
import { noteEnricher } from "./workers/noteEnricher.js";
import { dailyPreparer } from "./workers/dailyPreparer.js";
import { orphanRescuer } from "./workers/orphanRescuer.js";

// ── Worker Registry ───────────────────────────────────────────────────

const WORKERS: VaultWorker[] = [
    gapDetector,
    ideaConnector,
    projectNudger,
    noteEnricher,
    dailyPreparer,
    orphanRescuer,
];

export function getWorkers(): VaultWorker[] {
    return WORKERS;
}

// ── LLM Call Wrapper ─────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.VAULT_WORKER_MODEL ?? "qwen3.5:9b";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/** Truncate text to approximate token limit (8K chars ≈ 2K tokens) */
function truncate(text: string, maxChars = 8000): string {
    return text.length > maxChars ? text.substring(0, maxChars) + "\n...[truncated]" : text;
}

/**
 * Make a single LLM call using the worker model cascade:
 * Ollama (free) → Gemini Flash Lite (near-free) → Gemini Flash
 *
 * Returns the assistant response text.
 */
async function llmCall(prompt: string, systemPrompt?: string): Promise<string> {
    const truncatedPrompt = truncate(prompt);

    // ── Try Ollama first (free, local) ─────────────────────────────
    try {
        const body: Record<string, unknown> = {
            model: OLLAMA_MODEL,
            messages: [
                ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
                { role: "user", content: truncatedPrompt },
            ],
            max_tokens: 1024,
            stream: false,
        };

        const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            // 30s timeout — Ollama can be slow for first call
            signal: AbortSignal.timeout(30_000),
        });

        if (res.ok) {
            const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
            const content = data.choices[0]?.message?.content;
            if (content) return content;
        }
    } catch {
        // Fall through to cloud models
    }

    // ── Fall back to Gemini via direct API ─────────────────────────
    if (!GEMINI_API_KEY) {
        throw new Error("Vault worker LLM: Ollama unavailable and GEMINI_API_KEY not set");
    }

    // Try Gemini Flash Lite first (cheapest), then Flash
    const geminiModels = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

    for (const model of geminiModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
            const body = {
                contents: [
                    ...(systemPrompt ? [{
                        role: "user",
                        parts: [{ text: systemPrompt }],
                    }, {
                        role: "model",
                        parts: [{ text: "Understood. I'll follow those instructions." }],
                    }] : []),
                    { role: "user", parts: [{ text: truncatedPrompt }] },
                ],
                generationConfig: { maxOutputTokens: 1024 },
            };

            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });

            if (res.ok) {
                const data = (await res.json()) as {
                    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
                };
                const text = data.candidates[0]?.content?.parts[0]?.text;
                if (text) return text;
            }
        } catch {
            // Try next model
        }
    }

    throw new Error("Vault worker LLM: all models failed (Ollama + Gemini Flash Lite + Flash)");
}

// ── Worker Status File ────────────────────────────────────────────────

interface WorkerStat {
    lastRun: string | null;
    lastSuccess: string | null;
    processed: number;
    created: number;
    llmCalls: number;
    errorCount: number;
    lastError: string | null;
}

function localTimestamp(): string {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    return (
        d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
        sign + pad(Math.floor(Math.abs(off) / 60)) + ":" + pad(Math.abs(off) % 60)
    );
}

// ── WorkerRunner ──────────────────────────────────────────────────────

export class WorkerRunner {
    private vault: VaultClient;
    private search: SearchClient;
    private audit: AuditLog;
    private abortController: AbortController;
    private stats = new Map<string, WorkerStat>();
    private statusFile: string;

    constructor(vault: VaultClient, search: SearchClient) {
        this.vault = vault;
        this.search = search;
        this.audit = new AuditLog(vault.vaultPath);
        this.abortController = new AbortController();
        this.statusFile = path.join(vault.vaultPath, "_system", "WORKER-STATUS.md");
    }

    /** Abort any in-flight worker runs (called on daemon shutdown). */
    abort(): void {
        this.abortController.abort();
    }

    /** Execute a single worker, wrapped with error handling and status tracking. */
    async run(worker: VaultWorker): Promise<void> {
        if (process.env.VAULT_WORKERS_ENABLED !== "true") return;

        const ctx: WorkerContext = {
            vault: this.vault,
            search: this.search,
            llm: llmCall,
            audit: this.audit,
            abortSignal: this.abortController.signal,
            vaultPath: this.vault.vaultPath,
            timestamp: localTimestamp,
        };

        const stat = this.stats.get(worker.name) ?? {
            lastRun: null,
            lastSuccess: null,
            processed: 0,
            created: 0,
            llmCalls: 0,
            errorCount: 0,
            lastError: null,
        };

        console.log(`[worker:${worker.name}] Starting run...`);
        const startMs = Date.now();

        try {
            const result: WorkerResult = await worker.run(ctx);
            stat.lastRun = localTimestamp();
            stat.lastSuccess = stat.lastRun;
            stat.processed += result.processed;
            stat.created += result.created;
            stat.llmCalls += result.llmCalls;
            this.stats.set(worker.name, stat);

            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
            console.log(
                `[worker:${worker.name}] Done in ${elapsed}s — ` +
                `processed=${result.processed} created=${result.created} ` +
                `llmCalls=${result.llmCalls} — ${result.summary}`,
            );
        } catch (err) {
            stat.lastRun = localTimestamp();
            stat.errorCount++;
            stat.lastError = String(err).substring(0, 120);
            this.stats.set(worker.name, stat);
            console.error(`[worker:${worker.name}] Error:`, err);

            this.audit.append({
                worker: worker.name,
                action: "error",
                details: stat.lastError,
            });
        }

        await this.writeStatus();
    }

    /** Write per-worker stats to _system/WORKER-STATUS.md */
    private async writeStatus(): Promise<void> {
        try {
            const lines: string[] = [
                "---",
                "noteType: system-file",
                "fileName: worker-status",
                `lastUpdated: "${localTimestamp()}"`,
                "---",
                "# Worker Status",
                "",
                `**Last Updated:** ${localTimestamp()}`,
                `**Workers Enabled:** ${process.env.VAULT_WORKERS_ENABLED === "true"}`,
                "",
                "| Worker | Last Run | Success | Processed | Created | LLM Calls | Errors | Last Error |",
                "|--------|----------|---------|-----------|---------|-----------|--------|------------|",
            ];

            for (const [name, stat] of this.stats) {
                const lastRun = stat.lastRun ?? "never";
                const lastSuccess = stat.lastSuccess ?? "never";
                const lastError = stat.lastError ? stat.lastError.substring(0, 40) : "-";
                lines.push(
                    `| ${name} | ${lastRun} | ${lastSuccess} | ${stat.processed} | ${stat.created} | ${stat.llmCalls} | ${stat.errorCount} | ${lastError} |`,
                );
            }

            const systemDir = path.dirname(this.statusFile);
            if (!fs.existsSync(systemDir)) {
                fs.mkdirSync(systemDir, { recursive: true });
            }
            fs.writeFileSync(this.statusFile, lines.join("\n") + "\n", "utf-8");
        } catch (err) {
            console.error("[worker-runner] Failed to write WORKER-STATUS.md:", err);
        }
    }
}

// ── Factory ───────────────────────────────────────────────────────────

export function createWorkerRunner(vault: VaultClient, search: SearchClient): WorkerRunner {
    return new WorkerRunner(vault, search);
}
