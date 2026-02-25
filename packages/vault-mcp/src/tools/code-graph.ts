import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBacklinks, getOutboundLinks, getFileExports } from "@repo/vault-client/graph";
import { spawn } from "child_process";

export function registerCodeGraphTools(server: McpServer, vaultPath: string) {
    // ── mcp:get_blast_radius ─────────────────────────────────────────────
    server.tool(
        "get_blast_radius",
        "Get a list of all files that import/depend on the target file. Use this before modifying any code to understand the potential breakages.",
        {
            filepath: z.string().describe("Path to the file relative to the repository root (e.g. packages/vault-client/src/index.ts)"),
        },
        async ({ filepath }) => {
            const notePath = filepath.replace(/\.tsx?$/, "");
            const dependents = getBacklinks(vaultPath, notePath);

            if (dependents.length === 0) {
                return { content: [{ type: "text" as const, text: `No outbound dependents found for ${filepath}.` }] };
            }

            return {
                content: [{
                    type: "text" as const,
                    text: `The following notes/files depend on ${filepath}:\n${dependents.map(d => `- ${d}`).join("\n")}`
                }]
            };
        },
    );

    // ── mcp:get_dependency_context ───────────────────────────────────────
    server.tool(
        "get_dependency_context",
        "Get the outbound imports of a file, along with the exports of those imports. Use this explore what a file relies on.",
        {
            filepath: z.string().describe("Path to the file relative to the repository root (e.g. packages/vault-client/src/index.ts)"),
            vault_folder: z.string().describe("The root folder in the vault where the repo is mapped, e.g. Architecture/agent-hq"),
        },
        async ({ filepath, vault_folder }) => {
            const noteRelPath = path.join(vault_folder, filepath.replace(/\.tsx?$/, ".md"));
            const links = getOutboundLinks(vaultPath, noteRelPath);

            if (links.length === 0) {
                return { content: [{ type: "text" as const, text: `${filepath} has no known local dependencies mapped in ${vault_folder}.` }] };
            }

            let result = `Dependencies for ${filepath}:\n\n`;
            for (const link of links) {
                const targetNotePath = path.join(vault_folder, `${link}.md`);
                const exportsResult = getFileExports(vaultPath, targetNotePath);
                result += `- [[${link}]]`;
                if (exportsResult && exportsResult.length > 0) {
                    result += `\n  Exports: ${exportsResult.join(", ")}\n`;
                } else {
                    result += `\n  Exports: None known\n`;
                }
            }

            return { content: [{ type: "text" as const, text: result }] };
        },
    );

    // ── mcp:map_repository ───────────────────────────────────────────────
    server.tool(
        "map_repository",
        "Trigger the code-mapper skill to build or rebuild the dependency graph of a repository into Obsidian.",
        {
            repo_path: z.string().describe("Absolute path to the repository on disk"),
            vault_destination: z.string().describe("Destination directory in the vault relative to vault root (e.g. Architecture/agent-hq)"),
        },
        async ({ repo_path, vault_destination }) => {
            const destinationAbs = path.resolve(vaultPath, vault_destination);

            const scriptPath = path.resolve(vaultPath, "../apps/agent/skills/code-mapper/scripts/map-repo.ts");

            if (!fs.existsSync(scriptPath)) {
                return { content: [{ type: "text" as const, text: `Mapper script not found at ${scriptPath}` }], isError: true };
            }

            return new Promise((resolve) => {
                const child = spawn("bun", ["run", scriptPath, "--target", repo_path, "--vault-dest", destinationAbs], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                let output = "";
                child.stdout.on("data", (data) => output += data.toString());
                child.stderr.on("data", (data) => output += data.toString());

                child.on("close", (code) => {
                    if (code === 0) {
                        resolve({ content: [{ type: "text" as const, text: `Successfully mapped repository:\n${output}` }] });
                    } else {
                        resolve({ content: [{ type: "text" as const, text: `Mapping failed:\n${output}` }], isError: true });
                    }
                });
            });
        },
    );
}
