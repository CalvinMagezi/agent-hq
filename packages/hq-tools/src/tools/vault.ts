import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";

const EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** Resolve a vault-relative path and verify it stays inside the vault root. */
function resolveVaultPath(vaultPath: string, relPath: string): string {
  const resolvedVault = path.resolve(vaultPath);
  const fullPath = path.resolve(vaultPath, relPath);
  if (!fullPath.startsWith(resolvedVault + path.sep) && fullPath !== resolvedVault) {
    throw new Error(`Path traversal outside vault is not allowed: ${relPath}`);
  }
  return fullPath;
}

/**
 * Lazy SearchClient pattern — uses dynamic import so hq-tools doesn't need
 * a hard dependency on @repo/vault-client. Host can also inject via ctx.
 */
const clientCache = new Map<string, any>();
async function getSearchClient(ctx: HQContext): Promise<any> {
  if (ctx.searchClient) return ctx.searchClient;
  const cached = clientCache.get(ctx.vaultPath);
  if (cached) return cached;
  // Dynamic import avoids a build-time dependency on vault-client
  const { SearchClient } = await import("@repo/vault-client/search");
  const client = new SearchClient(ctx.vaultPath);
  clientCache.set(ctx.vaultPath, client);
  return client;
}

/**
 * Generate a query embedding via OpenRouter embeddings API.
 * Returns null if no API key or on error (caller falls back to keyword).
 */
async function generateQueryEmbedding(
  query: string,
  apiKey: string,
): Promise<number[] | null> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: query }),
    });
    if (!response.ok) return null;
    const result = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return result.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// ── 1. vault_search (FTS5 Hybrid) ──────────────────────────────────

export const VaultSearchTool: HQTool<
  { query: string; mode?: "keyword" | "semantic" | "hybrid"; limit?: number },
  any
> = {
  name: "vault_search",
  description:
    "Search the local Obsidian vault using SQLite FTS5 (keyword) or semantic hybrid search. " +
    "Keyword mode is instant. Hybrid/semantic modes generate an embedding via OpenRouter and " +
    "combine it with FTS5 results (60% semantic + 40% keyword). Falls back to keyword if no API key.",
  tags: ["vault", "search", "query", "find", "knowledge"],
  schema: Type.Object({
    query: Type.String({ description: "Search query" }),
    mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("keyword"),
          Type.Literal("semantic"),
          Type.Literal("hybrid"),
        ],
        {
          description:
            "Search mode. 'keyword' uses FTS5 only (fastest). 'hybrid' combines FTS5 + semantic (best quality). 'semantic' uses embeddings only. Default: keyword.",
        },
      ),
    ),
    limit: Type.Optional(
      Type.Number({ description: "Result limit (max 50). Default 10." }),
    ),
  }),
  async execute(input, ctx) {
    const client = await getSearchClient(ctx);
    const mode = input.mode || "keyword";
    const limit = Math.min(input.limit || 10, 50);

    if (mode === "keyword") {
      return client.keywordSearch(input.query, limit);
    }

    // For hybrid/semantic, try to generate a query embedding
    if (!ctx.openrouterApiKey) {
      // No API key — fall back to keyword silently
      return client.keywordSearch(input.query, limit);
    }

    const queryEmbedding = await generateQueryEmbedding(
      input.query,
      ctx.openrouterApiKey,
    );

    if (mode === "semantic") {
      if (!queryEmbedding) {
        return client.keywordSearch(input.query, limit);
      }
      return client.semanticSearch(queryEmbedding, limit);
    }

    // hybrid (default when API key available)
    return client.hybridSearch(input.query, queryEmbedding, limit);
  },
};

// ── 2. vault_read ───────────────────────────────────────────────────

export const VaultReadTool: HQTool<{ path: string; parseFrontmatter?: boolean }, any> = {
  name: "vault_read",
  description: "Read a note from the vault by vault-relative path.",
  tags: ["vault", "read", "file", "note"],
  schema: Type.Object({
    path: Type.String({ description: "Vault-relative path (e.g. Notebooks/Projects/ProjectA.md)" }),
    parseFrontmatter: Type.Optional(Type.Boolean({ description: "Whether to parse YAML frontmatter. Default true." }))
  }),
  async execute(input, ctx) {
    const fullPath = resolveVaultPath(ctx.vaultPath, input.path);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found in vault: ${input.path}`);
    }
    const content = fs.readFileSync(fullPath, "utf-8");
    if (input.parseFrontmatter !== false) {
      const { data, content: body } = matter(content);
      return { frontmatter: data, content: body };
    }
    return { content };
  }
};

// ── 3. vault_context (Structured System) ──────────────────────────

export const VaultContextTool: HQTool<{}, any> = {
  name: "vault_context",
  description: "Read core system files (SOUL, MEMORY, PREFERENCES, HEARTBEAT) as structured JSON.",
  tags: ["vault", "context", "system", "brain"],
  schema: Type.Object({}),
  async execute(_, ctx) {
    const systemDir = path.join(ctx.vaultPath, "_system");
    const files = ["SOUL.md", "MEMORY.md", "PREFERENCES.md", "HEARTBEAT.md"];
    const results: Record<string, any> = {};

    for (const f of files) {
      const fp = path.join(systemDir, f);
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, "utf-8");
        const { data, content } = matter(raw);
        results[f.replace(".md", "")] = { frontmatter: data, content };
      }
    }
    return results;
  }
};

// ── 4. vault_list ──────────────────────────────────────────────────

export const VaultListTool: HQTool<{ path?: string; recursive?: boolean }, any> = {
  name: "vault_list",
  description: "List files and directories in the vault.",
  tags: ["vault", "list", "directory", "ls"],
  schema: Type.Object({
    path: Type.Optional(Type.String({ description: "Vault-relative path. Default root." })),
    recursive: Type.Optional(Type.Boolean({ description: "List recursively. Default false." }))
  }),
  async execute(input, ctx) {
    const targetDir = resolveVaultPath(ctx.vaultPath, input.path || "");
    if (!fs.existsSync(targetDir)) return [];

    const listEntries = (dir: string, base: string): any[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let results: any[] = [];
      for (const entry of entries) {
        const relPath = path.join(base, entry.name);
        results.push({
          name: entry.name,
          path: relPath,
          isDir: entry.isDirectory(),
          size: entry.isFile() ? fs.statSync(path.join(dir, entry.name)).size : undefined
        });
        if (input.recursive && entry.isDirectory()) {
          results = results.concat(listEntries(path.join(dir, entry.name), relPath));
        }
      }
      return results;
    };

    return listEntries(targetDir, input.path || "");
  }
};

// ── 5. vault_batch_read ───────────────────────────────────────────

export const VaultBatchReadTool: HQTool<{ paths: string[] }, any> = {
  name: "vault_batch_read",
  description: "Read up to 20 files from the vault in a single call.",
  tags: ["vault", "batch", "read", "bulk"],
  schema: Type.Object({
    paths: Type.Array(Type.String(), { maxItems: 20, description: "List of vault-relative paths" })
  }),
  async execute(input, ctx) {
    const results: Record<string, any> = {};
    for (const p of input.paths) {
      const fp = resolveVaultPath(ctx.vaultPath, p);
      if (fs.existsSync(fp)) {
        const { data, content } = matter(fs.readFileSync(fp, "utf-8"));
        results[p] = { frontmatter: data, content };
      }
    }
    return results;
  }
};

// ── 6. vault_write_note ───────────────────────────────────────────

export const VaultWriteNoteTool: HQTool<{ path: string; content: string; frontmatter?: Record<string, any> }, any> = {
  name: "vault_write_note",
  description: "Create or overwrite a note in the vault. Only allowed in Notebooks/ or other designated areas.",
  tags: ["vault", "write", "note", "create"],
  requiresWriteAccess: true,
  schema: Type.Object({
    path: Type.String({ description: "Vault-relative path (must start with Notebooks/)" }),
    content: Type.String({ description: "Note body" }),
    frontmatter: Type.Optional(Type.Any({ description: "YAML frontmatter metadata" }))
  }),
  async execute(input, ctx) {
    if (!input.path.startsWith("Notebooks/")) {
      throw new Error("Writing outside Notebooks/ is restricted for security.");
    }
    const fullPath = resolveVaultPath(ctx.vaultPath, input.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fileContent = matter.stringify(input.content, input.frontmatter || {});
    fs.writeFileSync(fullPath, fileContent);
    return { success: true, path: input.path };
  }
};

// ── 7. vault_create_job ───────────────────────────────────────────

export const VaultCreateJobTool: HQTool<{ instruction: string; priority?: number; type?: string }, any> = {
  name: "vault_create_job",
  description: "Create a new job in the vault queue (_jobs/pending/).",
  tags: ["vault", "job", "create", "task", "orchestration"],
  requiresWriteAccess: true,
  schema: Type.Object({
    instruction: Type.String({ description: "Task instruction for the agent" }),
    priority: Type.Optional(Type.Number({ description: "Job priority (1-100). Default 50." })),
    type: Type.Optional(Type.String({ description: "Job type (background, rpc, interactive). Default background." }))
  }),
  async execute(input, ctx) {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const jobFilename = `${jobId}.md`;
    const fullPath = path.join(ctx.vaultPath, "_jobs", "pending", jobFilename);

    const frontmatter = {
      jobId,
      status: "pending",
      priority: input.priority || 50,
      type: input.type || "background",
      createdAt: new Date().toISOString()
    };

    const fileContent = matter.stringify(`# Instruction\n\n${input.instruction}`, frontmatter);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    fs.writeFileSync(fullPath, fileContent);
    return { jobId, path: `_jobs/pending/${jobFilename}` };
  }
};
