import { describe, test, expect } from "bun:test";
import {
  cosineSimilarity,
  batchCosineSimilarity,
  hashFile,
  hashFilesParallel,
  walkVaultFiles,
  resolveWikilinks,
  helloWorld,
} from "../index";
import { cosineSimilarityTS, hashFileTS, walkVaultFilesTS, resolveWikilinksTS } from "../fallback";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Hello World ──────────────────────────────────────────────────────

describe("hello world", () => {
  test("returns a greeting", () => {
    const result = helloWorld();
    expect(result).toContain("Hello");
  });
});

// ── Cosine Similarity ────────────────────────────────────────────────

describe("cosine similarity", () => {
  test("identical vectors return 1.0", () => {
    const a = new Float32Array([1, 2, 3, 4]);
    const b = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  test("orthogonal vectors return 0.0", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test("opposite vectors return -1.0", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test("empty vectors return 0.0", () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("mismatched lengths return 0.0", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("matches TypeScript fallback within epsilon", () => {
    const a = new Float32Array([0.5, -0.3, 0.8, 0.1, -0.9, 0.4]);
    const b = new Float32Array([0.2, 0.7, -0.1, 0.6, 0.3, -0.5]);
    const native = cosineSimilarity(a, b);
    const ts = cosineSimilarityTS(a, b);
    expect(Math.abs(native - ts)).toBeLessThan(1e-5);
  });
});

// ── Batch Cosine Similarity ──────────────────────────────────────────

describe("batch cosine similarity", () => {
  test("returns correct number of scores", () => {
    const query = new Float32Array([1, 0, 0]);
    const matrix = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const scores = batchCosineSimilarity(query, matrix, 3);
    expect(scores).toHaveLength(3);
    expect(scores[0]).toBeCloseTo(1.0, 5); // identical
    expect(scores[1]).toBeCloseTo(0.0, 5); // orthogonal
    expect(scores[2]).toBeCloseTo(0.0, 5); // orthogonal
  });

  test("matches individual cosine similarity calls", () => {
    const query = new Float32Array([0.5, -0.3, 0.8, 0.1]);
    const vecs = [
      new Float32Array([0.2, 0.7, -0.1, 0.6]),
      new Float32Array([0.9, 0.1, 0.5, -0.2]),
      new Float32Array([-0.4, 0.3, 0.6, 0.8]),
    ];
    const matrix = new Float32Array(3 * 4);
    vecs.forEach((v, i) => matrix.set(v, i * 4));

    const batchScores = batchCosineSimilarity(query, matrix, 4);
    for (let i = 0; i < vecs.length; i++) {
      const individual = cosineSimilarity(query, vecs[i]);
      expect(Math.abs(batchScores[i] - individual)).toBeLessThan(1e-5);
    }
  });

  test("empty matrix returns empty array", () => {
    const query = new Float32Array([1, 0]);
    const matrix = new Float32Array([]);
    expect(batchCosineSimilarity(query, matrix, 2)).toHaveLength(0);
  });
});

// ── File Hashing ─────────────────────────────────────────────────────

describe("file hashing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-native-test-"));
  const testFile = path.join(tmpDir, "test.md");
  fs.writeFileSync(testFile, "# Hello World\nSome content here.");

  test("returns a valid SHA-256 hex string", () => {
    const hash = hashFile(testFile);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches TypeScript fallback", () => {
    const native = hashFile(testFile);
    const ts = hashFileTS(testFile);
    expect(native).toBe(ts);
  });

  test("parallel hashing matches sequential", () => {
    const file2 = path.join(tmpDir, "test2.md");
    fs.writeFileSync(file2, "Different content");

    const parallel = hashFilesParallel([testFile, file2]);
    expect(parallel).toHaveLength(2);
    expect(parallel[0]).toBe(hashFile(testFile));
    expect(parallel[1]).toBe(hashFile(file2));
  });

  test("non-existent file returns empty string in parallel", () => {
    const result = hashFilesParallel(["/nonexistent/path.md"]);
    expect(result[0]).toBe("");
  });
});

// ── Vault Walker ─────────────────────────────────────────────────────

describe("vault walker", () => {
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-native-walk-"));
  // Create test structure
  fs.mkdirSync(path.join(tmpVault, "Notebooks"));
  fs.mkdirSync(path.join(tmpVault, "_embeddings"));
  fs.mkdirSync(path.join(tmpVault, ".git"));
  fs.writeFileSync(path.join(tmpVault, "Notebooks", "note1.md"), "# Note 1");
  fs.writeFileSync(path.join(tmpVault, "Notebooks", "note2.md"), "# Note 2");
  fs.writeFileSync(path.join(tmpVault, "Notebooks", "image.png"), "binary");
  fs.writeFileSync(path.join(tmpVault, "_embeddings", "search.db"), "db");
  fs.writeFileSync(path.join(tmpVault, ".git", "config"), "git");

  test("finds markdown files with ext filter", () => {
    const files = walkVaultFiles(tmpVault, ["_embeddings", ".git"], "md");
    expect(files).toContain("Notebooks/note1.md");
    expect(files).toContain("Notebooks/note2.md");
    expect(files).not.toContain("Notebooks/image.png");
  });

  test("skips ignored directories", () => {
    const files = walkVaultFiles(tmpVault, ["_embeddings", ".git"], "md");
    const hasEmbeddings = files.some((f) => f.includes("_embeddings"));
    expect(hasEmbeddings).toBe(false);
  });

  test("without ext filter returns all files", () => {
    const files = walkVaultFiles(tmpVault, ["_embeddings", ".git"]);
    expect(files.length).toBeGreaterThanOrEqual(3); // note1.md, note2.md, image.png
  });
});

// ── Wikilink Resolution ──────────────────────────────────────────────

describe("resolve wikilinks", () => {
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-native-links-"));
  fs.mkdirSync(path.join(tmpVault, "Notebooks", "Projects"), { recursive: true });
  fs.writeFileSync(path.join(tmpVault, "Notebooks", "My Note.md"), "# My Note");
  fs.writeFileSync(path.join(tmpVault, "Notebooks", "Projects", "Plan.md"), "# Plan");

  test("resolves existing wikilinks", () => {
    const results = resolveWikilinks(tmpVault, ["My Note", "Plan"]);
    expect(results[0]).toContain("My Note.md");
    expect(results[1]).toContain("Plan.md");
  });

  test("returns null for non-existent links", () => {
    const results = resolveWikilinks(tmpVault, ["NonExistent"]);
    expect(results[0]).toBeNull();
  });

  test("handles aliases (pipe syntax)", () => {
    const results = resolveWikilinks(tmpVault, ["My Note|some alias"]);
    expect(results[0]).toContain("My Note.md");
  });

  test("matches TypeScript fallback", () => {
    const links = ["My Note", "Plan", "Missing"];
    const native = resolveWikilinks(tmpVault, links);
    const ts = resolveWikilinksTS(tmpVault, links);
    expect(native).toEqual(ts);
  });
});
