/**
 * VaultClient core — constructor, helpers, locking, and parsers.
 *
 * Domain methods (jobs, notes, delegation, etc.) are added via
 * declaration merging in separate files imported by index.ts.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { JobQueue, DelegationQueue, FbmqCli, jobCodec, delegationCodec } from "@repo/queue-transport";
import type {
  Job,
  Note,
  DelegatedTask,
} from "./types";

export class VaultClient {
  readonly vaultPath: string;
  readonly jobQueue: JobQueue;
  readonly delegationQueue: DelegationQueue;

  /** @internal */ claimedJobs = new Map<string, string>();
  /** @internal */ claimedTasks = new Map<string, string>();
  /** @internal */ legacyClaimedTasks = new Map<string, string>();

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
    if (!fs.existsSync(this.vaultPath)) {
      throw new Error(`Vault not found at: ${this.vaultPath}`);
    }

    this.jobQueue = new JobQueue({ queueRoot: this.resolve("_fbmq/jobs") });
    this.delegationQueue = new DelegationQueue(
      { queueRoot: this.resolve("_fbmq/delegation") },
      this.resolve("_fbmq/staged")
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /** @internal */ resolve(...parts: string[]): string {
    return path.join(this.vaultPath, ...parts);
  }

  /** @internal */ readMdFile(filePath: string): { data: Record<string, any>; content: string } {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    return { data, content: content.trim() };
  }

  /** @internal */ writeMdFile(
    filePath: string,
    frontmatter: Record<string, any>,
    content: string,
    metadata?: Partial<{ modifiedBy: string, isCreate: boolean }>
  ): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Inject optimistic concurrency / tracking fields
    if (frontmatter.version === undefined) {
      frontmatter.version = 1;
    } else if (typeof frontmatter.version === "number" && !metadata?.isCreate) {
      frontmatter.version += 1;
    }

    if (metadata?.modifiedBy) {
      frontmatter.lastModifiedBy = metadata.modifiedBy;
    }

    const output = matter.stringify("\n" + content + "\n", frontmatter);
    fs.writeFileSync(filePath, output, "utf-8");
  }

  /** @internal */ updateFrontmatter(
    filePath: string,
    updates: Record<string, any>,
    metadata?: Partial<{ modifiedBy: string }>
  ): void {
    const { data, content } = this.readMdFile(filePath);
    Object.assign(data, updates);
    this.writeMdFile(filePath, data, content, metadata);
  }

  /** @internal */ listMdFiles(dirPath: string): string[] {
    const full = this.resolve(dirPath);
    if (!fs.existsSync(full)) return [];
    return fs
      .readdirSync(full)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(full, f));
  }

  /** @internal */ generateId(): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return `${ts}-${rand}`;
  }

  /** @internal */ nowISO(): string {
    return new Date().toISOString();
  }

  // ─── Locking ───────────────────────────────────────────────────────

  async acquireLock(filepath: string, maxAgeMs: number = 30000): Promise<string> {
    const lockDir = this.resolve("_locks");
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    const safeName = Buffer.from(filepath).toString("base64").replace(/[/+=]/g, "-");
    const lockPath = path.join(lockDir, `${safeName}.lock`);
    const lockToken = this.generateId();

    try {
      if (fs.existsSync(lockPath)) {
        const stat = fs.statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age < maxAgeMs) {
          throw new Error(`File is locked: ${filepath}`);
        }
      }

      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      fs.writeFileSync(lockPath, lockToken, { flag: "wx" });
      return lockToken;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        throw new Error(`File is locked: ${filepath}`);
      }
      throw err;
    }
  }

  async releaseLock(filepath: string, token: string): Promise<void> {
    const safeName = Buffer.from(filepath).toString("base64").replace(/[/+=]/g, "-");
    const lockPath = this.resolve("_locks", `${safeName}.lock`);

    try {
      if (fs.existsSync(lockPath)) {
        const existingToken = fs.readFileSync(lockPath, "utf-8");
        if (existingToken === token) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  // ─── RFC822 Helpers ────────────────────────────────────────────────

  /** @internal */ writeRFC822(filePath: string, item: any, codec: any) {
    const { body, priority, tags, correlationId, custom, ttl } = codec.serialize(item);
    let rfc822 = `Priority: ${priority}\n`;
    if (tags) rfc822 += `Tags: ${tags}\n`;
    if (correlationId) rfc822 += `Correlation-Id: ${correlationId}\n`;
    if (ttl) rfc822 += `TTL: ${ttl}\n`;
    if (custom && Object.keys(custom).length > 0) {
      rfc822 += `Custom:\n`;
      for (const [k, v] of Object.entries(custom)) {
        rfc822 += `  ${k}: ${v}\n`;
      }
    }
    rfc822 += `\n${body}`;
    fs.writeFileSync(filePath, rfc822, "utf-8");
  }

  // ─── Parsers ───────────────────────────────────────────────────────

  /** @internal */ parseJob(
    filePath: string,
    data: Record<string, any>,
    content: string,
  ): Job {
    const instrMatch = content.match(/^#\s+Instruction\s*\n([\s\S]*?)(?=\n##|$)/m);
    const instruction = instrMatch?.[1]?.trim() ?? content;

    return {
      jobId: data.jobId ?? "",
      type: data.type ?? "background",
      status: data.status ?? "pending",
      priority: data.priority ?? 50,
      securityProfile: data.securityProfile ?? "standard",
      modelOverride: data.modelOverride ?? null,
      thinkingLevel: data.thinkingLevel ?? null,
      workerId: data.workerId ?? null,
      threadId: data.threadId ?? null,
      instruction,
      result: data.result,
      streamingText: data.streamingText,
      conversationHistory: data.conversationHistory,
      steeringMessage: data.steeringMessage,
      stats: data.stats,
      createdAt: data.createdAt ?? "",
      updatedAt: data.updatedAt,
      _filePath: filePath,
    };
  }

  /** @internal */ parseNote(
    filePath: string,
    data: Record<string, any>,
    content: string,
  ): Note {
    return {
      title: path.basename(filePath, ".md"),
      content,
      noteType: data.noteType ?? "note",
      tags: data.tags ?? [],
      pinned: data.pinned ?? false,
      source: data.source ?? "manual",
      embeddingStatus: data.embeddingStatus ?? "pending",
      relatedNotes: data.relatedNotes ?? [],
      createdAt: data.createdAt ?? "",
      updatedAt: data.updatedAt ?? "",
      _filePath: filePath,
    };
  }

  /** @internal */ parseDelegatedTask(
    filePath: string,
    data: Record<string, any>,
    content: string,
  ): DelegatedTask {
    const instrMatch = content.match(
      /^#\s+Task\s+Instruction\s*\n([\s\S]*?)(?=\n##|$)/m,
    );
    const instruction = instrMatch?.[1]?.trim() ?? content;

    return {
      taskId: data.taskId ?? "",
      jobId: data.jobId ?? "",
      targetHarnessType: data.targetHarnessType ?? "any",
      status: data.status ?? "pending",
      priority: data.priority ?? 50,
      deadlineMs: data.deadlineMs ?? 600000,
      dependsOn: data.dependsOn ?? [],
      claimedBy: data.claimedBy ?? null,
      claimedAt: data.claimedAt ?? null,
      instruction,
      result: data.result,
      error: data.error,
      createdAt: data.createdAt ?? "",
      traceId: data.traceId ?? undefined,
      spanId: data.spanId ?? undefined,
      parentSpanId: data.parentSpanId ?? undefined,
      securityConstraints: data.securityConstraints ?? undefined,
      _filePath: filePath,
    };
  }
}
