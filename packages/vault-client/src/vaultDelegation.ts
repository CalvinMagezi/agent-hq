/**
 * VaultClient — Delegation, live task output, and relay health methods.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { FbmqCli, delegationCodec } from "@repo/queue-transport";
import { VaultClient } from "./core";
import { scrubSecrets } from "./secretScrubber.js";
import type {
  DelegatedTask,
  HarnessType,
  TaskStatus,
  RelayHealth,
  LiveTaskOutput,
  DelegationSecurityConstraints,
} from "./types";

declare module "./core" {
  interface VaultClient {
    createDelegatedTasks(
      jobId: string,
      tasks: Array<{
        taskId: string;
        instruction: string;
        targetHarnessType?: HarnessType;
        priority?: number;
        deadlineMs?: number;
        dependsOn?: string[];
        modelOverride?: string;
        traceId?: string;
        spanId?: string;
        parentSpanId?: string;
        securityConstraints?: DelegationSecurityConstraints;
      }>,
    ): Promise<void>;
    readFullResult(taskId: string): string | null;
    getPendingTasks(harnessType: string): Promise<DelegatedTask[]>;
    claimTask(taskId: string, relayId: string): Promise<boolean>;
    updateTaskStatus(
      taskId: string,
      status: TaskStatus,
      result?: string,
      error?: string,
    ): Promise<void>;
    getTasksForJob(jobId: string): Promise<DelegatedTask[]>;

    // Relay Health
    getRelayHealthAll(): Promise<RelayHealth[]>;
    upsertRelayHealth(
      relayId: string,
      data: Partial<Omit<RelayHealth, "relayId" | "_filePath">>,
    ): Promise<void>;

    // Live Task Output
    writeLiveChunk(taskId: string, claimedBy: string, chunk: string): void;
    readLiveOutput(taskId: string): LiveTaskOutput | null;
    deleteLiveOutput(taskId: string): void;
    listLiveTasks(): LiveTaskOutput[];
  }
}

// ─── Delegation ────────────────────────────────────────────────────

VaultClient.prototype.createDelegatedTasks = async function (jobId, tasks) {
  for (const t of tasks) {
    const task: DelegatedTask = {
      taskId: t.taskId,
      jobId,
      targetHarnessType: t.targetHarnessType ?? "any",
      status: "pending",
      priority: t.priority ?? 50,
      deadlineMs: t.deadlineMs ?? 600000,
      dependsOn: t.dependsOn ?? [],
      claimedBy: null,
      claimedAt: null,
      instruction: scrubSecrets(t.instruction),
      createdAt: this.nowISO(),
      traceId: t.traceId,
      spanId: t.spanId,
      parentSpanId: t.parentSpanId,
      securityConstraints: t.securityConstraints,
      _filePath: "",
    };
    await this.delegationQueue.enqueue(task);
  }
};

VaultClient.prototype.readFullResult = function (taskId) {
  const filePath = this.resolve("_delegation/results", `result-${taskId}.md`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
};

VaultClient.prototype.getPendingTasks = async function (harnessType) {
  // 1. Try FBMQ queue
  const task = await this.delegationQueue.dequeue(harnessType as HarnessType);
  if (task) {
    this.claimedTasks.set(task.taskId, task._filePath);
    return [task];
  }

  // 2. Fallback: scan legacy _delegation/pending/ markdown files.
  const claimedDir = this.resolve("_delegation/claimed");
  if (!fs.existsSync(claimedDir)) fs.mkdirSync(claimedDir, { recursive: true });

  const dirsToScan: string[] = [];
  const harnessSubdir = this.resolve("_delegation/pending", harnessType);
  if (fs.existsSync(harnessSubdir)) dirsToScan.push(harnessSubdir);
  if (harnessType !== "any") {
    const anySubdir = this.resolve("_delegation/pending", "any");
    if (fs.existsSync(anySubdir)) dirsToScan.push(anySubdir);
  }
  const flatPendingDir = this.resolve("_delegation/pending");
  if (fs.existsSync(flatPendingDir)) dirsToScan.push(flatPendingDir);

  for (const pendingDir of dirsToScan) {
    const entries = fs.readdirSync(pendingDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    for (const file of files) {
      const filePath = path.join(pendingDir, file);
      try {
        const { data, content } = this.readMdFile(filePath);
        const taskHarness = (data.targetHarnessType as string) ?? "any";
        if (pendingDir === flatPendingDir && taskHarness !== harnessType && taskHarness !== "any") continue;
        const claimedPath = path.join(claimedDir, file);
        try {
          fs.renameSync(filePath, claimedPath);
        } catch {
          continue;
        }
        const legacyTask = this.parseDelegatedTask(claimedPath, data, content);
        this.legacyClaimedTasks.set(legacyTask.taskId, claimedPath);
        return [legacyTask];
      } catch {
        continue;
      }
    }
  }

  return [];
};

VaultClient.prototype.claimTask = async function (taskId, relayId) {
  if (this.legacyClaimedTasks.has(taskId)) {
    const claimedPath = this.legacyClaimedTasks.get(taskId)!;
    try {
      const { data, content } = this.readMdFile(claimedPath);
      const updated = { ...data, status: "claimed", claimedBy: relayId, claimedAt: this.nowISO() };
      fs.writeFileSync(claimedPath, matter.stringify("\n" + content + "\n", updated), "utf-8");
      return true;
    } catch { return false; }
  }
  const claimedPath = this.claimedTasks.get(taskId);
  if (!claimedPath) return false;

  try {
    const headers = await this.delegationQueue.inspectPath(claimedPath);
    const rawBody = await this.delegationQueue.catPath(claimedPath);
    const { custom: taskCustom, cleanBody: taskCleanBody } = FbmqCli.parseBodyCustom(rawBody);
    headers.custom = { ...headers.custom, ...taskCustom };
    const task = delegationCodec.deserialize(claimedPath, taskCleanBody, headers);

    task.status = "claimed";
    task.claimedBy = relayId;
    task.claimedAt = this.nowISO();

    this.writeRFC822(claimedPath, task, delegationCodec);
    return true;
  } catch {
    return false;
  }
};

VaultClient.prototype.updateTaskStatus = async function (taskId, status, result, error) {
  // Handle legacy markdown tasks
  if (this.legacyClaimedTasks.has(taskId)) {
    const claimedPath = this.legacyClaimedTasks.get(taskId)!;
    const { data, content } = this.readMdFile(claimedPath);
    const updated = { ...data, status, ...(result ? { result } : {}), ...(error ? { error } : {}) };
    const terminal = ["completed", "failed", "cancelled", "timeout"].includes(status);
    if (terminal) {
      const destDir = this.resolve(`_delegation/${status === "completed" ? "completed" : "failed"}`);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, path.basename(claimedPath));
      fs.writeFileSync(claimedPath, matter.stringify("\n" + content + "\n", updated), "utf-8");
      fs.renameSync(claimedPath, destPath);
      this.legacyClaimedTasks.delete(taskId);
    } else {
      fs.writeFileSync(claimedPath, matter.stringify("\n" + content + "\n", updated), "utf-8");
    }
    return;
  }

  const claimedPath = this.claimedTasks.get(taskId);
  if (!claimedPath) {
    throw new Error(`Task not found or not claimed by this process: ${taskId}`);
  }

  const headers = await this.delegationQueue.inspectPath(claimedPath);
  const rawBodyStr = await this.delegationQueue.catPath(claimedPath);
  const { custom: taskCustom2, cleanBody: taskCleanBody2 } = FbmqCli.parseBodyCustom(rawBodyStr);
  headers.custom = { ...headers.custom, ...taskCustom2 };
  const task = delegationCodec.deserialize(claimedPath, taskCleanBody2, headers);

  task.status = status;
  if (result) task.result = result;
  if (error) task.error = error;

  this.writeRFC822(claimedPath, task, delegationCodec);

  if (status === "completed" || status === "failed" || status === "cancelled" || status === "timeout") {
    await this.delegationQueue.complete(claimedPath);
    this.claimedTasks.delete(taskId);
  }
};

VaultClient.prototype.getTasksForJob = async function (jobId) {
  const tasks: DelegatedTask[] = [];
  const dirs = ["pending", "claimed", "completed"];

  for (const dir of dirs) {
    const files = this.listMdFiles(`_delegation/${dir}`);
    for (const f of files) {
      try {
        const { data, content } = this.readMdFile(f);
        if (data.jobId === jobId) {
          tasks.push(this.parseDelegatedTask(f, data, content));
        }
      } catch {
        // Skip
      }
    }
  }

  return tasks;
};

// ─── Relay Health ──────────────────────────────────────────────────

VaultClient.prototype.getRelayHealthAll = async function () {
  const files = this.listMdFiles("_delegation/relay-health");
  const relays: RelayHealth[] = [];

  for (const f of files) {
    try {
      const { data } = this.readMdFile(f);
      relays.push({
        relayId: data.relayId ?? "",
        harnessType: data.harnessType ?? "",
        displayName: data.displayName ?? "",
        status: data.status ?? "offline",
        lastHeartbeat: data.lastHeartbeat ?? null,
        tasksCompleted: data.tasksCompleted ?? 0,
        tasksFailed: data.tasksFailed ?? 0,
        avgResponseTimeMs: data.avgResponseTimeMs ?? 0,
        capabilities: data.capabilities ?? [],
        discordChannelId: data.discordChannelId ?? null,
        _filePath: f,
      });
    } catch {
      // Skip
    }
  }

  return relays;
};

VaultClient.prototype.upsertRelayHealth = async function (relayId, data) {
  const safeId = relayId.replace(/[/\\:*?"<>|]/g, "-");
  const filePath = this.resolve("_delegation/relay-health", `${safeId}.md`);

  if (fs.existsSync(filePath)) {
    this.updateFrontmatter(filePath, {
      ...data,
      lastHeartbeat: data.lastHeartbeat ?? this.nowISO(),
    });
  } else {
    this.writeMdFile(
      filePath,
      {
        relayId,
        harnessType: data.harnessType ?? "unknown",
        displayName: data.displayName ?? relayId,
        status: data.status ?? "offline",
        lastHeartbeat: this.nowISO(),
        tasksCompleted: data.tasksCompleted ?? 0,
        tasksFailed: data.tasksFailed ?? 0,
        avgResponseTimeMs: data.avgResponseTimeMs ?? 0,
        capabilities: data.capabilities ?? [],
        discordChannelId: data.discordChannelId ?? null,
      },
      `# Relay: ${data.displayName ?? relayId}`,
    );
  }
};

// ─── Live Task Output ──────────────────────────────────────────────

VaultClient.prototype.writeLiveChunk = function (taskId, claimedBy, chunk) {
  const MAX_BODY = 50_000;
  const TRIM_TO = 50_000;
  const now = this.nowISO();
  const filePath = this.resolve("_delegation/live", `live-${taskId}.md`);

  if (!fs.existsSync(filePath)) {
    this.writeMdFile(
      filePath,
      { taskId, claimedBy, startedAt: now, lastChunkAt: now, byteCount: chunk.length },
      chunk,
    );
  } else {
    try {
      const { data, content } = this.readMdFile(filePath);
      let newBody = content + chunk;
      if (newBody.length > MAX_BODY + 1024) {
        newBody = newBody.slice(newBody.length - TRIM_TO);
      }
      data.lastChunkAt = now;
      data.byteCount = (data.byteCount ?? 0) + chunk.length;
      this.writeMdFile(filePath, data, newBody);
    } catch {
      this.writeMdFile(
        filePath,
        { taskId, claimedBy, startedAt: now, lastChunkAt: now, byteCount: chunk.length },
        chunk,
      );
    }
  }
};

VaultClient.prototype.readLiveOutput = function (taskId) {
  const filePath = this.resolve("_delegation/live", `live-${taskId}.md`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const { data, content } = this.readMdFile(filePath);
    return {
      taskId: data.taskId ?? taskId,
      claimedBy: data.claimedBy ?? "",
      startedAt: data.startedAt ?? "",
      lastChunkAt: data.lastChunkAt ?? "",
      byteCount: data.byteCount ?? 0,
      output: content,
      _filePath: filePath,
    };
  } catch {
    return null;
  }
};

VaultClient.prototype.deleteLiveOutput = function (taskId) {
  const filePath = this.resolve("_delegation/live", `live-${taskId}.md`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Non-fatal
  }
};

VaultClient.prototype.listLiveTasks = function () {
  const files = this.listMdFiles("_delegation/live");
  const results: LiveTaskOutput[] = [];
  for (const f of files) {
    try {
      const { data, content } = this.readMdFile(f);
      const taskId = data.taskId ?? path.basename(f, ".md").replace("live-", "");
      results.push({
        taskId,
        claimedBy: data.claimedBy ?? "",
        startedAt: data.startedAt ?? "",
        lastChunkAt: data.lastChunkAt ?? "",
        byteCount: data.byteCount ?? 0,
        output: content,
        _filePath: f,
      });
    } catch {
      // Skip malformed files
    }
  }
  return results.sort(
    (a, b) => new Date(b.lastChunkAt).getTime() - new Date(a.lastChunkAt).getTime(),
  );
};
