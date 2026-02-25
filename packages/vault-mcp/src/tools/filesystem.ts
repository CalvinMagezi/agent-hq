/**
 * Filesystem tools — vault_read, vault_write, vault_patch, vault_list, vault_delete, vault_search
 */
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerFilesystemTools(server: McpServer, vaultPath: string) {
    // ── vault_read ──────────────────────────────────────────────────────
    server.tool(
        "vault_read",
        "Read a file from the Obsidian vault. Returns raw content or parsed frontmatter + body for markdown files.",
        {
            path: z.string().describe("Path relative to vault root, e.g. '_system/SOUL.md' or 'Notebooks/ideas/foo.md'"),
            parse_frontmatter: z.boolean().optional().default(true).describe("If true (default), parse YAML frontmatter separately"),
        },
        async ({ path: filePath, parse_frontmatter }) => {
            const absPath = path.resolve(vaultPath, filePath);
            if (!fs.existsSync(absPath)) {
                return { content: [{ type: "text" as const, text: `Error: File not found: ${filePath}` }], isError: true };
            }
            const raw = fs.readFileSync(absPath, "utf-8");

            if (parse_frontmatter && filePath.endsWith(".md")) {
                const { data, content } = matter(raw);
                return {
                    content: [{ type: "text" as const, text: JSON.stringify({ frontmatter: data, content: content.trim() }, null, 2) }],
                };
            }
            return { content: [{ type: "text" as const, text: raw }] };
        },
    );

    // ── vault_write ─────────────────────────────────────────────────────
    server.tool(
        "vault_write",
        "Write or overwrite a file in the vault. Creates parent directories automatically.",
        {
            path: z.string().describe("Path relative to vault root"),
            content: z.string().describe("Full file content to write"),
        },
        async ({ path: filePath, content }) => {
            const absPath = path.resolve(vaultPath, filePath);
            const dir = path.dirname(absPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(absPath, content, "utf-8");
            return { content: [{ type: "text" as const, text: `Written ${content.length} bytes to ${filePath}` }] };
        },
    );

    // ── vault_patch ─────────────────────────────────────────────────────
    server.tool(
        "vault_patch",
        "Surgically replace a substring in a vault file. Fails if the target string is not found or appears multiple times (unless allow_multiple is set).",
        {
            path: z.string().describe("Path relative to vault root"),
            old_string: z.string().describe("Exact substring to find and replace"),
            new_string: z.string().describe("Replacement string"),
            allow_multiple: z.boolean().optional().default(false).describe("If true, replace all occurrences"),
        },
        async ({ path: filePath, old_string, new_string, allow_multiple }) => {
            const absPath = path.resolve(vaultPath, filePath);
            if (!fs.existsSync(absPath)) {
                return { content: [{ type: "text" as const, text: `Error: File not found: ${filePath}` }], isError: true };
            }
            let raw = fs.readFileSync(absPath, "utf-8");
            const count = raw.split(old_string).length - 1;
            if (count === 0) {
                return { content: [{ type: "text" as const, text: `Error: Target string not found in ${filePath}` }], isError: true };
            }
            if (count > 1 && !allow_multiple) {
                return { content: [{ type: "text" as const, text: `Error: Found ${count} occurrences. Set allow_multiple=true to replace all.` }], isError: true };
            }

            if (allow_multiple) {
                raw = raw.replaceAll(old_string, new_string);
            } else {
                raw = raw.replace(old_string, new_string);
            }
            fs.writeFileSync(absPath, raw, "utf-8");
            return { content: [{ type: "text" as const, text: `Patched ${count} occurrence(s) in ${filePath}` }] };
        },
    );

    // ── vault_list ──────────────────────────────────────────────────────
    server.tool(
        "vault_list",
        "List files and directories at a path in the vault. Returns names, types, and sizes.",
        {
            path: z.string().optional().default("/").describe("Path relative to vault root (default: '/')"),
            recursive: z.boolean().optional().default(false).describe("If true, list recursively"),
        },
        async ({ path: dirPath, recursive }) => {
            const absPath = path.resolve(vaultPath, dirPath === "/" ? "." : dirPath);
            if (!fs.existsSync(absPath)) {
                return { content: [{ type: "text" as const, text: `Error: Directory not found: ${dirPath}` }], isError: true };
            }

            const results: Array<{ name: string; type: string; size?: number }> = [];

            const scan = (dir: string, prefix: string) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    // Skip hidden dirs like .obsidian
                    if (entry.name.startsWith(".")) continue;
                    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

                    if (entry.isDirectory()) {
                        results.push({ name: relPath, type: "directory" });
                        if (recursive) scan(path.join(dir, entry.name), relPath);
                    } else {
                        const stat = fs.statSync(path.join(dir, entry.name));
                        results.push({ name: relPath, type: "file", size: stat.size });
                    }
                }
            };

            scan(absPath, "");
            return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
        },
    );

    // ── vault_delete ────────────────────────────────────────────────────
    server.tool(
        "vault_delete",
        "Delete a file from the vault. Requires the path to be specified twice for confirmation.",
        {
            path: z.string().describe("Path relative to vault root"),
            confirm_path: z.string().describe("Must exactly match path for safety"),
        },
        async ({ path: filePath, confirm_path }) => {
            if (filePath !== confirm_path) {
                return { content: [{ type: "text" as const, text: "Error: path and confirm_path must match" }], isError: true };
            }
            const absPath = path.resolve(vaultPath, filePath);
            if (!fs.existsSync(absPath)) {
                return { content: [{ type: "text" as const, text: `Error: File not found: ${filePath}` }], isError: true };
            }
            fs.unlinkSync(absPath);
            return { content: [{ type: "text" as const, text: `Deleted ${filePath}` }] };
        },
    );

    // ── vault_search ────────────────────────────────────────────────────
    server.tool(
        "vault_search",
        "Search for notes by keyword across titles, content, and tags. Returns matched notes with snippets.",
        {
            query: z.string().describe("Search keywords"),
            folder: z.string().optional().default("Notebooks").describe("Folder to search within (default: Notebooks)"),
            limit: z.number().optional().default(10).describe("Max results to return"),
        },
        async ({ query, folder, limit }) => {
            const searchDir = path.resolve(vaultPath, folder);
            if (!fs.existsSync(searchDir)) {
                return { content: [{ type: "text" as const, text: `Error: Folder not found: ${folder}` }], isError: true };
            }

            const queryLower = query.toLowerCase();
            const results: Array<{ path: string; title: string; snippet: string; relevance: number }> = [];

            const scanDir = (dir: string) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scanDir(fullPath);
                    } else if (entry.name.endsWith(".md")) {
                        try {
                            const raw = fs.readFileSync(fullPath, "utf-8");
                            const { data, content } = matter(raw);
                            const titleMatch = entry.name.toLowerCase().includes(queryLower);
                            const contentMatch = content.toLowerCase().includes(queryLower);
                            const tags = (data.tags as string[]) ?? [];
                            const tagMatch = tags.some(t => t.toLowerCase().includes(queryLower));

                            if (titleMatch || contentMatch || tagMatch) {
                                let relevance = 0;
                                if (titleMatch) relevance += 3;
                                if (tagMatch) relevance += 2;
                                if (contentMatch) relevance += 1;

                                // Extract snippet
                                let snippet = "";
                                if (contentMatch) {
                                    const idx = content.toLowerCase().indexOf(queryLower);
                                    const start = Math.max(0, idx - 60);
                                    const end = Math.min(content.length, idx + query.length + 60);
                                    snippet = (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
                                }

                                results.push({
                                    path: path.relative(vaultPath, fullPath),
                                    title: path.basename(entry.name, ".md"),
                                    snippet,
                                    relevance,
                                });
                            }
                        } catch { /* skip */ }
                    }
                }
            };

            scanDir(searchDir);
            results.sort((a, b) => b.relevance - a.relevance);
            const limited = results.slice(0, limit);
            return { content: [{ type: "text" as const, text: JSON.stringify(limited, null, 2) }] };
        },
    );
}
