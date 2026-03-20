/**
 * Performance evaluator — aggregates reflection data into rolling metrics.
 *
 * Reads .vault/_system/Reflections/*.md to compute:
 * - Success rate (30-day rolling)
 * - Average tokens per task
 * - Average duration per task
 * - Top failure reasons
 * - Improvement trend
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

// ── Types ───────────────────────────────────────────────────────────

export interface PerformanceMetrics {
  /** Rolling success rate (0-1) */
  successRate: number;
  /** Average tokens per completed task */
  avgTokensPerTask: number;
  /** Average duration in seconds */
  avgDurationPerTask: number;
  /** Total tasks in window */
  totalTasks: number;
  /** Successful tasks in window */
  successfulTasks: number;
  /** Failed tasks in window */
  failedTasks: number;
  /** Most common failure patterns */
  topLessons: string[];
  /** Window start date */
  windowStart: string;
  /** Window end date */
  windowEnd: string;
}

// ── Compute Metrics ─────────────────────────────────────────────────

/**
 * Compute rolling performance metrics from reflection files.
 *
 * @param vaultPath Path to the vault root
 * @param windowDays Number of days to look back (default 30)
 */
export function computeMetrics(vaultPath: string, windowDays: number = 30): PerformanceMetrics {
  const reflDir = path.join(vaultPath, "_system", "Reflections");
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffStr = cutoff.toISOString();

  let totalTokens = 0;
  let totalDuration = 0;
  let successCount = 0;
  let failCount = 0;
  const allLessons: string[] = [];

  try {
    if (!fs.existsSync(reflDir)) {
      return emptyMetrics(windowDays);
    }

    const files = fs.readdirSync(reflDir).filter(f => f.endsWith(".md")).sort().reverse();

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(reflDir, file), "utf-8");
        const { data } = matter(content);

        // Skip entries outside the window
        if (data.timestamp && data.timestamp < cutoffStr) continue;

        if (data.outcome === "success") {
          successCount++;
        } else {
          failCount++;
        }

        if (typeof data.tokens === "number") totalTokens += data.tokens;

        // Parse duration like "45s"
        if (typeof data.duration === "string") {
          const secs = parseInt(data.duration.replace("s", ""), 10);
          if (!isNaN(secs)) totalDuration += secs;
        }

        // Collect lessons from the file body
        const lessonLines = content
          .split("\n")
          .filter(l => l.startsWith("- ") && !l.includes("Completed successfully"))
          .map(l => l.slice(2).trim());
        allLessons.push(...lessonLines);
      } catch {
        // Skip malformed reflection files
      }
    }
  } catch {
    return emptyMetrics(windowDays);
  }

  const total = successCount + failCount;
  const now = new Date();

  // Deduplicate and count lessons to find top ones
  const lessonCounts = new Map<string, number>();
  for (const lesson of allLessons) {
    const key = lesson.toLowerCase().slice(0, 60);
    lessonCounts.set(key, (lessonCounts.get(key) ?? 0) + 1);
  }
  const topLessons = [...lessonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key]) => {
      // Find the original (non-lowercased) version
      return allLessons.find(l => l.toLowerCase().startsWith(key.slice(0, 40))) ?? key;
    });

  return {
    successRate: total > 0 ? successCount / total : 0,
    avgTokensPerTask: total > 0 ? Math.round(totalTokens / total) : 0,
    avgDurationPerTask: total > 0 ? Math.round(totalDuration / total) : 0,
    totalTasks: total,
    successfulTasks: successCount,
    failedTasks: failCount,
    topLessons,
    windowStart: cutoff.toISOString().slice(0, 10),
    windowEnd: now.toISOString().slice(0, 10),
  };
}

/**
 * Format metrics as a readable summary string.
 */
export function formatMetrics(metrics: PerformanceMetrics): string {
  if (metrics.totalTasks === 0) {
    return "No task data available yet.";
  }

  const lines = [
    `**Performance (${metrics.windowStart} → ${metrics.windowEnd})**`,
    `- Tasks: ${metrics.totalTasks} (${metrics.successfulTasks} success, ${metrics.failedTasks} failed)`,
    `- Success rate: ${Math.round(metrics.successRate * 100)}%`,
    `- Avg tokens/task: ${metrics.avgTokensPerTask.toLocaleString()}`,
    `- Avg duration: ${metrics.avgDurationPerTask}s`,
  ];

  if (metrics.topLessons.length > 0) {
    lines.push(`- Top lessons:`);
    for (const lesson of metrics.topLessons) {
      lines.push(`  - ${lesson}`);
    }
  }

  return lines.join("\n");
}

function emptyMetrics(windowDays: number): PerformanceMetrics {
  const now = new Date();
  const start = new Date();
  start.setDate(start.getDate() - windowDays);
  return {
    successRate: 0,
    avgTokensPerTask: 0,
    avgDurationPerTask: 0,
    totalTasks: 0,
    successfulTasks: 0,
    failedTasks: 0,
    topLessons: [],
    windowStart: start.toISOString().slice(0, 10),
    windowEnd: now.toISOString().slice(0, 10),
  };
}
