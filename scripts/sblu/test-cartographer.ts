/**
 * Test runner for SBLU-1 Vault Cartographer
 *
 * Runs the Cartographer worker directly (without the full daemon) and
 * prints the results to stdout.
 *
 * Usage:
 *   bun scripts/sblu/test-cartographer.ts
 */

import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";
import { AuditLog } from "../vault-workers/auditLog.js";
import { vaultCartographer } from "../vault-workers/workers/vaultCartographer.js";
import type { WorkerContext } from "../vault-workers/types.js";

// ── Resolve vault path ────────────────────────────────────────────────
const VAULT_PATH =
    process.env.VAULT_PATH ??
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.vault");

if (!fs.existsSync(VAULT_PATH)) {
    console.error(`Vault not found at: ${VAULT_PATH}`);
    console.error("Set VAULT_PATH env var to the .vault directory path.");
    process.exit(1);
}

console.log(`\n${"═".repeat(60)}`);
console.log("  SBLU-1 Vault Cartographer — Direct Test");
console.log(`${"═".repeat(60)}`);
console.log(`  Vault: ${VAULT_PATH}`);
console.log(`${"═".repeat(60)}\n`);

// ── Set up minimal worker context ─────────────────────────────────────
const vault = new VaultClient(VAULT_PATH);
const search = new SearchClient(VAULT_PATH);
const audit = new AuditLog(VAULT_PATH);

// Minimal LLM shim — uses Ollama if available, else skips
async function llm(prompt: string, systemPrompt?: string): Promise<string> {
    try {
        const res = await fetch("http://localhost:11434/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: process.env.VAULT_WORKER_MODEL ?? "qwen3.5:9b",
                messages: [
                    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
                    { role: "user", content: prompt.substring(0, 6000) },
                ],
                max_tokens: 1024,
                stream: false,
                format: "json",
            }),
            signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
            const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
            return data.choices[0]?.message?.content ?? "{}";
        }
    } catch (err) {
        console.warn("  [llm] Ollama unavailable, SBLU will use baseline only");
    }
    return "{}";
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

const ctx: WorkerContext = {
    vault,
    search,
    llm,
    audit,
    abortSignal: new AbortController().signal,
    vaultPath: VAULT_PATH,
    timestamp: localTimestamp,
};

// ── Run the worker ─────────────────────────────────────────────────────
const startMs = Date.now();
console.log(`Starting Cartographer at ${localTimestamp()}...\n`);

try {
    const result = await vaultCartographer.run(ctx);
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

    console.log(`\n${"═".repeat(60)}`);
    console.log("  Results");
    console.log(`${"═".repeat(60)}`);
    console.log(`  Elapsed:   ${elapsed}s`);
    console.log(`  Processed: ${result.processed} files`);
    console.log(`  LLM Calls: ${result.llmCalls}`);
    console.log(`  Summary:   ${result.summary}`);
    console.log(`${"═".repeat(60)}\n`);

    // Print the generated LINK-HEALTH.md
    const linkHealthPath = path.join(VAULT_PATH, "_system", "LINK-HEALTH.md");
    if (fs.existsSync(linkHealthPath)) {
        console.log("Generated _system/LINK-HEALTH.md:\n");
        const content = fs.readFileSync(linkHealthPath, "utf-8");
        // Print first 80 lines
        const lines = content.split("\n").slice(0, 80);
        console.log(lines.join("\n"));
        if (content.split("\n").length > 80) {
            console.log("\n...[truncated]");
        }
    }

    // Print SBLU-REGISTRY.md cartographer section
    const registryPath = path.join(VAULT_PATH, "_system", "SBLU-REGISTRY.md");
    if (fs.existsSync(registryPath)) {
        const regContent = fs.readFileSync(registryPath, "utf-8");
        const match = regContent.match(/### cartographer[\s\S]*?```yaml[\s\S]*?```/);
        if (match) {
            console.log("\nSBLU Registry — cartographer:\n");
            console.log(match[0]);
        }
    }

    console.log("\n✓ Test passed");
} catch (err) {
    console.error("\n✗ Test failed:", err);
    process.exit(1);
}
