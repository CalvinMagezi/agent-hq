/**
 * VaultClient — Task queue methods (for team workflow engine).
 *
 * Minimal API: submit tasks, poll for completion, update status.
 * Backed by AtomicQueue (pure filesystem, no external binary).
 */

import * as fs from "fs";
import * as path from "path";
import { VaultClient } from "./core";
import type { TaskRecord, TaskStatus } from "./types";

declare module "./core" {
  interface VaultClient {
    submitTask(
      jobId: string,
      task: {
        taskId: string;
        instruction: string;
        targetHarnessType?: string;
      },
    ): Promise<void>;
    getTask(taskId: string): Promise<TaskRecord | null>;
    getTasksForJob(jobId: string): Promise<TaskRecord[]>;
    claimTask(taskId: string, workerId: string): Promise<boolean>;
    completeTask(taskId: string, result: string): Promise<void>;
    failTask(taskId: string, error: string): Promise<void>;
  }
}

VaultClient.prototype.submitTask = async function (jobId, task) {
  const filename = `${task.taskId}.md`;
  const content = `# Task Instruction\n\n${task.instruction}`;
  this.writeMdFile(
    path.join(this.vaultPath, "_tasks", "pending", filename),
    {
      taskId: task.taskId,
      jobId,
      status: "pending",
      targetHarnessType: task.targetHarnessType ?? "any",
      createdAt: this.nowISO(),
    },
    content,
  );
};

VaultClient.prototype.getTask = async function (taskId) {
  const filename = `${taskId}.md`;
  const item = this.taskQueue.find(filename);
  if (!item) return null;
  const { data, content } = this.readMdFile(item.path);
  return this.parseTaskRecord(item.path, data, content);
};

VaultClient.prototype.getTasksForJob = async function (jobId) {
  const tasks: TaskRecord[] = [];
  for (const stage of ["pending", "running", "completed", "failed"]) {
    const items = this.taskQueue.list(stage);
    for (const item of items) {
      try {
        const { data, content } = this.readMdFile(item.path);
        if (data.jobId === jobId) {
          tasks.push(this.parseTaskRecord(item.path, data, content));
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
  return tasks;
};

VaultClient.prototype.claimTask = async function (taskId, workerId) {
  const filename = `${taskId}.md`;
  const moved = this.taskQueue.transition(filename, "pending", "running");
  if (!moved) return false;
  const filePath = path.join(this.vaultPath, "_tasks", "running", filename);
  this.updateFrontmatter(filePath, { status: "running", claimedBy: workerId, claimedAt: this.nowISO() });
  return true;
};

VaultClient.prototype.completeTask = async function (taskId, result) {
  const filename = `${taskId}.md`;
  // Try transition from running first, then from pending (for direct completion)
  let moved = this.taskQueue.transition(filename, "running", "completed");
  if (!moved) moved = this.taskQueue.transition(filename, "pending", "completed");
  if (!moved) throw new Error(`Task not found: ${taskId}`);
  const filePath = path.join(this.vaultPath, "_tasks", "completed", filename);
  this.updateFrontmatter(filePath, { status: "completed", result, completedAt: this.nowISO() });
};

VaultClient.prototype.failTask = async function (taskId, error) {
  const filename = `${taskId}.md`;
  let moved = this.taskQueue.transition(filename, "running", "failed");
  if (!moved) moved = this.taskQueue.transition(filename, "pending", "failed");
  if (!moved) throw new Error(`Task not found: ${taskId}`);
  const filePath = path.join(this.vaultPath, "_tasks", "failed", filename);
  this.updateFrontmatter(filePath, { status: "failed", error, completedAt: this.nowISO() });
};
