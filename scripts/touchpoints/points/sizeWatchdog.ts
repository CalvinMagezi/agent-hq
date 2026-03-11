/**
 * Size Watchdog — Touch Point
 *
 * Alerts when files grow past size thresholds. Pure filesystem, no LLM.
 * Runs 60s after a modification (debounced to avoid spam during continuous editing).
 *
 * Thresholds:
 *   - 10KB   (~2K words)  → Warning
 *   - 25KB   (~5K words)  → Alert
 *   - 50KB   (~10K words) → Critical
 *
 * Special case: MEMORY.md checks line count against 200-line limit.
 * Dedup: one notification per threshold per file per day.
 */

import * as fs from "fs";
import * as path from "path";
import type { TouchPoint, TouchPointResult } from "../types.js";

const DEBOUNCE_MS = 60_000; // 60 seconds

interface Threshold {
  label: string;
  level: "warning" | "alert" | "critical";
  bytes: number;
}

const SIZE_THRESHOLDS: Threshold[] = [
  { label: "Critical", level: "critical", bytes: 50 * 1024 },
  { label: "Alert", level: "alert", bytes: 25 * 1024 },
  { label: "Warning", level: "warning", bytes: 10 * 1024 },
];

const MEMORY_LINE_LIMIT = 200;

// In-process dedup: track which threshold+file+day combinations have fired
const firedKeys = new Set<string>();

function dedupKey(filePath: string, threshold: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `size-watchdog:${filePath}:${threshold}:${today}`;
}

export const sizeWatchdog: TouchPoint = {
  name: "size-watchdog",
  description: "Alert when files in Notebooks/ or _system/ exceed size thresholds",
  triggers: ["note:modified", "file:modified"],
  pathFilter: undefined,  // handled manually below for multi-prefix
  debounceMs: DEBOUNCE_MS,

  async evaluate(event, ctx) {
    const filePath = event.path;

    // Only watch Notebooks/ and _system/ directories
    if (!filePath.startsWith("Notebooks/") && !filePath.startsWith("_system/")) {
      return null;
    }

    const fullPath = path.join(ctx.vaultPath, filePath);
    if (!fs.existsSync(fullPath)) return null;

    // Special case: MEMORY.md — watch line count
    if (filePath.endsWith("MEMORY.md")) {
      return await checkMemoryLines(fullPath, filePath, ctx.dryRun);
    }

    // General size check for .md files
    if (!filePath.endsWith(".md")) return null;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      return null;
    }

    const sizeBytes = stat.size;

    // Find highest-level threshold exceeded
    for (const threshold of SIZE_THRESHOLDS) {
      if (sizeBytes >= threshold.bytes) {
        const key = dedupKey(filePath, threshold.label);
        if (firedKeys.has(key)) return null;

        firedKeys.add(key);
        const sizeKB = (sizeBytes / 1024).toFixed(1);
        const filename = path.basename(filePath);
        const emoji = threshold.level === "critical" ? "🚨" : threshold.level === "alert" ? "⚠️" : "📏";
        const observation = `${threshold.label}: ${filename} is ${sizeKB}KB (limit: ${threshold.bytes / 1024}KB)`;

        if (ctx.dryRun) {
          return { observation, actions: [], meaningful: false };
        }

        return {
          observation,
          actions: [`${threshold.label.toUpperCase()}: ${sizeKB}KB`],
          meaningful: true,  // this one should always notify
          emit: [],
        };
      }
    }

    return null;
  },
};

async function checkMemoryLines(
  fullPath: string,
  filePath: string,
  dryRun: boolean
): Promise<TouchPointResult | null> {
  try {
    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n").length;

    if (lines <= MEMORY_LINE_LIMIT) return null;

    const key = dedupKey(filePath, "line-limit");
    if (firedKeys.has(key)) return null;

    firedKeys.add(key);
    const observation = `MEMORY.md has ${lines} lines (limit: ${MEMORY_LINE_LIMIT}) — consolidation may be needed`;

    if (dryRun) {
      return { observation, actions: [], meaningful: false };
    }

    return {
      observation,
      actions: [`ALERT: ${lines} lines (limit ${MEMORY_LINE_LIMIT})`],
      meaningful: true,
    };
  } catch {
    return null;
  }
}
