/**
 * Benchmark: Native Rust vs TypeScript fallback performance.
 * Run: bun packages/vault-native/__test__/bench.ts
 */

import {
  cosineSimilarity,
  batchCosineSimilarity,
  hashFile,
  hashFilesParallel,
  walkVaultFiles,
} from "../index";
import { cosineSimilarityTS, hashFileTS, walkVaultFilesTS } from "../fallback";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function bench(name: string, fn: () => void, iterations = 1000): number {
  // Warmup
  for (let i = 0; i < 10; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  return elapsed / iterations;
}

console.log("=== vault-native benchmark ===\n");

// ── Cosine Similarity ────────────────────────────────────────────────

const dim = 768; // typical embedding dimension
const vecA = new Float32Array(dim);
const vecB = new Float32Array(dim);
for (let i = 0; i < dim; i++) {
  vecA[i] = Math.random() * 2 - 1;
  vecB[i] = Math.random() * 2 - 1;
}

const csNative = bench("cosine_similarity (native)", () => cosineSimilarity(vecA, vecB));
const csTS = bench("cosine_similarity (TS)", () => cosineSimilarityTS(vecA, vecB));
console.log(`cosine_similarity:  native ${csNative.toFixed(4)}ms vs TS ${csTS.toFixed(4)}ms (${(csTS / csNative).toFixed(1)}x speedup)`);

// ── Batch Cosine Similarity ──────────────────────────────────────────

const numVecs = 500; // simulate 500 embeddings
const matrix = new Float32Array(numVecs * dim);
for (let i = 0; i < matrix.length; i++) {
  matrix[i] = Math.random() * 2 - 1;
}

const batchNative = bench("batch_cosine (native)", () => batchCosineSimilarity(vecA, matrix, dim), 100);
const batchTS = bench("batch_cosine (TS loop)", () => {
  for (let i = 0; i < numVecs; i++) {
    cosineSimilarityTS(vecA, matrix.subarray(i * dim, (i + 1) * dim));
  }
}, 100);
console.log(`batch_cosine (${numVecs} vecs): native ${batchNative.toFixed(4)}ms vs TS ${batchTS.toFixed(4)}ms (${(batchTS / batchNative).toFixed(1)}x speedup)`);

// ── File Hashing ─────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hash-"));
const testFiles: string[] = [];
for (let i = 0; i < 50; i++) {
  const f = path.join(tmpDir, `file-${i}.md`);
  fs.writeFileSync(f, `# File ${i}\n${"Content line.\n".repeat(100)}`);
  testFiles.push(f);
}

const hashNative = bench("hash_file (native)", () => hashFile(testFiles[0]), 500);
const hashTS = bench("hash_file (TS)", () => hashFileTS(testFiles[0]), 500);
console.log(`hash_file:          native ${hashNative.toFixed(4)}ms vs TS ${hashTS.toFixed(4)}ms (${(hashTS / hashNative).toFixed(1)}x speedup)`);

const parallelNative = bench("hash_parallel 50 (native)", () => hashFilesParallel(testFiles), 50);
const parallelTS = bench("hash_parallel 50 (TS)", () => testFiles.map(hashFileTS), 50);
console.log(`hash_parallel (50): native ${parallelNative.toFixed(4)}ms vs TS ${parallelTS.toFixed(4)}ms (${(parallelTS / parallelNative).toFixed(1)}x speedup)`);

// ── Vault Walker ─────────────────────────────────────────────────────

const vaultPath = path.resolve(process.cwd(), ".vault");
if (fs.existsSync(vaultPath)) {
  const skipDirs = ["_embeddings", ".git", "node_modules", ".obsidian"];
  const walkNative = bench("walk_vault (native)", () => walkVaultFiles(vaultPath, skipDirs, "md"), 50);
  const walkTS = bench("walk_vault (TS)", () => walkVaultFilesTS(vaultPath, skipDirs, "md"), 50);
  console.log(`walk_vault:         native ${walkNative.toFixed(4)}ms vs TS ${walkTS.toFixed(4)}ms (${(walkTS / walkNative).toFixed(1)}x speedup)`);
} else {
  console.log("walk_vault:         skipped (no .vault directory found)");
}

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("\nDone.");
