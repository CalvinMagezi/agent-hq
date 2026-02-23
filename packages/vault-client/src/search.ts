/**
 * SearchClient — Local search engine using SQLite FTS5 + vector embeddings.
 *
 * Provides hybrid search (keyword + semantic) matching the Convex implementation.
 * Embedding generation uses OpenRouter API with the same model.
 */

import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

export interface SearchHit {
  notePath: string;
  title: string;
  notebook: string;
  snippet: string;
  tags: string[];
  relevance: number;
  matchType: "keyword" | "semantic" | "hybrid";
}

export interface EmbeddingRecord {
  notePath: string;
  embedding: Float32Array;
  model: string;
  embeddedAt: number;
}

export class SearchClient {
  private db: Database;
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
    const dbPath = path.join(this.vaultPath, "_embeddings", "search.db");
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        path,
        title,
        content,
        tags,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        note_path TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        embedded_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS graph_links (
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        score REAL NOT NULL,
        link_type TEXT NOT NULL DEFAULT 'semantic',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_path, target_path)
      );

      CREATE TABLE IF NOT EXISTS link_state (
        note_path TEXT PRIMARY KEY,
        last_linked_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
    `);
  }

  /**
   * Index a note for full-text search.
   */
  indexNote(
    notePath: string,
    title: string,
    content: string,
    tags: string[],
  ): void {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;

    // Remove existing entry
    this.db
      .prepare("DELETE FROM notes_fts WHERE path = ?")
      .run(relPath);

    // Insert new entry
    this.db
      .prepare(
        "INSERT INTO notes_fts (path, title, content, tags) VALUES (?, ?, ?, ?)",
      )
      .run(relPath, title, content, tags.join(" "));
  }

  /**
   * Remove a note from the search index.
   */
  removeNote(notePath: string): void {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;
    this.db.prepare("DELETE FROM notes_fts WHERE path = ?").run(relPath);
    this.db.prepare("DELETE FROM embeddings WHERE note_path = ?").run(relPath);
  }

  /**
   * Store an embedding for a note.
   */
  storeEmbedding(
    notePath: string,
    embedding: number[],
    model: string,
  ): void {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;
    const buffer = Buffer.from(new Float32Array(embedding).buffer);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO embeddings (note_path, embedding, model, embedded_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(relPath, buffer, model, Date.now());
  }

  /**
   * Full-text keyword search using FTS5.
   */
  keywordSearch(query: string, limit: number = 20): SearchHit[] {
    // Escape special FTS5 characters: colons (column prefix), hyphens (NOT),
    // periods (tokenizer issues), parentheses, quotes, operators
    const escaped = query.replace(/['"(){}[\]*+^~!@#$%&:.\-,]/g, " ").replace(/\s+/g, " ");
    if (!escaped.trim()) return [];

    const rows = this.db
      .prepare(
        `SELECT path, title, snippet(notes_fts, 2, '<mark>', '</mark>', '...', 30) as snippet,
                tags, rank
         FROM notes_fts
         WHERE notes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(escaped, limit) as Array<{
        path: string;
        title: string;
        snippet: string;
        tags: string;
        rank: number;
      }>;

    return rows.map((row) => {
      const parts = row.path.split("/");
      const notebook = parts.length > 1 ? parts[1] ?? "Unknown" : "Unknown";

      return {
        notePath: row.path,
        title: row.title,
        notebook,
        snippet: row.snippet.replace(/<\/?mark>/g, ""),
        tags: row.tags ? row.tags.split(" ").filter(Boolean) : [],
        relevance: -row.rank, // FTS5 rank is negative (higher = better match)
        matchType: "keyword" as const,
      };
    });
  }

  /**
   * Semantic search using cosine similarity on stored embeddings.
   */
  semanticSearch(queryEmbedding: number[], limit: number = 20): SearchHit[] {
    const rows = this.db
      .prepare("SELECT note_path, embedding FROM embeddings")
      .all() as Array<{ note_path: string; embedding: Uint8Array }>;

    if (rows.length === 0) return [];

    const queryVec = new Float32Array(queryEmbedding);
    const scored: Array<{ path: string; score: number }> = [];

    for (const row of rows) {
      const vec = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const score = cosineSimilarity(queryVec, vec);
      scored.push({ path: row.note_path, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, limit);

    return topResults.map((result) => {
      // Look up title and tags from FTS table
      const ftsRow = this.db
        .prepare("SELECT title, tags FROM notes_fts WHERE path = ?")
        .get(result.path) as { title: string; tags: string } | undefined;

      const parts = result.path.split("/");
      const notebook = parts.length > 1 ? parts[1] ?? "Unknown" : "Unknown";

      return {
        notePath: result.path,
        title: ftsRow?.title ?? path.basename(result.path, ".md"),
        notebook,
        snippet: "",
        tags: ftsRow?.tags ? ftsRow.tags.split(" ").filter(Boolean) : [],
        relevance: result.score,
        matchType: "semantic" as const,
      };
    });
  }

  /**
   * Hybrid search combining keyword and semantic results.
   * Uses 60% semantic + 40% keyword weighting (matches Convex implementation).
   */
  hybridSearch(
    query: string,
    queryEmbedding: number[] | null,
    limit: number = 10,
  ): SearchHit[] {
    const keywordResults = this.keywordSearch(query, limit * 2);

    if (!queryEmbedding) {
      // No embedding available, return keyword-only results
      return keywordResults.slice(0, limit);
    }

    const semanticResults = this.semanticSearch(queryEmbedding, limit * 2);

    // Normalize scores to [0, 1]
    const maxKeyword = Math.max(...keywordResults.map((r) => r.relevance), 1);
    const maxSemantic = Math.max(
      ...semanticResults.map((r) => r.relevance),
      1,
    );

    // Merge results
    const merged = new Map<string, SearchHit>();

    for (const r of keywordResults) {
      const normalized = r.relevance / maxKeyword;
      merged.set(r.notePath, {
        ...r,
        relevance: normalized * 0.4,
        matchType: "hybrid",
      });
    }

    for (const r of semanticResults) {
      const normalized = r.relevance / maxSemantic;
      const existing = merged.get(r.notePath);
      if (existing) {
        existing.relevance += normalized * 0.6;
      } else {
        merged.set(r.notePath, {
          ...r,
          relevance: normalized * 0.6,
          matchType: "hybrid",
        });
      }
    }

    const results = Array.from(merged.values());
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  }

  /**
   * Rebuild the full-text index by scanning the vault.
   */
  rebuildIndex(): { indexed: number; errors: number } {
    let indexed = 0;
    let errors = 0;

    // Clear existing FTS data
    this.db.exec("DELETE FROM notes_fts");

    const notebooksDir = path.join(this.vaultPath, "Notebooks");
    if (!fs.existsSync(notebooksDir)) return { indexed, errors };

    const scanDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".md") && entry.name !== "_meta.md") {
          try {
            const raw = fs.readFileSync(fullPath, "utf-8");
            const { data, content } = matter(raw);
            const title = path.basename(entry.name, ".md");
            const tags = data.tags ?? [];
            this.indexNote(fullPath, title, content, tags);
            indexed++;
          } catch {
            errors++;
          }
        }
      }
    };

    scanDir(notebooksDir);
    return { indexed, errors };
  }

  /**
   * Get count of indexed notes and embeddings.
   */
  getStats(): { ftsCount: number; embeddingCount: number } {
    const fts = this.db
      .prepare("SELECT COUNT(*) as count FROM notes_fts")
      .get() as { count: number };
    const emb = this.db
      .prepare("SELECT COUNT(*) as count FROM embeddings")
      .get() as { count: number };
    return { ftsCount: fts.count, embeddingCount: emb.count };
  }

  // ─── Graph Linking Methods ──────────────────────────────────────────

  /**
   * Retrieve the stored embedding for a specific note.
   */
  getEmbedding(notePath: string): Float32Array | null {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;

    const row = this.db
      .prepare("SELECT embedding FROM embeddings WHERE note_path = ?")
      .get(relPath) as { embedding: Uint8Array } | undefined;

    if (!row) return null;

    return new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
  }

  /**
   * Find the most similar notes to a given note using stored embeddings.
   * Returns only results above the similarity threshold.
   */
  findSimilarNotes(
    notePath: string,
    limit: number = 5,
    threshold: number = 0.75,
  ): SearchHit[] {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;

    const sourceEmb = this.getEmbedding(relPath);
    if (!sourceEmb) return [];

    const rows = this.db
      .prepare(
        "SELECT note_path, embedding FROM embeddings WHERE note_path != ?",
      )
      .all(relPath) as Array<{ note_path: string; embedding: Uint8Array }>;

    const scored: Array<{ path: string; score: number }> = [];

    for (const row of rows) {
      const vec = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const score = cosineSimilarity(sourceEmb, vec);
      if (score >= threshold) {
        scored.push({ path: row.note_path, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, limit);

    return topResults.map((result) => {
      const ftsRow = this.db
        .prepare("SELECT title, tags FROM notes_fts WHERE path = ?")
        .get(result.path) as { title: string; tags: string } | undefined;

      const parts = result.path.split("/");
      const notebook = parts.length > 1 ? (parts[1] ?? "Unknown") : "Unknown";

      return {
        notePath: result.path,
        title: ftsRow?.title ?? path.basename(result.path, ".md"),
        notebook,
        snippet: "",
        tags: ftsRow?.tags ? ftsRow.tags.split(" ").filter(Boolean) : [],
        relevance: result.score,
        matchType: "semantic" as const,
      };
    });
  }

  /**
   * Get all note paths that have stored embeddings.
   */
  getEmbeddedNotePaths(): string[] {
    const rows = this.db
      .prepare("SELECT note_path FROM embeddings")
      .all() as Array<{ note_path: string }>;
    return rows.map((r) => r.note_path);
  }

  /**
   * Get tag counts across all indexed notes.
   */
  getAllTags(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT tags FROM notes_fts WHERE tags != ''")
      .all() as Array<{ tags: string }>;

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags.split(" ").filter(Boolean)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * Get note paths for a specific tag from the FTS index.
   */
  getTaggedNotePaths(tag: string): string[] {
    const escaped = tag.replace(/['"(){}[\]*+^~!@#$%&]/g, "");
    if (!escaped.trim()) return [];

    const rows = this.db
      .prepare(
        "SELECT path FROM notes_fts WHERE tags MATCH ? LIMIT 100",
      )
      .all(escaped) as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  // ─── Link State Tracking ──────────────────────────────────────────

  /**
   * Record that a note has been linked (with its content hash for change detection).
   */
  setLinkState(notePath: string, contentHash: string): void {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO link_state (note_path, last_linked_at, content_hash)
         VALUES (?, ?, ?)`,
      )
      .run(relPath, Date.now(), contentHash);
  }

  /**
   * Get the link state for a note (when it was last linked and its content hash).
   */
  getLinkState(
    notePath: string,
  ): { lastLinkedAt: number; contentHash: string } | null {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;
    const row = this.db
      .prepare(
        "SELECT last_linked_at, content_hash FROM link_state WHERE note_path = ?",
      )
      .get(relPath) as
      | { last_linked_at: number; content_hash: string }
      | undefined;
    if (!row) return null;
    return { lastLinkedAt: row.last_linked_at, contentHash: row.content_hash };
  }

  /**
   * Record a graph link between two notes.
   */
  addGraphLink(
    source: string,
    target: string,
    score: number,
    type: string = "semantic",
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO graph_links (source_path, target_path, score, link_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(source, target, score, type, Date.now());
  }

  /**
   * Get all graph links from a specific note.
   */
  getGraphLinks(
    notePath: string,
  ): Array<{ target: string; score: number; type: string }> {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;
    const rows = this.db
      .prepare(
        "SELECT target_path, score, link_type FROM graph_links WHERE source_path = ?",
      )
      .all(relPath) as Array<{
        target_path: string;
        score: number;
        link_type: string;
      }>;
    return rows.map((r) => ({
      target: r.target_path,
      score: r.score,
      type: r.link_type,
    }));
  }

  /**
   * Remove all graph links from and to a note.
   */
  removeGraphLinks(notePath: string): void {
    const relPath = path.isAbsolute(notePath)
      ? path.relative(this.vaultPath, notePath)
      : notePath;
    this.db
      .prepare(
        "DELETE FROM graph_links WHERE source_path = ? OR target_path = ?",
      )
      .run(relPath, relPath);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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
