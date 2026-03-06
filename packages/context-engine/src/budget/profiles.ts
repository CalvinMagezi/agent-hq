/**
 * Budget profiles — pre-configured allocations for common scenarios.
 *
 * Each profile allocates a fraction of the total context window to each layer.
 * Fractions MUST sum to 1.0.
 *
 * Maps directly to Agent HQ's execution modes (quick/standard/thorough)
 * plus a delegation mode for sub-agent context.
 */

import type { BudgetProfile, BudgetProfileName } from "../types.js";

export const PROFILES: Record<BudgetProfileName, BudgetProfile> = {
  /**
   * Quick — Prioritize fast response, minimal context.
   * Use for: short replies, simple questions, real-time chat.
   */
  quick: {
    responseReserve: 0.40,
    system: 0.08,
    userMessage: 0.12,
    memory: 0.05,
    thread: 0.20,
    injections: 0.15,
  },

  /**
   * Standard — Balanced allocation for typical conversations.
   * Use for: general chat, task execution, most interactions.
   */
  standard: {
    responseReserve: 0.30,
    system: 0.08,
    userMessage: 0.10,
    memory: 0.07,
    thread: 0.25,
    injections: 0.20,
  },

  /**
   * Thorough — Maximize context for complex, multi-step work.
   * Use for: code reviews, research, architecture discussions.
   */
  thorough: {
    responseReserve: 0.25,
    system: 0.06,
    userMessage: 0.08,
    memory: 0.06,
    thread: 0.30,
    injections: 0.25,
  },

  /**
   * Delegation — Focused context for sub-agent tasks.
   * Thread history is minimal (sub-agent doesn't need full conversation).
   * Injections are higher (task-specific context matters more).
   */
  delegation: {
    responseReserve: 0.35,
    system: 0.10,
    userMessage: 0.15,
    memory: 0.05,
    thread: 0.10,
    injections: 0.25,
  },
};

/**
 * Validate that a profile's fractions sum to 1.0 (within floating point tolerance).
 */
export function validateProfile(profile: BudgetProfile): boolean {
  const sum =
    profile.responseReserve +
    profile.system +
    profile.userMessage +
    profile.memory +
    profile.thread +
    profile.injections;

  return Math.abs(sum - 1.0) < 0.001;
}

/**
 * Merge a partial override into a base profile.
 * Re-normalizes to ensure sum = 1.0 after override.
 */
export function mergeProfile(
  base: BudgetProfile,
  overrides: Partial<BudgetProfile>
): BudgetProfile {
  const merged = { ...base, ...overrides };

  // Normalize
  const sum =
    merged.responseReserve +
    merged.system +
    merged.userMessage +
    merged.memory +
    merged.thread +
    merged.injections;

  if (Math.abs(sum - 1.0) > 0.001) {
    const scale = 1.0 / sum;
    merged.responseReserve *= scale;
    merged.system *= scale;
    merged.userMessage *= scale;
    merged.memory *= scale;
    merged.thread *= scale;
    merged.injections *= scale;
  }

  return merged;
}
