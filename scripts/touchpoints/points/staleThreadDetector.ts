/**
 * Stale Thread Detector — Periodic Touch Point
 *
 * Runs every 6 hours as a daemon task. Scans _threads/active/ for threads
 * that haven't been modified in >24 hours. If substantial (>5 turns),
 * triggers conversation-learner before archiving to _threads/archived/.
 * No LLM calls needed here — judgment is purely size-based.
 */

import * as fs from "fs";
import * as path from "path";
import type { TouchPoint } from "../types.js";

const STALE_AFTER_MS = 24 * 60 * 60_000;   // 24 hours
const MIN_TURNS_FOR_HARVEST = 5;

export const staleThreadDetector: TouchPoint = {
  name: "stale-thread-detector",
  description: "Archive stale threads (>24h idle) after harvesting learnings",
  triggers: [],  // periodic — no event triggers, called via engine.runPeriodic()
  debounceMs: 0,

  async evaluate(event, ctx) {
    const activeDir = path.join(ctx.vaultPath, "_threads", "active");
    if (!fs.existsSync(activeDir)) return null;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(activeDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const now = Date.now();
    const stale: string[] = [];
    const harvestTargets: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const fullPath = path.join(activeDir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const idleMs = now - stat.mtimeMs;
      if (idleMs < STALE_AFTER_MS) continue;

      stale.push(entry.name);

      // Check if substantial enough to harvest learnings from
      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        const turns = (raw.match(/^##?\s+(User|Calvin|Human|Assistant|Agent)/gim) ?? []).length;
        if (turns >= MIN_TURNS_FOR_HARVEST) {
          harvestTargets.push(entry.name);
        }
      } catch { /* skip */ }
    }

    if (stale.length === 0) return null;

    if (ctx.dryRun) {
      return {
        observation: `Would archive ${stale.length} stale thread(s), harvest ${harvestTargets.length}`,
        actions: [],
        meaningful: false,
      };
    }

    // Create archived dir if needed
    const archivedDir = path.join(ctx.vaultPath, "_threads", "archived");
    if (!fs.existsSync(archivedDir)) {
      try { fs.mkdirSync(archivedDir, { recursive: true }); } catch { return null; }
    }

    const archived: string[] = [];
    const emitToLearner: Array<{ touchPoint: string; data: Record<string, unknown> }> = [];

    for (const name of stale) {
      const sourcePath = path.join(activeDir, name);
      const destPath = path.join(archivedDir, name);

      // If it needs learning, emit to conversation-learner BEFORE archiving
      // (emit happens before the move via the chain system, but we also move here
      // since this is a periodic task, not an event-driven one)
      if (harvestTargets.includes(name)) {
        const relPath = `_threads/active/${name}`;
        emitToLearner.push({
          touchPoint: "conversation-learner",
          data: { filePath: relPath, triggeredBy: "stale-thread-detector" },
        });
      }

      try {
        // Archive with datestamp suffix
        const dateStr = new Date().toISOString().slice(0, 10);
        const archiveName = name.replace(".md", `-archived-${dateStr}.md`);
        fs.renameSync(sourcePath, path.join(archivedDir, archiveName));
        archived.push(name);
      } catch { /* skip this file */ }
    }

    return {
      observation: `Archived ${archived.length} stale thread(s), queued ${emitToLearner.length} for learning`,
      actions: archived.map(n => `ARCHIVED: ${n}`),
      meaningful: archived.length > 0,
      emit: emitToLearner,
    };
  },
};
