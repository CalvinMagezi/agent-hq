/**
 * Execution Modes — Smart scaling strategy per task complexity.
 *
 * Inspired by CodeBuff's FREE/BUILD_FAST/MAX mode system. Each mode
 * adjusts parallelism, context budget, model selection, timeouts,
 * and whether to show a draft plan before delegating.
 *
 * Usage:
 *   const mode = detectExecutionMode("Refactor the auth system and add tests");
 *   // → "thorough"
 *   const config = getModeConfig(mode);
 *   // → { maxParallelTasks: 5, delegationTimeoutMs: 3600000, ... }
 *
 *   // Or with explicit prefix:
 *   const { mode, cleanInstruction } = parseExplicitMode("[QUICK] Fix the typo");
 *   // → { mode: "quick", cleanInstruction: "Fix the typo" }
 */

// ── Types ────────────────────────────────────────────────────────────

export type ExecutionMode = "quick" | "standard" | "thorough";

export interface ExecutionModeConfig {
    mode: ExecutionMode;
    /** Max tasks that can run in parallel via delegation. */
    maxParallelTasks: number;
    /** Multiplier for context budget in prompt builder (0.5x – 2x). */
    contextBudgetMultiplier: number;
    /** Preferred model ID. Empty string = use default. */
    preferredModel: string;
    /** Max turns per delegated task. */
    maxTurnsPerTask: number;
    /** Delegation timeout in ms. */
    delegationTimeoutMs: number;
    /** Whether to present draft plan to user before delegating. */
    enableDraftPlan: boolean;
}

// ── Mode Configurations ──────────────────────────────────────────────

const MODE_CONFIGS: Record<ExecutionMode, ExecutionModeConfig> = {
    quick: {
        mode: "quick",
        maxParallelTasks: 1,
        contextBudgetMultiplier: 0.5,
        preferredModel: "gemini-2.5-flash",
        maxTurnsPerTask: 30,
        delegationTimeoutMs: 5 * 60 * 1000, // 5 min
        enableDraftPlan: false,
    },
    standard: {
        mode: "standard",
        maxParallelTasks: 3,
        contextBudgetMultiplier: 1.0,
        preferredModel: "", // Use default model
        maxTurnsPerTask: 100,
        delegationTimeoutMs: 30 * 60 * 1000, // 30 min
        enableDraftPlan: true,
    },
    thorough: {
        mode: "thorough",
        maxParallelTasks: 5,
        contextBudgetMultiplier: 2.0,
        preferredModel: "claude-opus-4-6",
        maxTurnsPerTask: 200,
        delegationTimeoutMs: 60 * 60 * 1000, // 60 min
        enableDraftPlan: true,
    },
};

// ── Detection Patterns ───────────────────────────────────────────────

/** Patterns that indicate a simple, quick task. */
const QUICK_PATTERNS =
    /\b(fix\s+typo|rename|update\s+version|change\s+color|add\s+comment|remove\s+unused|bump\s+version|quick\s+fix|one-liner|simple\s+change|small\s+fix|minor\s+update)\b/i;

/** Patterns that indicate a complex, thorough task. */
const THOROUGH_PATTERNS =
    /\b(refactor|architect|redesign|migrate|overhaul|comprehensive|thorough|full\s+rewrite|system-wide|end-to-end|multi-service|cross-cutting|complete\s+implementation|major\s+feature)\b/i;

/** Prefix patterns for explicit mode override. */
const EXPLICIT_MODE_REGEX = /^\[(QUICK|STANDARD|THOROUGH)\]\s*/i;

// ── Public API ───────────────────────────────────────────────────────

/** Get the full configuration for a given execution mode. */
export function getModeConfig(mode: ExecutionMode): ExecutionModeConfig {
    return MODE_CONFIGS[mode];
}

/** Get all mode configurations. */
export function getAllModeConfigs(): Record<ExecutionMode, ExecutionModeConfig> {
    return { ...MODE_CONFIGS };
}

/**
 * Auto-detect execution mode from instruction complexity.
 *
 * Heuristics:
 * - Quick: matches simple-task patterns, or very short instructions (<15 words)
 * - Thorough: matches complex-task patterns, or long instructions (>100 words),
 *   or contains multiple goals (multiple "and" conjunctions / bullet lists)
 * - Standard: everything else
 */
export function detectExecutionMode(instruction: string): ExecutionMode {
    // Check explicit prefix first
    const explicit = parseExplicitMode(instruction);
    if (explicit.mode) return explicit.mode;

    // Quick patterns
    if (QUICK_PATTERNS.test(instruction)) return "quick";

    // Thorough patterns
    if (THOROUGH_PATTERNS.test(instruction)) return "thorough";

    // Word count heuristics
    const wordCount = instruction.split(/\s+/).filter(Boolean).length;
    if (wordCount < 15) return "quick";
    if (wordCount > 100) return "thorough";

    // Multiple goals: "X and Y and Z" or bullet list
    const andCount = (instruction.match(/\band\b/gi) || []).length;
    const bulletCount = (instruction.match(/^[\s]*[-*•]\s/gm) || []).length;
    if (andCount >= 2 || bulletCount >= 3) return "thorough";

    return "standard";
}

/**
 * Parse an explicit mode prefix from the instruction.
 * Supported formats: [QUICK], [STANDARD], [THOROUGH]
 *
 * Returns { mode, cleanInstruction } where cleanInstruction has the prefix stripped.
 * If no prefix found, mode is null and cleanInstruction is the original.
 */
export function parseExplicitMode(instruction: string): {
    mode: ExecutionMode | null;
    cleanInstruction: string;
} {
    const match = instruction.match(EXPLICIT_MODE_REGEX);
    if (!match) return { mode: null, cleanInstruction: instruction };

    const modeStr = match[1].toLowerCase() as ExecutionMode;
    const cleanInstruction = instruction.slice(match[0].length).trim();
    return { mode: modeStr, cleanInstruction };
}
