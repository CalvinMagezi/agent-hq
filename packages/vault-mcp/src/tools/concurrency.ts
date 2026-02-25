/**
 * Concurrency & Event tools — vault_lock, vault_unlock, vault_emit_event, vault_read_events
 * Also exports acquireLock/releaseLock helpers for use by other tools.
 */
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ── Shared lock helpers ─────────────────────────────────────────────
function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

export async function acquireLock(vaultPath: string, filepath: string, maxAgeMs: number = 30000): Promise<string> {
    const lockDir = path.join(vaultPath, "_locks");
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });

    const safeName = Buffer.from(filepath).toString("base64url");
    const lockPath = path.join(lockDir, `${safeName}.lock`);
    const lockToken = generateId();

    if (fs.existsSync(lockPath)) {
        const stat = fs.statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age < maxAgeMs) {
            throw new Error(`File is locked: ${filepath} (${Math.round(age / 1000)}s ago)`);
        }
        // Stale lock — remove it
        fs.unlinkSync(lockPath);
    }

    fs.writeFileSync(lockPath, lockToken, { flag: "wx" });
    return lockToken;
}

export async function releaseLock(vaultPath: string, filepath: string, token: string): Promise<void> {
    const safeName = Buffer.from(filepath).toString("base64url");
    const lockPath = path.join(vaultPath, "_locks", `${safeName}.lock`);
    try {
        if (fs.existsSync(lockPath)) {
            const existing = fs.readFileSync(lockPath, "utf-8");
            if (existing === token) fs.unlinkSync(lockPath);
        }
    } catch { /* ignore */ }
}

// ── Register MCP tools ──────────────────────────────────────────────
export function registerConcurrencyTools(server: McpServer, vaultPath: string) {
    // ── vault_lock ──────────────────────────────────────────────────────
    server.tool(
        "vault_lock",
        "Acquire an exclusive lock on a vault file. Returns a token needed to release the lock. Locks auto-expire after 30s by default.",
        {
            path: z.string().describe("Path relative to vault root to lock"),
            max_age_ms: z.number().optional().default(30000).describe("Lock expiry in ms (default: 30000)"),
        },
        async ({ path: filePath, max_age_ms }) => {
            const absPath = path.resolve(vaultPath, filePath);
            try {
                const token = await acquireLock(vaultPath, absPath, max_age_ms);
                return { content: [{ type: "text" as const, text: JSON.stringify({ locked: true, token, path: filePath }) }] };
            } catch (err: any) {
                return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
            }
        },
    );

    // ── vault_unlock ────────────────────────────────────────────────────
    server.tool(
        "vault_unlock",
        "Release a previously acquired lock using the token from vault_lock.",
        {
            path: z.string().describe("Path that was locked"),
            token: z.string().describe("Lock token from vault_lock"),
        },
        async ({ path: filePath, token }) => {
            const absPath = path.resolve(vaultPath, filePath);
            await releaseLock(vaultPath, absPath, token);
            return { content: [{ type: "text" as const, text: `Released lock on ${filePath}` }] };
        },
    );

    // ── vault_emit_event ────────────────────────────────────────────────
    server.tool(
        "vault_emit_event",
        "Emit a structured event to the vault's NDJSON event log (_events/). Useful for cross-agent signaling.",
        {
            type: z.string().describe("Event type, e.g. 'note-created', 'job-claimed'"),
            source: z.string().describe("Event source, e.g. 'vault-mcp', 'discord-relay'"),
            payload: z.record(z.any()).optional().default({}).describe("Arbitrary event data"),
        },
        async ({ type, source, payload }) => {
            const eventsDir = path.join(vaultPath, "_events");
            if (!fs.existsSync(eventsDir)) fs.mkdirSync(eventsDir, { recursive: true });

            const id = `evt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
            const timestamp = new Date().toISOString();
            const event = { id, type, source, timestamp, payload };
            const today = timestamp.split("T")[0];
            const logFile = path.join(eventsDir, `${today}.log`);

            fs.appendFileSync(logFile, JSON.stringify(event) + "\n", "utf-8");
            return { content: [{ type: "text" as const, text: JSON.stringify({ emitted: true, id }) }] };
        },
    );

    // ── vault_read_events ───────────────────────────────────────────────
    server.tool(
        "vault_read_events",
        "Read events from the vault event log for a specific date.",
        {
            date: z.string().optional().describe("Date in YYYY-MM-DD format (default: today)"),
            type_filter: z.string().optional().describe("Filter events by type"),
            limit: z.number().optional().default(50).describe("Max events to return"),
        },
        async ({ date, type_filter, limit }) => {
            const dateStr = date ?? new Date().toISOString().split("T")[0];
            const logFile = path.join(vaultPath, "_events", `${dateStr}.log`);
            if (!fs.existsSync(logFile)) {
                return { content: [{ type: "text" as const, text: JSON.stringify({ events: [], date: dateStr }) }] };
            }

            const lines = fs.readFileSync(logFile, "utf-8").split("\n").filter(l => l.trim().length > 0);
            let events: any[] = [];
            for (const line of lines) {
                try {
                    const evt = JSON.parse(line);
                    if (!type_filter || evt.type === type_filter) events.push(evt);
                } catch { /* skip */ }
            }

            events = events.slice(-limit);
            return { content: [{ type: "text" as const, text: JSON.stringify({ events, count: events.length, date: dateStr }, null, 2) }] };
        },
    );
}
