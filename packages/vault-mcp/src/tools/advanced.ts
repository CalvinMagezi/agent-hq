/**
 * Advanced Agent & Orchestration Tools
 * Provides agent-hq specific features: jobs, delegation, threading, context, and multi-read.
 */
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAdvancedTools(server: McpServer, vaultPath: string) {
    const resolve = (...parts: string[]) => path.join(vaultPath, ...parts);
    const nowISO = () => new Date().toISOString();
    const generateId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // ── vault_system_context ────────────────────────────────────────────
    server.tool(
        "vault_system_context",
        "Read the core system context (SOUL, MEMORY, CONFIG) used for bootstrapping agent behaviors.",
        {},
        async () => {
            const readSysFile = (name: string) => {
                const p = resolve("_system", name);
                return fs.existsSync(p) ? matter(fs.readFileSync(p, "utf-8")).content.trim() : "";
            };

            const soul = readSysFile("SOUL.md");
            const memory = readSysFile("MEMORY.md");
            const configRaw = readSysFile("CONFIG.md");

            // Parse CONFIG.md table
            const config: Record<string, string> = {};
            const lines = configRaw.split("\n");
            for (const line of lines) {
                if (line.startsWith("|") && !line.includes("---") && !line.includes("Key")) {
                    const parts = line.split("|").map(s => s.trim());
                    if (parts.length >= 3 && parts[1]) {
                        config[parts[1]] = parts[2];
                    }
                }
            }

            return {
                content: [{ type: "text" as const, text: JSON.stringify({ soul, memory, config }, null, 2) }],
            };
        },
    );

    // ── vault_create_job ────────────────────────────────────────────────
    server.tool(
        "vault_create_job",
        "Create a new background or RPC job for the agent-hq swarm.",
        {
            instruction: z.string().describe("The prompt/instruction for the job"),
            type: z.enum(["background", "rpc", "interactive"]).optional().default("background"),
            priority: z.number().optional().default(50),
            security_profile: z.enum(["minimal", "standard", "guarded", "admin"]).optional().default("standard"),
        },
        async ({ instruction, type, priority, security_profile }) => {
            const jobId = `job-${generateId()}`;
            const filePath = resolve("_jobs/pending", `${jobId}.md`);

            const frontmatter = {
                jobId,
                type,
                status: "pending",
                priority,
                securityProfile: security_profile,
                createdAt: nowISO(),
                updatedAt: nowISO()
            };

            const content = `# Instruction\n${instruction}\n`;
            fs.writeFileSync(filePath, matter.stringify("\n" + content + "\n", frontmatter), "utf-8");

            return { content: [{ type: "text" as const, text: JSON.stringify({ jobId, status: "pending", path: path.relative(vaultPath, filePath) }) }] };
        },
    );

    // ── vault_create_delegation ─────────────────────────────────────────
    server.tool(
        "vault_create_delegation",
        "Delegate a task to a Relay bot (e.g., Discord or specialized worker).",
        {
            instruction: z.string().describe("What the relay should do"),
            job_id: z.string().describe("The parent jobId that spawned this delegation"),
            target_harness: z.string().optional().default("any").describe("Specific harness to target (e.g. 'discord', 'any')"),
            depends_on: z.array(z.string()).optional().default([]).describe("Task IDs that must complete first"),
        },
        async ({ instruction, job_id, target_harness, depends_on }) => {
            const taskId = `task-${generateId()}`;
            const filePath = resolve("_delegation/pending", `${taskId}.md`);

            const frontmatter = {
                taskId,
                jobId: job_id,
                targetHarnessType: target_harness,
                status: "pending",
                priority: 50,
                deadlineMs: 600000,
                dependsOn: depends_on,
                createdAt: nowISO()
            };

            const content = `# Task Instruction\n${instruction}\n`;
            fs.writeFileSync(filePath, matter.stringify("\n" + content + "\n", frontmatter), "utf-8");

            return { content: [{ type: "text" as const, text: JSON.stringify({ taskId, status: "pending", targetHarnessType: target_harness }) }] };
        },
    );

    // ── vault_create_thread ─────────────────────────────────────────────
    server.tool(
        "vault_create_thread",
        "Create a new active conversation thread.",
        {
            title: z.string().optional().default("New Conversation").describe("Thread title"),
        },
        async ({ title }) => {
            const threadId = `thread-${generateId()}`;
            const filePath = resolve("_threads/active", `${threadId}.md`);

            const frontmatter = {
                threadId,
                status: "active",
                createdAt: nowISO()
            };

            const content = `# ${title}\n`;
            fs.writeFileSync(filePath, matter.stringify("\n" + content + "\n", frontmatter), "utf-8");

            return { content: [{ type: "text" as const, text: JSON.stringify({ threadId }) }] };
        },
    );

    // ── vault_append_message ────────────────────────────────────────────
    server.tool(
        "vault_append_message",
        "Append a message to a conversation thread.",
        {
            thread_id: z.string().describe("The threadId"),
            role: z.enum(["user", "assistant"]).describe("Message sender role"),
            content: z.string().describe("Message text"),
        },
        async ({ thread_id, role, content }) => {
            let filePath = resolve("_threads/active", `${thread_id}.md`);
            if (!fs.existsSync(filePath)) {
                filePath = resolve("_threads/archived", `${thread_id}.md`);
                if (!fs.existsSync(filePath)) {
                    return { content: [{ type: "text" as const, text: `Error: Thread not found: ${thread_id}` }], isError: true };
                }
            }

            const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
            const entry = `\n## ${role === "user" ? "User" : "Assistant"} (${time})\n\n${content}\n`;
            fs.appendFileSync(filePath, entry, "utf-8");

            return { content: [{ type: "text" as const, text: `Appended message to ${thread_id}` }] };
        },
    );

    // ── vault_log_activity ──────────────────────────────────────────────
    server.tool(
        "vault_log_activity",
        "Append a message to the rolling Recent Activity log.",
        {
            role: z.enum(["user", "assistant"]),
            content: z.string(),
            source: z.enum(["discord", "chat", "job"]),
            channel: z.string().optional(),
        },
        async ({ role, content: rawContent, source, channel }) => {
            const filePath = resolve("_system", "RECENT_ACTIVITY.md");
            let entries: any[] = [];

            if (fs.existsSync(filePath)) {
                try {
                    const { data } = matter(fs.readFileSync(filePath, "utf-8"));
                    entries = (data.entries as any[]) ?? [];
                } catch { /* ignore */ }
            }

            const timestamp = nowISO();
            const truncatedContext = rawContent.length > 200 ? rawContent.substring(0, 200) + "..." : rawContent;

            entries.push({ role, content: truncatedContext, timestamp, source, channel });

            const MAX_ENTRIES = 30;
            if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);

            const lines = entries.slice().reverse().map(e => {
                const time = new Date(e.timestamp).toLocaleString();
                return `### ${e.role} [${e.source}] — ${time}\n\n${e.content}`;
            });

            const body = `# Recent Activity\n\n${lines.join("\n\n---\n\n")}`;
            fs.writeFileSync(filePath, matter.stringify("\n" + body + "\n", { entries, updatedAt: timestamp }), "utf-8");

            return { content: [{ type: "text" as const, text: `Activity logged` }] };
        },
    );

    // ── vault_batch_read ────────────────────────────────────────────────
    server.tool(
        "vault_batch_read",
        "Read multiple vault files in a single call for high performance. Returns a map of path to file contents.",
        {
            paths: z.array(z.string()).max(20).describe("Array of paths relative to vault root (max 20)"),
        },
        async ({ paths }) => {
            const results: Record<string, string | { error: string }> = {};

            for (const p of paths) {
                const absPath = resolve(p);
                if (!fs.existsSync(absPath)) {
                    results[p] = { error: "File not found" };
                } else {
                    try {
                        results[p] = fs.readFileSync(absPath, "utf-8");
                    } catch (e: any) {
                        results[p] = { error: e.message };
                    }
                }
            }

            return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
        },
    );
}
