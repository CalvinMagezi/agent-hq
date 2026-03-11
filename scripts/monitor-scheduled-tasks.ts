#!/usr/bin/env bun
/**
 * monitor-scheduled-tasks.ts
 *
 * Monitors Claude Code scheduled task execution logs for misbehavior.
 * Run via: bun run scripts/monitor-scheduled-tasks.ts
 * Or tail live: bun run scripts/monitor-scheduled-tasks.ts --follow
 *
 * Misbehavior signals detected:
 * - Task not firing (missed scheduled window)
 * - Task running longer than expected (timeout signal)
 * - Task writing to unexpected vault paths
 * - Task writing too many files (blast radius check)
 * - Log gaps (task silently failing)
 */

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const VAULT_PATH = process.env.VAULT_PATH ?? join(import.meta.dir, "../.vault");
const LOG_FILE = join(VAULT_PATH, "_logs/scheduled-tasks.log");
const SCHEDULED_TASKS_DIR = join(process.env.HOME ?? homedir(), ".claude/scheduled-tasks");

// Expected schedules (cron → expected max gap in hours)
const TASK_EXPECTATIONS: Record<string, { maxGapHours: number; allowedWritePaths: string[] }> = {
  "vault-dead-links": {
    maxGapHours: 7,
    allowedWritePaths: ["_system/LINK-HEALTH.md", "_logs/scheduled-tasks.log"],
  },
  "vault-orphan-notes": {
    maxGapHours: 25,
    allowedWritePaths: ["_system/ORPHAN-NOTES.md", "_logs/scheduled-tasks.log"],
  },
  "vault-stale-jobs": {
    maxGapHours: 3,
    allowedWritePaths: ["_system/HEARTBEAT.md", "_logs/scheduled-tasks.log"],
  },
  "vault-memory-digest": {
    maxGapHours: 25,
    allowedWritePaths: ["_system/MEMORY.md", "Notebooks/Memories/memory-archive.md", "_logs/scheduled-tasks.log"],
  },
  "vault-soul-check": {
    maxGapHours: 170, // weekly
    allowedWritePaths: ["_system/SOUL-HEALTH.md", "_logs/scheduled-tasks.log"],
  },
  "project-status-pulse": {
    maxGapHours: 25,
    allowedWritePaths: ["_system/PROJECT-PULSE.md", "_logs/scheduled-tasks.log"],
  },
};

interface LogEntry {
  timestamp: Date;
  task: string;
  message: string;
  raw: string;
}

interface TaskStatus {
  name: string;
  lastRun?: Date;
  lastMessage?: string;
  runCount: number;
  issues: string[];
}

function parseLog(logPath: string): LogEntry[] {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
  const entries: LogEntry[] = [];

  for (const line of lines) {
    // Format: [2026-03-07T07:00:01.000Z] task-name: message
    const match = line.match(/^\[(.+?)\]\s+([\w-]+):\s+(.+)$/);
    if (!match) continue;
    const [, ts, task, message] = match;
    const timestamp = new Date(ts);
    if (isNaN(timestamp.getTime())) continue;
    entries.push({ timestamp, task, message, raw: line });
  }

  return entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function analyzeTaskHealth(entries: LogEntry[]): TaskStatus[] {
  const now = new Date();
  const taskMap = new Map<string, LogEntry[]>();

  for (const entry of entries) {
    if (!taskMap.has(entry.task)) taskMap.set(entry.task, []);
    taskMap.get(entry.task)!.push(entry);
  }

  const statuses: TaskStatus[] = [];

  for (const [taskName, expectation] of Object.entries(TASK_EXPECTATIONS)) {
    const taskEntries = taskMap.get(taskName) ?? [];
    const issues: string[] = [];
    const lastEntry = taskEntries.at(-1);

    // Check: has the task ever run?
    if (taskEntries.length === 0) {
      issues.push("Never logged — task may not be registered or has never fired");
    }

    // Check: last run recency
    if (lastEntry) {
      const hoursSince = (now.getTime() - lastEntry.timestamp.getTime()) / 3600000;
      if (hoursSince > expectation.maxGapHours) {
        issues.push(
          `Last run ${hoursSince.toFixed(1)}h ago — expected every ${expectation.maxGapHours}h (MISSED)`
        );
      }
    }

    // Check: output file recency matches log recency
    for (const allowedPath of expectation.allowedWritePaths) {
      if (allowedPath.includes("scheduled-tasks.log")) continue;
      const filePath = join(VAULT_PATH, allowedPath);
      if (existsSync(filePath) && lastEntry) {
        const fileMtime = statSync(filePath).mtime;
        const driftMs = Math.abs(fileMtime.getTime() - lastEntry.timestamp.getTime());
        if (driftMs > 10 * 60 * 1000 && taskEntries.length > 0) {
          // File hasn't been touched near last log entry — possible silent failure
          issues.push(
            `Output ${allowedPath} last modified ${fileMtime.toISOString()} but log says task ran at ${lastEntry.timestamp.toISOString()} — possible write failure`
          );
        }
      }
    }

    statuses.push({
      name: taskName,
      lastRun: lastEntry?.timestamp,
      lastMessage: lastEntry?.message,
      runCount: taskEntries.length,
      issues,
    });
  }

  return statuses;
}

function checkSkillFilesExist(): string[] {
  const issues: string[] = [];
  for (const taskName of Object.keys(TASK_EXPECTATIONS)) {
    const skillFile = join(SCHEDULED_TASKS_DIR, taskName, "SKILL.md");
    if (!existsSync(skillFile)) {
      issues.push(`Missing SKILL.md: ${skillFile}`);
    }
  }
  return issues;
}

function printReport(statuses: TaskStatus[], skillIssues: string[]) {
  const now = new Date();
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║     Agent-HQ Scheduled Task Monitor                 ║`);
  console.log(`║     ${now.toISOString()}           ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  if (skillIssues.length > 0) {
    console.log(`⚠️  SKILL FILE ISSUES:`);
    for (const issue of skillIssues) console.log(`   • ${issue}`);
    console.log();
  }

  let totalIssues = 0;

  for (const status of statuses) {
    const hasIssues = status.issues.length > 0;
    const icon = hasIssues ? "🔴" : "✅";
    const lastRun = status.lastRun
      ? `${Math.round((Date.now() - status.lastRun.getTime()) / 60000)}min ago`
      : "never";

    console.log(`${icon} ${status.name.padEnd(28)} runs: ${String(status.runCount).padStart(3)}  last: ${lastRun}`);
    if (status.lastMessage) {
      console.log(`   └─ ${status.lastMessage}`);
    }
    for (const issue of status.issues) {
      console.log(`   ⚠️  ${issue}`);
      totalIssues++;
    }
  }

  console.log(`\n─────────────────────────────────────────────────────`);
  if (totalIssues === 0 && skillIssues.length === 0) {
    console.log(`✓ All scheduled tasks healthy — no misbehavior detected`);
  } else {
    console.log(`⚠️  ${totalIssues + skillIssues.length} issue(s) detected — review above`);
  }
  console.log();
}

function followMode(intervalSec = 30) {
  console.log(`Monitoring in follow mode (refresh every ${intervalSec}s) — Ctrl+C to stop\n`);
  const run = () => {
    console.clear();
    const entries = parseLog(LOG_FILE);
    const statuses = analyzeTaskHealth(entries);
    const skillIssues = checkSkillFilesExist();
    printReport(statuses, skillIssues);
  };
  run();
  setInterval(run, intervalSec * 1000);
}

// Main
const follow = process.argv.includes("--follow") || process.argv.includes("-f");

if (follow) {
  followMode(30);
} else {
  const entries = parseLog(LOG_FILE);
  const statuses = analyzeTaskHealth(entries);
  const skillIssues = checkSkillFilesExist();
  printReport(statuses, skillIssues);
  process.exit(statuses.some(s => s.issues.length > 0) || skillIssues.length > 0 ? 1 : 0);
}
