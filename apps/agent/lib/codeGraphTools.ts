/**
 * Code-Graph native AgentTool wrappers.
 *
 * These expose the same logic as the vault-mcp code-graph tools but as
 * native AgentTools so the HQ Agent can call them directly without MCP.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getBacklinks, getOutboundLinks, getFileExports } from "@repo/vault-client/graph";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const GetBlastRadiusSchema = Type.Object({
    filepath: Type.String({
        description: "Path to the file relative to the repository root (e.g. packages/vault-client/src/index.ts)",
    }),
});

export function createGetBlastRadiusTool(vaultPath: string): AgentTool<typeof GetBlastRadiusSchema> {
    return {
        name: "get_blast_radius",
        description: "Before modifying any file, call this to list every file that imports/depends on it. Reveals the full \"blast radius\" of a change so you avoid breaking callers.",
        parameters: GetBlastRadiusSchema,
        label: "Get Blast Radius",
        execute: async (_toolCallId, args) => {
            const notePath = args.filepath.replace(/\.tsx?$/, "");
            const dependents = getBacklinks(vaultPath, notePath);

            if (dependents.length === 0) {
                return {
                    content: [{ type: "text", text: `No dependents found for ${args.filepath}. Safe to modify without breakage risk.` }],
                    details: { dependents: [] },
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `${dependents.length} file(s) depend on ${args.filepath}:\n${dependents.map(d => `- ${d}`).join("\n")}`,
                }],
                details: { filepath: args.filepath, dependents },
            };
        },
    };
}

const GetDependencyContextSchema = Type.Object({
    filepath: Type.String({
        description: "Path to the file relative to the repository root (e.g. apps/agent/lib/chatSession.ts)",
    }),
    vault_folder: Type.String({
        description: "Folder inside the vault where the repo is mapped (e.g. Architecture/agent-hq)",
    }),
});

export function createGetDependencyContextTool(vaultPath: string): AgentTool<typeof GetDependencyContextSchema> {
    return {
        name: "get_dependency_context",
        description: "Get the outbound imports of a file plus the exports of each dependency. Use this to quickly understand what a file relies on before modifying it.",
        parameters: GetDependencyContextSchema,
        label: "Get Dependency Context",
        execute: async (_toolCallId, args) => {
            const noteRelPath = path.join(args.vault_folder, args.filepath.replace(/\.tsx?$/, ".md"));
            const links = getOutboundLinks(vaultPath, noteRelPath);

            if (links.length === 0) {
                return {
                    content: [{ type: "text", text: `${args.filepath} has no mapped local dependencies in ${args.vault_folder}.` }],
                    details: { filepath: args.filepath, links: [] },
                };
            }

            let result = `Dependencies for ${args.filepath}:\n\n`;
            for (const link of links) {
                const targetNotePath = path.join(args.vault_folder, `${link}.md`);
                const exports = getFileExports(vaultPath, targetNotePath);
                result += `- [[${link}]]`;
                result += exports && exports.length > 0
                    ? `\n  Exports: ${exports.join(", ")}\n`
                    : `\n  Exports: None known\n`;
            }

            return {
                content: [{ type: "text", text: result }],
                details: { filepath: args.filepath, vault_folder: args.vault_folder, links },
            };
        },
    };
}

const MapRepositorySchema = Type.Object({
    repo_path: Type.String({
        description: "Absolute path to the repository on disk",
    }),
    vault_destination: Type.String({
        description: "Destination folder in the vault relative to vault root (e.g. Architecture/agent-hq)",
    }),
});

export function createMapRepositoryTool(vaultPath: string): AgentTool<typeof MapRepositorySchema> {
    return {
        name: "map_repository",
        description: "Parse a TypeScript repository with ts-morph and generate Obsidian Index Cards into the vault. Run this once per repo (or after major structural changes) to build the dependency graph.",
        parameters: MapRepositorySchema,
        label: "Map Repository",
        execute: async (_toolCallId, args) => {
            const destinationAbs = path.resolve(vaultPath, args.vault_destination);
            const scriptPath = path.resolve(vaultPath, "../apps/agent/skills/code-mapper/scripts/map-repo.ts");

            if (!fs.existsSync(scriptPath)) {
                return {
                    content: [{ type: "text", text: `Mapper script not found at ${scriptPath}. Ensure code-mapper skill is installed.` }],
                    details: { error: "script_not_found" },
                };
            }

            return new Promise((resolve) => {
                const child = spawn("bun", ["run", scriptPath, "--target", args.repo_path, "--vault-dest", destinationAbs], {
                    stdio: ["ignore", "pipe", "pipe"],
                });

                let output = "";
                child.stdout.on("data", (data) => { output += data.toString(); });
                child.stderr.on("data", (data) => { output += data.toString(); });

                child.on("close", (code) => {
                    if (code === 0) {
                        resolve({ content: [{ type: "text", text: `✅ Repository mapped successfully:\n${output}` }], details: { code } });
                    } else {
                        resolve({ content: [{ type: "text", text: `❌ Mapping failed:\n${output}` }], details: { code } });
                    }
                });
            }) as Promise<any>;
        },
    };
}
