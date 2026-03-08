import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

function findGwsBin(): string {
    try {
        const which = execSync("which gws", { encoding: "utf8" }).trim();
        if (which) return which;
    } catch (e) {
        // Ignore error and fallback
    }

    const commonPaths = [
        "/usr/local/bin/gws",
        "/usr/bin/gws",
        path.join(process.env.HOME || "", ".npm-global/bin/gws"),
        path.join(process.env.HOME || "", ".local/bin/gws"),
        path.join(process.env.HOME || "", ".bun/bin/gws"),
        path.join(process.env.HOME || "", ".nvm/versions/node/v20.18.0/bin/gws")
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }

    throw new Error("Could not find gws CLI bin. Please install @googleworkspace/cli globally.");
}

function parseGwsOutput(output: string): any {
    if (!output.trim()) return { success: true };

    // Clean up any potential non-JSON lines before parsing
    const lines = output.trim().split("\n");

    // If it's pure NDJSON
    if (lines.length > 1 && lines.every(l => l.startsWith("{") || l.startsWith("["))) {
        try {
            return lines.map(l => JSON.parse(l));
        } catch (e) {
            // Fall through to single JSON attempt
        }
    }

    try {
        return JSON.parse(output);
    } catch (e) {
        // Return string content if its not JSON
        return output;
    }
}

function executeGwsCommand(args: string[], ctx: HQContext, timeout: number): any {
    const bin = findGwsBin();
    const env = { ...process.env };
    if (ctx.googleWorkspaceCredentialsFile) {
        env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = ctx.googleWorkspaceCredentialsFile;
    }

    try {
        const output = execSync(`${bin} ${args.join(" ")}`, {
            encoding: "utf8",
            env,
            timeout,
            maxBuffer: 10 * 1024 * 1024 // 10MB
        });
        return parseGwsOutput(output);
    } catch (error: any) {
        const stderr = error.stderr ? error.stderr.toString() : "";
        const stdout = error.stdout ? error.stdout.toString() : "";
        const combinedError = `${stderr}\\n${stdout}`.trim();

        if (combinedError.includes("invalid_grant") || combinedError.includes("No credentials found")) {
            throw new Error(`Google Workspace CLI Authentication failed. Please run 'gws auth setup'. Underlying error: ${combinedError}`);
        }

        throw new Error(`Google Workspace CLI error: ${combinedError || error.message}`);
    }
}

const SchemaInput = Type.Object({
    method: Type.String({ description: "The API method to introspect schema for, e.g., 'drive.files.list'" })
});

export const GoogleWorkspaceSchemaTool: HQTool<typeof SchemaInput> = {
    name: "google_workspace_schema",
    description: "Get schema for Google Workspace REST API methods using 'gws schema <method>'.",
    tags: ["google", "workspace", "schema", "api", "docs"],
    schema: SchemaInput,
    requiresWriteAccess: false,
    execute: async (input, ctx) => {
        return executeGwsCommand(["schema", input.method], ctx, 15000);
    }
};

const ReadInput = Type.Object({
    service: Type.String({ description: "Service name (e.g. 'drive', 'gmail', 'calendar')" }),
    resource: Type.String({ description: "Resource name (e.g. 'files', 'events', 'users.messages')" }),
    method: Type.String({ description: "Method name (e.g. 'list', 'get')" }),
    params: Type.Optional(Type.Any({ description: "Query parameters object" })),
    pageAll: Type.Optional(Type.Boolean({ description: "Paginate through all results" })),
    pageLimit: Type.Optional(Type.Number({ description: "Max pages to retrieve with pageAll" }))
});

export const GoogleWorkspaceReadTool: HQTool<typeof ReadInput> = {
    name: "google_workspace_read",
    description: "Read data from Google Workspace APIs (GET/list/search).",
    tags: ["google", "workspace", "read", "get", "list", "search"],
    schema: ReadInput,
    requiresWriteAccess: false,
    execute: async (input, ctx) => {
        const args = [input.service, input.resource, input.method];

        if (input.params) {
            args.push("--params", `'${JSON.stringify(input.params)}'`);
        }
        if (input.pageAll) {
            args.push("--page-all");
        }
        if (input.pageLimit !== undefined) {
            args.push("--page-limit", input.pageLimit.toString());
        }

        return executeGwsCommand(args, ctx, 60000);
    }
};

const WriteInput = Type.Object({
    service: Type.String({ description: "Service name" }),
    resource: Type.String({ description: "Resource name" }),
    method: Type.String({ description: "Method name (e.g. 'create', 'update', 'delete', 'send')" }),
    params: Type.Optional(Type.Any({ description: "Query parameters object" })),
    body: Type.Optional(Type.Any({ description: "Request body object" })),
    upload: Type.Optional(Type.String({ description: "Path to file to upload" })),
    dryRun: Type.Optional(Type.Boolean({ description: "Preview request without executing" }))
});

export const GoogleWorkspaceWriteTool: HQTool<typeof WriteInput> = {
    name: "google_workspace_write",
    description: "Write data to Google Workspace APIs (create/update/delete/send).",
    tags: ["google", "workspace", "write", "create", "update", "delete", "post"],
    schema: WriteInput,
    requiresWriteAccess: true,
    execute: async (input, ctx) => {
        const args = [input.service, input.resource, input.method];

        if (input.params) {
            args.push("--params", `'${JSON.stringify(input.params)}'`);
        }
        if (input.body) {
            args.push("--json", `'${JSON.stringify(input.body)}'`);
        }
        if (input.upload) {
            args.push("--upload", `'${input.upload}'`);
        }
        if (input.dryRun) {
            args.push("--dry-run");
        }

        return executeGwsCommand(args, ctx, 120000);
    }
};
