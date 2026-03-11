/**
 * CapabilityResolver — fallback harness routing for Agent-HQ.
 *
 * When an agent's preferredHarness is offline, walks the agent's fallbackChain
 * to find the next available harness. Inspired by Paperclip's hierarchical
 * org chart + capability fallback (dapper-snacking-snowflake).
 *
 * Usage:
 *   const resolved = resolveCapability("feature-coder", ["opencode", "gemini-cli"]);
 *   // → "opencode" (claude-code offline, opencode available)
 */

import { parseAgentFile, listAgentNames, AGENTS_DIR } from "./agentLoader.js";
import type { HarnessType } from "./types/agentDefinition.js";

export interface CapabilityResolution {
  /** Resolved harness to use */
  harness: HarnessType;
  /** Whether this is a fallback (preferred was unavailable) */
  isFallback: boolean;
  /** The preferred harness that was skipped (if isFallback) */
  preferredHarness?: HarnessType;
  /** Index in fallback chain (0 = preferred, 1+ = fallbacks) */
  fallbackDepth: number;
}

/**
 * Returns the full ordered capability chain for an agent:
 * [preferredHarness, ...fallbackChain]
 * Returns empty array if agent not found.
 */
export function getCapabilityChain(agentName: string): HarnessType[] {
  // Search across all verticals for the agent
  const agents = listAgentNames();
  for (const { vertical, name } of agents) {
    if (name === agentName) {
      const agent = parseAgentFile(vertical, name);
      if (!agent) continue;

      const chain: HarnessType[] = [agent.preferredHarness];
      if (agent.fallbackChain && agent.fallbackChain.length > 0) {
        chain.push(...agent.fallbackChain);
      }
      return chain;
    }
  }
  return [];
}

/**
 * Resolve which harness to use for a given agent, given a set of available harnesses.
 *
 * @param agentName    - kebab-case agent name (e.g. "feature-coder")
 * @param availableHarnesses - harnesses that are currently online/healthy
 * @returns CapabilityResolution with the resolved harness, or null if none available
 */
export function resolveCapability(
  agentName: string,
  availableHarnesses: string[],
): CapabilityResolution | null {
  const chain = getCapabilityChain(agentName);

  if (chain.length === 0) {
    // Unknown agent — check if "any" is available as a last resort
    if (availableHarnesses.length > 0) {
      return {
        harness: availableHarnesses[0] as HarnessType,
        isFallback: true,
        fallbackDepth: 0,
      };
    }
    return null;
  }

  const available = new Set(availableHarnesses);

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];

    // "any" matches the first available harness
    if (candidate === "any") {
      const firstAvailable = availableHarnesses[0] as HarnessType | undefined;
      if (firstAvailable) {
        return {
          harness: firstAvailable,
          isFallback: i > 0,
          preferredHarness: i > 0 ? chain[0] : undefined,
          fallbackDepth: i,
        };
      }
      continue;
    }

    if (available.has(candidate)) {
      return {
        harness: candidate,
        isFallback: i > 0,
        preferredHarness: i > 0 ? chain[0] : undefined,
        fallbackDepth: i,
      };
    }
  }

  // Nothing available
  return null;
}

/**
 * Quick check: is the preferred harness available, or do we need to fall back?
 */
export function needsFallback(agentName: string, availableHarnesses: string[]): boolean {
  const chain = getCapabilityChain(agentName);
  if (chain.length === 0) return false;
  const preferred = chain[0];
  return !availableHarnesses.includes(preferred);
}
