/**
 * AtomicQueue — Formalized directory-as-queue with atomic renameSync transitions.
 *
 * Inspired by TigerFS's atomic `mv` for task queues. Generalizes the
 * Agent-HQ pattern of pending/ → active/ → done/ (or failed/) directories
 * into a reusable, type-safe utility.
 *
 * Concurrency safety: fs.renameSync is atomic on the same filesystem.
 * If two processes race to claim the same item, exactly one succeeds;
 * the other gets ENOENT and moves on.
 *
 * Usage:
 *   const q = new AtomicQueue("/path/to/vault/_approvals", {
 *     stages: ["pending", "active", "resolved", "rejected"],
 *   });
 *
 *   const item = q.dequeue("pending", "active");  // atomic claim
 *   if (item) {
 *     // process...
 *     q.transition(item.name, "active", "resolved");
 *   }
 */

import * as fs from "fs";
import * as path from "path";

export interface AtomicQueueConfig {
  /** Stage directory names in order (e.g., ["pending", "active", "done", "failed"]) */
  stages: string[];
  /** File extension filter (default: ".md") */
  extension?: string;
}

export interface QueueItem {
  /** Filename (e.g., "task-123.md") */
  name: string;
  /** Full path to the file in its current stage */
  path: string;
  /** Current stage directory name */
  stage: string;
}

export class AtomicQueue {
  private root: string;
  private stages: string[];
  private extension: string;

  constructor(root: string, config: AtomicQueueConfig) {
    this.root = root;
    this.stages = config.stages;
    this.extension = config.extension ?? ".md";

    // Ensure all stage directories exist
    for (const stage of this.stages) {
      const dir = path.join(this.root, stage);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Atomically move one item from `fromStage` to `toStage`.
   * Returns the item if successful, null if nothing was available.
   *
   * This is the core "claim" operation — safe for concurrent callers.
   */
  dequeue(fromStage: string, toStage: string): QueueItem | null {
    this.assertStage(fromStage);
    this.assertStage(toStage);

    const fromDir = path.join(this.root, fromStage);
    if (!fs.existsSync(fromDir)) return null;

    const entries = fs.readdirSync(fromDir).filter((f) => f.endsWith(this.extension));

    for (const name of entries) {
      const fromPath = path.join(fromDir, name);
      const toPath = path.join(this.root, toStage, name);

      try {
        fs.renameSync(fromPath, toPath);
        return { name, path: toPath, stage: toStage };
      } catch (err: any) {
        // ENOENT = another process claimed it first — try next
        if (err.code === "ENOENT") continue;
        throw err;
      }
    }

    return null;
  }

  /**
   * Atomically move a specific item between stages.
   * Returns true if successful, false if the item wasn't in fromStage.
   */
  transition(name: string, fromStage: string, toStage: string): boolean {
    this.assertStage(fromStage);
    this.assertStage(toStage);

    const fromPath = path.join(this.root, fromStage, name);
    const toPath = path.join(this.root, toStage, name);

    try {
      fs.renameSync(fromPath, toPath);
      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  /** List all items in a given stage. */
  list(stage: string): QueueItem[] {
    this.assertStage(stage);
    const dir = path.join(this.root, stage);
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(this.extension))
      .map((name) => ({
        name,
        path: path.join(dir, name),
        stage,
      }));
  }

  /** Count items in a stage without reading file contents. */
  count(stage: string): number {
    this.assertStage(stage);
    const dir = path.join(this.root, stage);
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith(this.extension)).length;
  }

  /** Get counts for all stages. */
  stats(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const stage of this.stages) {
      result[stage] = this.count(stage);
    }
    return result;
  }

  /** Find which stage an item is currently in, or null if not found. */
  find(name: string): QueueItem | null {
    for (const stage of this.stages) {
      const filePath = path.join(this.root, stage, name);
      if (fs.existsSync(filePath)) {
        return { name, path: filePath, stage };
      }
    }
    return null;
  }

  /** Add a new item to a stage by writing content. */
  enqueue(name: string, stage: string, content: string): QueueItem {
    this.assertStage(stage);
    const filePath = path.join(this.root, stage, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return { name, path: filePath, stage };
  }

  /**
   * Reap stale items: move items in `fromStage` back to `toStage` if their
   * mtime is older than `maxAgeSecs`. Useful for recovering leaked claims
   * (e.g. processing → pending when a worker crashes).
   */
  reap(fromStage: string, toStage: string, maxAgeSecs: number): number {
    this.assertStage(fromStage);
    this.assertStage(toStage);

    const dir = path.join(this.root, fromStage);
    if (!fs.existsSync(dir)) return 0;

    const now = Date.now();
    let count = 0;

    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(this.extension))) {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeSecs * 1000) {
          const destPath = path.join(this.root, toStage, name);
          fs.renameSync(filePath, destPath);
          count++;
        }
      } catch (err: any) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
    }

    return count;
  }

  /**
   * Purge old items from a terminal stage (done/failed/completed).
   * Deletes files older than `maxAgeSecs`.
   */
  purge(stage: string, maxAgeSecs: number): number {
    this.assertStage(stage);

    const dir = path.join(this.root, stage);
    if (!fs.existsSync(dir)) return 0;

    const now = Date.now();
    let count = 0;

    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(this.extension))) {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeSecs * 1000) {
          fs.unlinkSync(filePath);
          count++;
        }
      } catch (err: any) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
    }

    return count;
  }

  private assertStage(stage: string): void {
    if (!this.stages.includes(stage)) {
      throw new Error(
        `Unknown stage "${stage}". Valid stages: ${this.stages.join(", ")}`,
      );
    }
  }
}
