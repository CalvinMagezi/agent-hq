/**
 * Codemap Refresher (Worker)
 *
 * Background-refreshes the progressive codebase understanding map.
 * Scans project files for changes (mtime comparison), extracts
 * purpose/exports/patterns via LLM, updates codemap_entries in plans.db.
 *
 * Uses the vault-worker LLM cascade: Ollama → Gemini Flash Lite → Gemini Flash.
 */

import * as fs from "fs";
import * as path from "path";
import type { VaultWorker, WorkerContext, WorkerResult } from "../types.js";
import { openPlanDB } from "../../../packages/hq-tools/src/planDB.js";
import { CodemapEngine } from "../../../packages/hq-tools/src/codemap.js";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".json", ".yaml", ".yml", ".toml", ".sql", ".sh",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".obsidian", "_embeddings", "dist", "build",
  ".next", ".turbo", ".cache", "coverage", ".vault",
]);

const ANALYSIS_SYSTEM_PROMPT = `You are a codebase analyst. Given a source file's path and content, extract structured understanding.

Return a JSON object:
{
  "purpose": "1-line description of what this file does",
  "key_exports": [{"name": "functionOrClassName", "type": "function|class|const|type|interface", "line": 0}],
  "patterns": ["pattern names found, e.g. singleton, factory, observer, middleware, CRUD"]
}

Rules:
- "purpose" must be a single concise sentence (max 80 chars)
- "key_exports" should list the 3-5 most important exports
- "patterns" should list 0-3 high-level design patterns
- Return ONLY valid JSON, no markdown fences`;

/**
 * Detect project name from git remote or package.json.
 */
function detectProjectName(projectRoot: string): string {
  // Try package.json name
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
    if (pkg.name) return pkg.name.replace(/^@[^/]+\//, "");
  } catch { /* ignore */ }

  // Try git remote
  try {
    const gitConfig = fs.readFileSync(path.join(projectRoot, ".git", "config"), "utf-8");
    const match = gitConfig.match(/url\s*=\s*.*[/:]([^/\s]+?)(?:\.git)?\s*$/m);
    if (match) return match[1];
  } catch { /* ignore */ }

  return path.basename(projectRoot);
}

/**
 * Collect source files that have changed since their last codemap observation.
 */
function collectChangedFiles(
  dir: string,
  existingEntries: Map<string, string>, // file_path → last_file_mtime
  maxFiles: number,
  _depth = 0,
): Array<{ filePath: string; relativePath: string; mtime: string }> {
  if (_depth > 6) return [];
  const results: Array<{ filePath: string; relativePath: string; mtime: string }> = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const subResults = collectChangedFiles(
        path.join(dir, entry.name),
        existingEntries,
        maxFiles - results.length,
        _depth + 1,
      );
      results.push(...subResults);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!CODE_EXTENSIONS.has(ext)) continue;

      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        const mtime = stat.mtime.toISOString();
        const lastObserved = existingEntries.get(filePath);

        // Include if never observed or mtime changed
        if (!lastObserved || lastObserved !== mtime) {
          results.push({ filePath, relativePath: filePath, mtime });
        }
      } catch { /* skip unreadable */ }
    }
  }

  return results;
}

export const codemapRefresher: VaultWorker = {
  name: "codemap-refresher",
  description: "Progressive codebase understanding refresher — analyzes changed files via LLM",
  intervalMs: 12 * 60 * 60 * 1000, // 12 hours
  batchSize: 20,

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const result: WorkerResult = {
      processed: 0,
      created: 0,
      summary: "",
      llmCalls: 0,
      tokensUsed: { input: 0, output: 0 },
    };

    const db = openPlanDB(ctx.vaultPath);
    const engine = new CodemapEngine(db);

    // Apply decay to stale entries first
    engine.applyDecay();

    // Detect project
    const projectRoot = path.resolve(ctx.vaultPath, "..");
    const projectName = detectProjectName(projectRoot);

    // Build map of existing entries for mtime comparison
    const existingRows = db.prepare(
      "SELECT file_path, last_file_mtime FROM codemap_entries WHERE project = ?"
    ).all(projectName) as Array<{ file_path: string; last_file_mtime: string | null }>;

    const existingMap = new Map<string, string>();
    for (const row of existingRows) {
      if (row.last_file_mtime) existingMap.set(row.file_path, row.last_file_mtime);
    }

    // Collect changed files
    const changedFiles = collectChangedFiles(projectRoot, existingMap, this.batchSize);

    if (changedFiles.length === 0) {
      result.summary = `No changed files detected for project '${projectName}'.`;
      return result;
    }

    // Analyze each changed file via LLM
    for (const file of changedFiles) {
      if (ctx.abortSignal.aborted) break;

      try {
        // Read file content (truncated for LLM)
        const content = fs.readFileSync(file.filePath, "utf-8");
        const truncated = content.length > 4000
          ? content.substring(0, 4000) + "\n...[truncated]"
          : content;

        const relativePath = path.relative(projectRoot, file.filePath);
        const prompt = `**File:** ${relativePath}\n\n\`\`\`\n${truncated}\n\`\`\``;

        const raw = await ctx.llm(prompt, ANALYSIS_SYSTEM_PROMPT);
        result.llmCalls++;

        // Parse LLM response
        const cleaned = raw.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "").trim();
        let analysis: { purpose?: string; key_exports?: any[]; patterns?: string[] };
        try {
          analysis = JSON.parse(cleaned);
        } catch {
          // If JSON parse fails, just record the file without analysis
          await engine.observeFile(projectName, file.filePath, {
            last_file_mtime: file.mtime,
          });
          result.processed++;
          continue;
        }

        // Store in codemap
        await engine.observeFile(projectName, file.filePath, {
          purpose: analysis.purpose,
          key_exports: analysis.key_exports || [],
          patterns: analysis.patterns || [],
          last_file_mtime: file.mtime,
        });

        result.processed++;
        result.created++;

        // Rough token estimate
        result.tokensUsed.input += Math.ceil(truncated.length / 4);
        result.tokensUsed.output += Math.ceil(raw.length / 4);
      } catch (err) {
        // Log but continue with remaining files
        console.warn(`[codemap-refresher] Failed to analyze ${file.filePath}:`, err);
        result.processed++;
      }
    }

    result.summary = `Refreshed codemap for '${projectName}': analyzed ${result.created}/${changedFiles.length} changed files, ${result.llmCalls} LLM calls.`;
    return result;
  }
};
