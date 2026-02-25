#!/usr/bin/env bun
/**
 * Agent-HQ Unified Vault MCP Server
 * 
 * A single MCP server that replaces both the filesystem MCP and Docker REST MCP.
 * Runs natively via `bun` over stdio — no Docker, no Python, no npx.
 * 
 * Tools provided:
 *   Filesystem: vault_read, vault_write, vault_patch, vault_list, vault_delete, vault_search
 *   Notes:      vault_create_note, vault_update_note
 *   Concurrency: vault_lock, vault_unlock, vault_emit_event, vault_read_events
 *   REST API:   vault_rest_search, vault_rest_command, vault_rest_active, vault_rest_periodic
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import * as fs from "fs";

import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerConcurrencyTools } from "./tools/concurrency.js";
import { registerRestApiTools } from "./tools/rest-api.js";
import { registerAdvancedTools } from "./tools/advanced.js";

// ── Configuration ────────────────────────────────────────────────────
const VAULT_PATH = process.env.VAULT_PATH || path.resolve(process.cwd(), "../../.vault");

if (!fs.existsSync(VAULT_PATH)) {
    console.error(`❌ Vault not found at: ${VAULT_PATH}`);
    console.error(`   Set VAULT_PATH environment variable to the vault directory.`);
    process.exit(1);
}

// ── Create MCP Server ────────────────────────────────────────────────
const server = new McpServer({
    name: "agent-hq-vault",
    version: "1.0.0",
});

// Register all tool categories
registerFilesystemTools(server, VAULT_PATH);
registerNoteTools(server, VAULT_PATH);
registerConcurrencyTools(server, VAULT_PATH);
registerRestApiTools(server);
registerAdvancedTools(server, VAULT_PATH);

// ── Start ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
