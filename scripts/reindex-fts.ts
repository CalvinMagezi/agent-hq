#!/usr/bin/env bun
/**
 * Re-index all vault markdown files into the FTS5 search index.
 * Usage: bun scripts/reindex-fts.ts
 */
import { SearchClient } from "@repo/vault-client/search";
import matter from "gray-matter";
import * as fs from "fs";
import * as path from "path";

const VAULT = process.env.VAULT_PATH || path.resolve(import.meta.dir, "../.vault");
const sc = new SearchClient(VAULT);

let indexed = 0;

function walk(dir: string) {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "_embeddings") continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { walk(fp); continue; }
    if (!e.name.endsWith(".md")) continue;
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      const { data, content } = matter(raw);
      const relPath = path.relative(VAULT, fp);
      const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
      sc.indexNote(relPath, data.title || e.name.replace(/\.md$/, ""), content.slice(0, 10000), tags);
      indexed++;
    } catch { /* skip unreadable */ }
  }
}

// Walk the entire vault (skip hidden dirs and _embeddings)
walk(VAULT);

console.log(`Indexed ${indexed} notes into FTS5`);
