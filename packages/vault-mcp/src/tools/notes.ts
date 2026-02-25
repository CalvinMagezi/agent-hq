/**
 * Note tools — vault_create_note, vault_update_note
 * Versioned and locked note operations using vault-client patterns.
 */
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { acquireLock, releaseLock } from "./concurrency.js";

export function registerNoteTools(server: McpServer, vaultPath: string) {
    const resolve = (...parts: string[]) => path.join(vaultPath, ...parts);
    const nowISO = () => new Date().toISOString();

    // ── vault_create_note ───────────────────────────────────────────────
    server.tool(
        "vault_create_note",
        "Create a new note in the vault with proper frontmatter, version tracking, and graph link sentinel.",
        {
            folder: z.string().describe("Folder inside Notebooks/, e.g. 'ideas' or 'research'"),
            title: z.string().describe("Note title"),
            content: z.string().describe("Note body content (markdown)"),
            note_type: z.enum(["note", "digest", "system-file", "report"]).optional().default("note"),
            tags: z.array(z.string()).optional().default([]),
            pinned: z.boolean().optional().default(false),
            source: z.string().optional().default("mcp"),
        },
        async ({ folder, title, content, note_type, tags, pinned, source }) => {
            const safeTitle = title.replace(/[/\\:*?"<>|]/g, "-");
            const filePath = resolve("Notebooks", folder, `${safeTitle}.md`);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            if (fs.existsSync(filePath)) {
                return { content: [{ type: "text" as const, text: `Error: Note already exists at Notebooks/${folder}/${safeTitle}.md` }], isError: true };
            }

            const frontmatter: Record<string, any> = {
                noteType: note_type,
                tags,
                pinned,
                source,
                embeddingStatus: "pending",
                relatedNotes: [],
                createdAt: nowISO(),
                updatedAt: nowISO(),
                version: 1,
                lastModifiedBy: "vault-mcp",
            };

            const GRAPH_MARKER = "<!-- agent-hq-graph-links -->";
            const body = `# ${title}\n\n${content}\n\n${GRAPH_MARKER}\n## Related Notes\n\n_Links will be auto-generated after embedding._\n`;
            const output = matter.stringify("\n" + body + "\n", frontmatter);
            fs.writeFileSync(filePath, output, "utf-8");

            const relPath = path.relative(vaultPath, filePath);
            return { content: [{ type: "text" as const, text: `Created note: ${relPath} (v1)` }] };
        },
    );

    // ── vault_update_note ───────────────────────────────────────────────
    server.tool(
        "vault_update_note",
        "Update an existing note's content and/or frontmatter. Acquires a lock, bumps version, and marks for re-embedding if content changed.",
        {
            path: z.string().describe("Path relative to vault root, e.g. 'Notebooks/ideas/My Note.md'"),
            content: z.string().optional().describe("New body content (replaces existing). Omit to keep current content."),
            frontmatter_updates: z.record(z.any()).optional().describe("Key-value pairs to merge into existing frontmatter"),
        },
        async ({ path: notePath, content: newContent, frontmatter_updates }) => {
            const absPath = path.resolve(vaultPath, notePath);
            if (!fs.existsSync(absPath)) {
                return { content: [{ type: "text" as const, text: `Error: Note not found: ${notePath}` }], isError: true };
            }

            let token: string;
            try {
                token = await acquireLock(vaultPath, absPath);
            } catch (err: any) {
                return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
            }

            try {
                const raw = fs.readFileSync(absPath, "utf-8");
                const { data, content: existingContent } = matter(raw);

                if (frontmatter_updates) {
                    Object.assign(data, frontmatter_updates);
                }
                data.updatedAt = nowISO();
                data.lastModifiedBy = "vault-mcp";

                // Bump version
                data.version = (typeof data.version === "number" ? data.version : 0) + 1;

                // Mark for re-embedding if content changed
                const finalContent = newContent ?? existingContent.trim();
                if (newContent && newContent !== existingContent.trim()) {
                    data.embeddingStatus = "pending";
                }

                const output = matter.stringify("\n" + finalContent + "\n", data);
                fs.writeFileSync(absPath, output, "utf-8");

                return { content: [{ type: "text" as const, text: `Updated ${notePath} → v${data.version}` }] };
            } finally {
                await releaseLock(vaultPath, absPath, token!);
            }
        },
    );
}
