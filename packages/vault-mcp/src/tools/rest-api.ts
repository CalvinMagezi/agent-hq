/**
 * REST API passthrough tools — vault_rest_search, vault_rest_command, vault_rest_active, vault_rest_periodic
 * These call the Obsidian Local REST API when available, gracefully degrading if Obsidian is closed.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const REST_URL = process.env.OBSIDIAN_REST_URL || "https://127.0.0.1:27124";
const API_KEY = process.env.OBSIDIAN_API_KEY || "";

async function restCall(method: string, endpoint: string, body?: any, accept?: string): Promise<{ ok: boolean; status: number; data: any }> {
    const url = `${REST_URL}${endpoint}`;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
    };
    if (accept) headers["Accept"] = accept;

    try {
        const res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            // @ts-ignore — Bun supports tls option
            tls: { rejectUnauthorized: false },
        });
        const text = await res.text();
        let data: any;
        try { data = JSON.parse(text); } catch { data = text; }
        return { ok: res.ok, status: res.status, data };
    } catch (err: any) {
        return { ok: false, status: 0, data: `Obsidian REST API unavailable (${err.code || err.message}). Is Obsidian running with the Local REST API plugin enabled?` };
    }
}

export function registerRestApiTools(server: McpServer) {
    // ── vault_rest_search ───────────────────────────────────────────────
    server.tool(
        "vault_rest_search",
        "Advanced search using the Obsidian Local REST API. Supports simple text search with context lines. Requires Obsidian to be running.",
        {
            query: z.string().describe("Search query text"),
            context_length: z.number().optional().default(100).describe("Characters of context around matches"),
        },
        async ({ query, context_length }) => {
            const encoded = encodeURIComponent(query);
            const result = await restCall("POST", `/search/simple/?query=${encoded}&contextLength=${context_length}`, undefined, "application/json");
            if (!result.ok) {
                return { content: [{ type: "text" as const, text: `Error (${result.status}): ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
        },
    );

    // ── vault_rest_command ──────────────────────────────────────────────
    server.tool(
        "vault_rest_command",
        "Execute an Obsidian command by ID (e.g. 'app:open-settings', 'editor:toggle-bold'). Use with no arguments to list all available commands.",
        {
            command_id: z.string().optional().describe("Command ID to execute. Omit to list all available commands."),
        },
        async ({ command_id }) => {
            if (!command_id) {
                // List commands
                const result = await restCall("GET", "/commands/");
                if (!result.ok) {
                    return { content: [{ type: "text" as const, text: `Error: ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}` }], isError: true };
                }
                return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
            }

            const result = await restCall("POST", `/commands/${encodeURIComponent(command_id)}/`);
            if (!result.ok) {
                return { content: [{ type: "text" as const, text: `Error executing command '${command_id}': ${JSON.stringify(result.data)}` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: `Executed command: ${command_id}` }] };
        },
    );

    // ── vault_rest_active ───────────────────────────────────────────────
    server.tool(
        "vault_rest_active",
        "Get or set the currently active file in Obsidian. When getting, returns the file content. When setting, opens the specified file.",
        {
            action: z.enum(["get", "set"]).describe("'get' to read active file, 'set' to open a file"),
            file_path: z.string().optional().describe("Required for 'set' — vault-relative path to open"),
        },
        async ({ action, file_path }) => {
            if (action === "get") {
                const result = await restCall("GET", "/active/", undefined, "application/vnd.olrapi.note+json");
                if (!result.ok) {
                    return { content: [{ type: "text" as const, text: `Error: ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}` }], isError: true };
                }
                return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
            }

            // Set active file
            if (!file_path) {
                return { content: [{ type: "text" as const, text: "Error: file_path is required for action='set'" }], isError: true };
            }
            const result = await restCall("PUT", `/active/`, file_path, "text/markdown");
            if (!result.ok) {
                return { content: [{ type: "text" as const, text: `Error: ${JSON.stringify(result.data)}` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: `Opened file: ${file_path}` }] };
        },
    );

    // ── vault_rest_periodic ─────────────────────────────────────────────
    server.tool(
        "vault_rest_periodic",
        "Access periodic notes (daily, weekly, monthly, quarterly, yearly) via the Obsidian Local REST API.",
        {
            period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]).describe("Note period type"),
        },
        async ({ period }) => {
            const result = await restCall("GET", `/periodic/${period}/`, undefined, "application/vnd.olrapi.note+json");
            if (!result.ok) {
                return { content: [{ type: "text" as const, text: `Error: ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
        },
    );
}
