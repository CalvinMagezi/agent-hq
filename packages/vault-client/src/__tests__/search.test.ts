import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import { createTempVault, cleanupTempVault } from "./helpers";
import { SearchClient } from "../search";

let vaultPath: string;
let search: SearchClient;

beforeEach(() => {
  const tmp = createTempVault();
  vaultPath = tmp.vaultPath;
  search = new SearchClient(vaultPath);
});

afterEach(() => {
  search.close();
  cleanupTempVault(vaultPath);
});

describe("SearchClient", () => {
  test("initializes SQLite database", () => {
    const stats = search.getStats();
    expect(stats.ftsCount).toBe(0);
    expect(stats.embeddingCount).toBe(0);
  });

  test("indexNote adds to FTS index", () => {
    search.indexNote("notes/test.md", "Test Note", "This is the content", ["tag1"]);

    const stats = search.getStats();
    expect(stats.ftsCount).toBe(1);
  });

  test("keywordSearch finds indexed notes", () => {
    search.indexNote("notes/a.md", "Machine Learning", "Neural networks and deep learning", ["ai"]);
    search.indexNote("notes/b.md", "Web Design", "CSS and HTML fundamentals", ["web"]);

    const results = search.keywordSearch("neural networks");
    expect(results.length).toBe(1);
    expect(results[0].notePath).toBe("notes/a.md");
    expect(results[0].title).toBe("Machine Learning");
  });

  test("keywordSearch respects limit", () => {
    for (let i = 0; i < 10; i++) {
      search.indexNote(`notes/${i}.md`, `Note ${i}`, `Test content ${i}`, []);
    }

    const results = search.keywordSearch("test content", 3);
    expect(results.length).toBe(3);
  });

  test("removeNote removes from FTS index", () => {
    search.indexNote("notes/remove.md", "Remove Me", "Content", []);

    let stats = search.getStats();
    expect(stats.ftsCount).toBe(1);

    search.removeNote("notes/remove.md");

    stats = search.getStats();
    expect(stats.ftsCount).toBe(0);
  });

  test("storeEmbedding stores vector", () => {
    const embedding = new Array(1536).fill(0).map(() => Math.random());

    search.storeEmbedding("notes/embed.md", embedding, "text-embedding-3-small");

    const stats = search.getStats();
    expect(stats.embeddingCount).toBe(1);
  });

  test("close closes database cleanly", () => {
    search.indexNote("notes/close.md", "Close Test", "Content", []);
    search.close();
    // No error thrown = success
    // Create new search client to verify data persisted
    const search2 = new SearchClient(vaultPath);
    const stats = search2.getStats();
    expect(stats.ftsCount).toBe(1);
    search2.close();
  });
});
