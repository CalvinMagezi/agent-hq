/**
 * Budget Allocator — distributes tokens across layers with surplus cascading.
 *
 * Process:
 * 1. Compute initial allocation per layer (profile fraction × total budget)
 * 2. Layers are filled in priority order (system → userMessage → memory → thread → injections)
 * 3. If a layer uses fewer tokens than allocated, the surplus cascades to remaining layers
 * 4. The response reserve is never reduced
 */

import type { ContextLayer, TokenBudget, LayerBudget, BudgetProfile } from "../types.js";

/** Layer fill order — higher priority layers get first access to surplus */
const FILL_ORDER: ContextLayer[] = [
  "responseReserve",
  "system",
  "userMessage",
  "memory",
  "thread",
  "injections",
];

export interface AllocationResult {
  layers: Record<ContextLayer, number>;
  totalAvailable: number;
}

/**
 * Compute initial token allocations from a profile and total budget.
 */
export function computeAllocations(
  totalTokens: number,
  profile: BudgetProfile
): AllocationResult {
  return {
    totalAvailable: totalTokens,
    layers: {
      responseReserve: Math.floor(totalTokens * profile.responseReserve),
      system: Math.floor(totalTokens * profile.system),
      userMessage: Math.floor(totalTokens * profile.userMessage),
      memory: Math.floor(totalTokens * profile.memory),
      thread: Math.floor(totalTokens * profile.thread),
      injections: Math.floor(totalTokens * profile.injections),
    },
  };
}

/**
 * Apply surplus cascading after layers have been filled.
 *
 * Takes the initial allocations and actual usage per layer,
 * redistributes unused tokens to layers that could use more.
 *
 * @param allocations - Initial allocations from computeAllocations
 * @param usage - Actual token usage per layer (from assembly)
 * @returns Updated allocations with surplus redistributed
 */
export function cascadeSurplus(
  allocations: AllocationResult,
  usage: Partial<Record<ContextLayer, number>>
): AllocationResult {
  const updated = { ...allocations, layers: { ...allocations.layers } };
  let surplus = 0;

  // Collect surplus from layers that underspent
  for (const layer of FILL_ORDER) {
    const allocated = updated.layers[layer];
    const used = usage[layer] ?? 0;

    if (used < allocated) {
      surplus += allocated - used;
      // Layer keeps only what it used
      updated.layers[layer] = used;
    }
  }

  // Distribute surplus to layers that need more (skip responseReserve and already-filled layers)
  const expandableLayers: ContextLayer[] = ["thread", "injections", "memory"];
  if (surplus > 0) {
    // Weight distribution towards thread and injections
    const weights: Record<string, number> = {
      thread: 0.5,
      injections: 0.35,
      memory: 0.15,
    };

    for (const layer of expandableLayers) {
      const used = usage[layer] ?? 0;
      const currentAlloc = updated.layers[layer];

      // Only expand if the layer was actually capped
      if (used >= currentAlloc * 0.9) {
        const bonus = Math.floor(surplus * (weights[layer] ?? 0));
        updated.layers[layer] += bonus;
      }
    }
  }

  return updated;
}

/**
 * Build a complete TokenBudget from allocations and actual usage.
 */
export function buildBudget(
  totalLimit: number,
  allocations: AllocationResult,
  usage: Record<ContextLayer, number>,
  compacted: Record<ContextLayer, boolean>
): TokenBudget {
  const layers: Record<ContextLayer, LayerBudget> = {} as any;
  let totalUsed = 0;

  for (const layer of FILL_ORDER) {
    const used = usage[layer] ?? 0;
    totalUsed += used;
    layers[layer] = {
      allocated: allocations.layers[layer],
      used,
      compacted: compacted[layer] ?? false,
    };
  }

  return {
    limit: totalLimit,
    layers,
    remaining: Math.max(0, totalLimit - totalUsed),
    compacted: Object.values(compacted).some(Boolean),
    totalUsed,
    utilizationPct: Math.round((totalUsed / totalLimit) * 100),
  };
}
