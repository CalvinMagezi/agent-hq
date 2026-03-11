/**
 * VaultClient — Note CRUD methods.
 */

import * as fs from "fs";
import * as path from "path";
import { VaultClient } from "./core";
import type {
  Note,
  NoteType,
  EmbeddingStatus,
  SearchResult,
} from "./types";

declare module "./core" {
  interface VaultClient {
    createNote(
      folder: string,
      title: string,
      content: string,
      options?: Partial<{
        noteType: NoteType;
        tags: string[];
        pinned: boolean;
        source: string;
      }>,
    ): Promise<string>;
    readNote(notePath: string): Promise<Note>;
    updateNote(
      notePath: string,
      content?: string,
      frontmatterUpdates?: Record<string, any>,
    ): Promise<void>;
    searchNotes(query: string, limit?: number): Promise<SearchResult[]>;
    listNotes(
      folder: string,
      filters?: Partial<{ noteType: NoteType; pinned: boolean; embeddingStatus: EmbeddingStatus }>,
    ): Promise<Note[]>;
    getNotesForEmbedding(status?: EmbeddingStatus, limit?: number): Promise<Note[]>;
  }
}

VaultClient.prototype.createNote = async function (folder, title, content, options) {
  const safeTitle = title.replace(/[/\\:*?"<>|]/g, "-");
  const filePath = this.resolve("Notebooks", folder, `${safeTitle}.md`);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const frontmatter: Record<string, any> = {
    noteType: options?.noteType ?? "note",
    tags: options?.tags ?? [],
    pinned: options?.pinned ?? false,
    source: options?.source ?? "manual",
    embeddingStatus: "pending",
    relatedNotes: [],
    createdAt: this.nowISO(),
    updatedAt: this.nowISO(),
    version: 1,
    lastModifiedBy: "hq-agent",
  };

  const GRAPH_MARKER = "<!-- agent-hq-graph-links -->";
  const body = content.includes(GRAPH_MARKER)
    ? `# ${title}\n\n${content}`
    : `# ${title}\n\n${content}\n\n${GRAPH_MARKER}\n## Related Notes\n\n_Links will be auto-generated after embedding._\n`;

  this.writeMdFile(filePath, frontmatter, body, { modifiedBy: "hq-agent", isCreate: true });
  return filePath;
};

VaultClient.prototype.readNote = async function (notePath) {
  const filePath = path.isAbsolute(notePath)
    ? notePath
    : this.resolve(notePath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Note not found: ${notePath}`);
  }

  const { data, content } = this.readMdFile(filePath);
  return this.parseNote(filePath, data, content);
};

VaultClient.prototype.updateNote = async function (notePath, content, frontmatterUpdates) {
  const filePath = path.isAbsolute(notePath)
    ? notePath
    : this.resolve(notePath);

  const token = await this.acquireLock(filePath);
  try {
    const { data, content: existingContent } = this.readMdFile(filePath);

    if (frontmatterUpdates) {
      Object.assign(data, frontmatterUpdates);
    }
    data.updatedAt = this.nowISO();

    if (content && content !== existingContent) {
      data.embeddingStatus = "pending";
    }

    this.writeMdFile(filePath, data, content ?? existingContent, { modifiedBy: "hq-agent" });
  } finally {
    await this.releaseLock(filePath, token);
  }
};

VaultClient.prototype.searchNotes = async function (query, limit = 10) {
  const results: SearchResult[] = [];
  const queryLower = query.toLowerCase();
  const notebooksDir = this.resolve("Notebooks");
  if (!fs.existsSync(notebooksDir)) return results;

  const scanDir = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const { data, content } = this.readMdFile(fullPath);
          const titleMatch = (data.title || entry.name)
            .toLowerCase()
            .includes(queryLower);
          const contentMatch = content.toLowerCase().includes(queryLower);
          const tagMatch = (data.tags || []).some((t: string) =>
            t.toLowerCase().includes(queryLower),
          );

          if (titleMatch || contentMatch || tagMatch) {
            let relevance = 0;
            if (titleMatch) relevance += 3;
            if (tagMatch) relevance += 2;
            if (contentMatch) relevance += 1;

            let snippet = "";
            const idx = content.toLowerCase().indexOf(queryLower);
            if (idx !== -1) {
              const start = Math.max(0, idx - 50);
              const end = Math.min(content.length, idx + query.length + 50);
              snippet = content.substring(start, end).replace(/\n/g, " ");
              if (start > 0) snippet = "..." + snippet;
              if (end < content.length) snippet += "...";
            } else {
              snippet = content.substring(0, 100).replace(/\n/g, " ");
            }

            const relPath = path.relative(this.resolve("Notebooks"), fullPath);
            const notebook = relPath.split(path.sep)[0] ?? "Unknown";

            results.push({
              noteId: path.relative(this.vaultPath, fullPath),
              title: path.basename(entry.name, ".md"),
              notebook,
              snippet,
              tags: data.tags ?? [],
              relevance,
              _filePath: fullPath,
            });
          }
        } catch {
          // Skip malformed files
        }
      }
    }
  };

  scanDir(notebooksDir);
  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, limit);
};

VaultClient.prototype.listNotes = async function (folder, filters) {
  const dir = this.resolve("Notebooks", folder);
  if (!fs.existsSync(dir)) return [];

  const notes: Note[] = [];
  const scanDir = (d: string) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".md") && entry.name !== "_meta.md") {
        try {
          const { data, content } = this.readMdFile(fullPath);
          if (filters) {
            if (filters.noteType && data.noteType !== filters.noteType) continue;
            if (filters.pinned !== undefined && data.pinned !== filters.pinned) continue;
            if (filters.embeddingStatus && data.embeddingStatus !== filters.embeddingStatus) continue;
          }
          notes.push(this.parseNote(fullPath, data, content));
        } catch {
          // Skip
        }
      }
    }
  };

  scanDir(dir);
  return notes;
};

VaultClient.prototype.getNotesForEmbedding = async function (status = "pending", limit = 10) {
  const results: Note[] = [];
  const notebooksDir = this.resolve("Notebooks");
  if (!fs.existsSync(notebooksDir)) return results;

  const scanDir = (dir: string) => {
    if (results.length >= limit) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const { data, content } = this.readMdFile(fullPath);
          if (data.embeddingStatus === status) {
            results.push(this.parseNote(fullPath, data, content));
          }
        } catch {
          // Skip
        }
      }
    }
  };

  scanDir(notebooksDir);
  return results;
};
