/**
 * Daemon Tasks: Health Check, Relay Health, Stale Job Cleanup,
 * Delegation Artifact Cleanup, Expire Approvals, Memory Forgetting/Consolidation.
 *
 * These are smaller tasks grouped together since each is under ~70 lines.
 */

import * as fs from "fs";
import * as path from "path";
import { fetchEmbedding, isEmbeddingProviderAvailable } from "@repo/vault-client";
import type { DaemonContext } from "./context.js";

// ─── Config ────────────────────────────────────────────────────────

const STALE_JOB_DAYS = 7;
const STUCK_JOB_HOURS = 2;
const OFFLINE_WORKER_SECONDS = 30;

// ─── Task: Expire Stale Approvals (every 1 min) ────────────────────

export async function expireApprovals(ctx: DaemonContext): Promise<void> {
  const pendingDir = path.join(ctx.vaultPath, "_approvals/pending");
  if (!fs.existsSync(pendingDir)) return;

  const files = fs
    .readdirSync(pendingDir)
    .filter((f) => f.endsWith(".md"));
  const now = Date.now();
  let expired = 0;

  for (const file of files) {
    try {
      const filePath = path.join(pendingDir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const matter = await import("gray-matter").then((m) => m.default);
      const { data } = matter(raw);

      if (data.expiresAt && new Date(data.expiresAt).getTime() < now) {
        await ctx.vault.resolveApproval(data.approvalId, "rejected", "system", "Expired");
        expired++;
      }
    } catch {
      // Skip malformed files
    }
  }

  if (expired > 0) {
    console.log(`[approvals] Expired ${expired} stale approval(s)`);
  }
}

// ─── Task: Health Check (every 5 min) ──────────────────────────────

export async function healthCheck(ctx: DaemonContext): Promise<void> {
  const now = Date.now();

  // Check for stuck jobs
  const runningDir = path.join(ctx.vaultPath, "_jobs/running");
  if (fs.existsSync(runningDir)) {
    const files = fs
      .readdirSync(runningDir)
      .filter((f) => f.endsWith(".md"));

    for (const file of files) {
      try {
        const filePath = path.join(runningDir, file);
        const matter = await import("gray-matter").then((m) => m.default);
        const { data } = matter(fs.readFileSync(filePath, "utf-8"));

        const updatedAt = data.updatedAt ?? data.createdAt;
        if (updatedAt) {
          const elapsed = now - new Date(updatedAt).getTime();
          if (elapsed > STUCK_JOB_HOURS * 3600 * 1000) {
            await ctx.vault.updateJobStatus(data.jobId, "failed", {
              result: `Job stuck for ${Math.round(elapsed / 3600000)}h, marked as failed by health check`,
            });
            console.log(`[health] Failed stuck job: ${data.jobId}`);
            await ctx.notify(
              `⚠️ <b>Health Alert</b>: Job <code>${data.jobId}</code> was stuck for ${Math.round(elapsed / 3600000)}h and has been marked failed.`,
              `stuck-job:${data.jobId}`
            );
          }
        }
      } catch {
        // Skip
      }
    }
  }

  // Check for offline workers
  const sessionsDir = path.join(ctx.vaultPath, "_agent-sessions");
  if (fs.existsSync(sessionsDir)) {
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".md"));

    for (const file of files) {
      try {
        const filePath = path.join(sessionsDir, file);
        const matter = await import("gray-matter").then((m) => m.default);
        const raw = fs.readFileSync(filePath, "utf-8");
        const { data, content } = matter(raw);

        if (data.status === "online" && data.lastHeartbeat) {
          const elapsed = now - new Date(data.lastHeartbeat).getTime();
          if (elapsed > OFFLINE_WORKER_SECONDS * 1000) {
            data.status = "offline";
            fs.writeFileSync(filePath, matter.stringify(content.trim(), data), "utf-8");
            console.log(`[health] Worker ${data.workerId} marked offline`);
          }
        }
      } catch {
        // Skip
      }
    }
  }
}

// ─── Task: Embedding Processor (every 30 min) ──────────────────────

export async function processEmbeddings(ctx: DaemonContext): Promise<void> {
  const provider = ctx.embeddingProvider;

  // Check if provider is available (handles Ollama health check, "none" type, etc.)
  if (!(await isEmbeddingProviderAvailable(provider))) return;

  const pendingNotes = await ctx.vault.getNotesForEmbedding("pending", 10);
  if (pendingNotes.length === 0) return;

  console.log(`[embeddings] Processing ${pendingNotes.length} note(s) via ${provider.type}...`);

  for (const note of pendingNotes) {
    try {
      await ctx.vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "processing",
      });

      const text = `${note.title}\n\n${note.content}`.substring(0, 8000);
      const embedding = await fetchEmbedding(text, provider);

      if (!embedding) {
        throw new Error("No embedding returned");
      }

      ctx.search.storeEmbedding(note._filePath, embedding, provider.model);
      ctx.search.indexNote(note._filePath, note.title, note.content, note.tags);

      await ctx.vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "embedded",
        embeddedAt: new Date().toISOString(),
        embeddingModel: provider.model,
      });

      console.log(`[embeddings] Embedded: ${note.title}`);
    } catch (err) {
      await ctx.vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "failed",
      });
      console.error(`[embeddings] Failed: ${note.title}:`, err);
    }
  }
}

// ─── Task: Memory Forgetting Cycle (every 24 hr) ───────────────────

export async function forgetWeakMemories(ctx: DaemonContext): Promise<void> {
  try {
    const result = ctx.memorySystem.forgetter.runCycle();
    if (result.decayed > 0 || result.pruned > 0) {
      console.log(`[memory-decay] Decayed ${result.decayed}, pruned ${result.pruned} memories. DB now: ${result.statsAfter.total} total`);
    }
  } catch (err) {
    console.error("[daemon] Memory forgetting cycle failed:", err);
  }
}

// ─── Task: Memory Consolidation (every 30 min) ─────────────────────

export async function consolidateMemory(ctx: DaemonContext): Promise<void> {
  try {
    const insight = await ctx.memorySystem.consolidator.runCycle();
    if (insight) {
      await ctx.memorySystem.consolidator.refreshMemoryFile();
      await ctx.notifyIfMeaningful(
        "memory-consolidation",
        "new cross-harness connections found",
        true,
        () => `🧠 <b>Memory consolidation</b> complete — new insight recorded in Notebooks/Memories/`
      );
    }
  } catch (err) {
    console.error("[daemon] Memory consolidation failed:", err);
  }
}

// ─── Task: Stale Job Cleanup (every 1 hr) ──────────────────────────

export async function cleanupStaleJobs(ctx: DaemonContext): Promise<void> {
  const now = Date.now();
  const maxAge = STALE_JOB_DAYS * 24 * 3600 * 1000;
  let cleaned = 0;

  try {
    await ctx.vault.jobQueue.reap("running", "pending", 7200);
    await ctx.vault.jobQueue.purge("done", STALE_JOB_DAYS * 24 * 3600);
    cleaned++;
  } catch (err) {
    console.error("[cleanup] job queue cleanup failed:", err);
  }

  const logsDir = path.join(ctx.vaultPath, "_logs");
  if (fs.existsSync(logsDir)) {
    const dateDirs = fs.readdirSync(logsDir, { withFileTypes: true });
    for (const d of dateDirs) {
      if (d.isDirectory()) {
        const dirPath = path.join(logsDir, d.name);
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > maxAge) {
          fs.rmSync(dirPath, { recursive: true });
          cleaned++;
        }
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[cleanup] FBMQ reap/purge completed and removed ${cleaned} stale item(s)`);
  }
}

// ─── Task: Task Queue Cleanup (every 1 hr) ──────────────────────────

export async function cleanupDelegationArtifacts(ctx: DaemonContext): Promise<void> {
  let cleaned = 0;

  // Reap stale running tasks (>2hr) back to pending
  cleaned += ctx.vault.taskQueue.reap("running", "pending", 7200);

  // Purge completed/failed tasks older than 7 days
  cleaned += ctx.vault.taskQueue.purge("completed", 7 * 24 * 3600);
  cleaned += ctx.vault.taskQueue.purge("failed", 7 * 24 * 3600);

  // Also clean up job queue
  cleaned += ctx.vault.jobQueue.reap("running", "pending", 7200);
  cleaned += ctx.vault.jobQueue.purge("done", 7 * 24 * 3600);
  cleaned += ctx.vault.jobQueue.purge("failed", 7 * 24 * 3600);

  if (cleaned > 0) {
    console.log(`[queue-cleanup] Removed/reaped ${cleaned} stale item(s)`);
  }
}
