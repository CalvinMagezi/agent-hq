/**
 * Pre-compaction memory management.
 *
 * Uses Pi SDK's session.getContextUsage() for exact token counts and
 * session.compact() for context-aware compaction with custom instructions.
 * Falls back to prompt-based memory flush if compact() is unavailable.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface MemoryFlushState {
  /** Turn index at which the last flush was executed */
  lastFlushTurn: number;
  /** Number of compaction cycles observed so far */
  compactionCount: number;
}

export interface MemoryFlushOptions {
  /** Percentage of context window to trigger flush (default: 80) */
  flushThresholdPercent: number;
  /** Minimum turns between flushes (default: 5) */
  minTurnsBetweenFlushes: number;
}

// ── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_FLUSH_OPTIONS: MemoryFlushOptions = {
  flushThresholdPercent: 80,
  minTurnsBetweenFlushes: 5,
};

const FALLBACK_FLUSH_PROMPT = `SYSTEM INSTRUCTION — PRE-COMPACTION MEMORY FLUSH

You are approaching the context window limit. Before older messages are pruned,
you MUST store durable memories using the 'local_context' tool with action='write'.

Include:
- Key insights and findings from this session
- Important user preferences or constraints
- Ongoing tasks, blockers, or next steps
- Critical decisions made and their reasoning

After writing memories, respond ONLY with: NO_REPLY`;

// ── Core Logic ──────────────────────────────────────────────────────

/**
 * Determines whether a memory flush should be triggered.
 * Uses Pi SDK's session.getContextUsage() for exact token counts.
 */
export function shouldFlushMemory(
  session: any,
  state: MemoryFlushState,
  options: MemoryFlushOptions = DEFAULT_FLUSH_OPTIONS,
): boolean {
  const usage = session.getContextUsage?.();
  if (!usage || usage.percent == null) return false;

  if (usage.percent < options.flushThresholdPercent) return false;

  const stats = session.getSessionStats?.();
  const currentTurn = stats?.totalMessages ?? 0;

  if (currentTurn < 10) return false;
  if (state.lastFlushTurn > 0 && currentTurn - state.lastFlushTurn < options.minTurnsBetweenFlushes) {
    return false;
  }

  return true;
}

/**
 * Builds context-aware compaction instructions based on job metadata.
 * These guide the LLM during compaction to preserve the most important information.
 */
export function buildCompactionInstructions(jobType: string, instruction: string): string {
  const base = `Preserve during compaction:
- All tool results (file contents, bash outputs, search results)
- User's original intent: ${instruction.substring(0, 200)}
- Key decisions and their reasoning
- Ongoing tasks, blockers, or next steps
- Critical facts discovered during execution

Drop during compaction:
- Redundant confirmations and acknowledgments
- Intermediate thought processes
- Duplicate error messages and retry logs`;

  if (jobType === "interactive") {
    return base + "\n- ALL user questions and your answers (conversation history is critical for interactive jobs)";
  }

  return base;
}

/**
 * Executes a smart compaction using Pi SDK's session.compact() with custom instructions.
 * Falls back to prompt-based memory flush if compact() is not available.
 *
 * @returns true if compaction/flush was executed
 */
export async function executeMemoryFlush(
  session: any,
  state: MemoryFlushState,
  onLog?: (message: string) => void,
  jobType?: string,
  instruction?: string,
): Promise<boolean> {
  const log = onLog ?? console.log;
  const usage = session.getContextUsage?.();
  log(`💾 Pre-compaction (${usage?.percent ?? "?"}% context used)...`);

  try {
    // Prefer Pi SDK's native compact() with custom instructions
    if (typeof session.compact === "function") {
      const instructions = buildCompactionInstructions(
        jobType || "background",
        instruction || "complete the assigned task"
      );
      await session.compact(instructions);
      state.compactionCount++;
      log(`✅ Smart compaction completed (cycle ${state.compactionCount})`);
    } else {
      // Fallback: inject a prompt to save context via local_context tool
      await session.prompt(FALLBACK_FLUSH_PROMPT);
      log("✅ Memory flush completed (fallback mode)");
    }

    const stats = session.getSessionStats?.();
    state.lastFlushTurn = stats?.totalMessages ?? state.lastFlushTurn + 1;
    return true;
  } catch (error: any) {
    log(`⚠️  Compaction failed (best-effort): ${error.message}`);
    return false;
  }
}

/**
 * Creates a fresh MemoryFlushState for a new job.
 */
export function createFlushState(): MemoryFlushState {
  return {
    lastFlushTurn: 0,
    compactionCount: 0,
  };
}
