import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** Compute cosine similarity between two vectors. */
export function cosineSimilarityTS(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

/** Compute SHA-256 content hash of a file. */
export function hashFileTS(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Walk the vault and collect all .md file paths (relative to vault root) */
export function walkVaultFilesTS(vaultPath: string, skipPatterns: string[], extFilter?: string): string[] {
  const files: string[] = [];
  const skipDirs = new Set(skipPatterns);

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(vaultPath, full);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full);
      } else if (!extFilter || entry.name.endsWith(extFilter)) {
        files.push(rel);
      }
    }
  }

  walk(vaultPath);
  return files;
}

/** Resolve wikilinks by building a filename→path index, then looking up each link. */
export function resolveWikilinksTS(vaultRoot: string, wikilinks: string[]): (string | null)[] {
  const index = new Map<string, string>();

  // Build index: stem → relative path (first match wins)
  function indexDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        indexDir(full);
      } else if (entry.name.endsWith(".md")) {
        const stem = path.basename(entry.name, ".md");
        if (!index.has(stem)) {
          index.set(stem, path.relative(vaultRoot, full));
        }
      }
    }
  }

  indexDir(vaultRoot);

  return wikilinks.map((link) => {
    const target = link.includes("|") ? link.slice(0, link.indexOf("|")) : link;
    return index.get(target) ?? null;
  });
}
