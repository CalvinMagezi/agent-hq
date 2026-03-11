import { cosineSimilarityTS, hashFileTS, walkVaultFilesTS, resolveWikilinksTS } from "./fallback";

interface NativeBindings {
  helloWorld(): string;
  cosineSimilarity(a: Buffer, b: Buffer): number;
  batchCosineSimilarity(query: Buffer, matrix: Buffer, dim: number): number[];
  hashFile(path: string): string;
  hashFilesParallel(paths: string[]): string[];
  walkVaultFiles(root: string, skipPatterns: string[], extFilter?: string): string[];
  resolveWikilinks(vaultRoot: string, wikilinks: string[]): (string | null)[];
}

let native: NativeBindings | null = null;

try {
  // Try to load the native module based on the architecture
  // Current build generates .darwin-arm64.node on M4
  native = require("./vault-native.darwin-arm64.node");
  console.log("[vault-native] Native acceleration loaded successfully.");
} catch {
  // Native module not compiled — TypeScript fallbacks will be used
}

export function helloWorld(): string {
  if (native) return native.helloWorld();
  return "Hello from TypeScript (Fallback)!";
}

export const isNativeLoaded = native !== null;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (native) {
    return native.cosineSimilarity(
      Buffer.from(a.buffer, a.byteOffset, a.byteLength),
      Buffer.from(b.buffer, b.byteOffset, b.byteLength)
    );
  }
  return cosineSimilarityTS(a, b);
}

export function hashFile(filePath: string): string {
  if (native) return native.hashFile(filePath);
  return hashFileTS(filePath);
}

export function walkVaultFiles(root: string, skipPatterns: string[], extFilter?: string): string[] {
  if (native) return native.walkVaultFiles(root, skipPatterns, extFilter);
  return walkVaultFilesTS(root, skipPatterns, extFilter);
}

export function batchCosineSimilarity(query: Float32Array, matrix: Float32Array, dim: number): number[] {
  if (native) {
    return native.batchCosineSimilarity(
      Buffer.from(query.buffer, query.byteOffset, query.byteLength),
      Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength),
      dim
    );
  }
  // Fallback implementation for batch similarity
  const results: number[] = [];
  const count = matrix.length / dim;
  for (let i = 0; i < count; i++) {
    const vec = matrix.subarray(i * dim, (i + 1) * dim);
    results.push(cosineSimilarityTS(query, vec));
  }
  return results;
}

export function hashFilesParallel(paths: string[]): string[] {
  if (native) return native.hashFilesParallel(paths);
  return paths.map(hashFileTS);
}

export function resolveWikilinks(vaultRoot: string, wikilinks: string[]): (string | null)[] {
  if (native) return native.resolveWikilinks(vaultRoot, wikilinks);
  return resolveWikilinksTS(vaultRoot, wikilinks);
}
