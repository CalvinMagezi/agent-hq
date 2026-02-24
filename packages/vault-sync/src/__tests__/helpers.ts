/**
 * Test helpers for vault-sync tests.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import matter from "gray-matter";

/** Create a temporary vault directory with standard structure. */
export function createTempVault(): {
  vaultPath: string;
  cleanup: () => void;
} {
  const vaultPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-sync-test-"),
  );

  // Create standard vault directories
  const dirs = [
    "_system",
    "_jobs/pending",
    "_jobs/running",
    "_jobs/done",
    "_jobs/failed",
    "_delegation/pending",
    "_delegation/claimed",
    "_delegation/completed",
    "_delegation/relay-health",
    "_approvals/pending",
    "_approvals/resolved",
    "_threads/active",
    "_threads/archived",
    "_logs",
    "_usage/daily",
    "_embeddings",
    "_moc",
    "Notebooks/Projects",
    "Notebooks/Memory",
  ];

  for (const dir of dirs) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
  }

  // Create system files
  writeMd(path.join(vaultPath, "_system", "SOUL.md"), { type: "system" }, "Test soul");
  writeMd(path.join(vaultPath, "_system", "MEMORY.md"), { type: "system" }, "Test memory");

  return {
    vaultPath,
    cleanup: () => {
      try {
        fs.rmSync(vaultPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/** Write a markdown file with YAML frontmatter. */
export function writeMd(
  filePath: string,
  frontmatter: Record<string, any>,
  content: string,
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const output = matter.stringify("\n" + content + "\n", frontmatter);
  fs.writeFileSync(filePath, output, "utf-8");
}

/** Read a markdown file's frontmatter and content. */
export function readMd(filePath: string): {
  data: Record<string, any>;
  content: string;
} {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  return { data, content: content.trim() };
}

/** Sleep for a given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
