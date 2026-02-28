/**
 * CFO Router — consults the CFO agent for cost estimates and records actual usage.
 *
 * The CFO is a standalone subprocess that runs alongside the COO. This module
 * provides the agent-side helpers to interact with it via vault inbox/outbox.
 *
 * CFO consultation is non-blocking: if the CFO is offline or slow, the agent
 * proceeds without a cost estimate (degraded gracefully).
 */

import type { VaultClient } from "@repo/vault-client";
import type { CfoEstimate } from "@repo/vault-client";

/** Max ms to wait for a CFO estimate before giving up */
const CFO_TIMEOUT_MS = 3_000;
const CFO_POLL_INTERVAL_MS = 300;

/** Threshold above which the user should be warned about cost */
const WARN_THRESHOLD_USD = 0.10;

/**
 * Ask the CFO to estimate the cost of a described task.
 * Returns an estimate or null if CFO is unavailable.
 */
export async function consultCfo(
  vault: VaultClient,
  taskDescription: string,
  models: string[] = [],
): Promise<CfoEstimate | null> {
  let intentId: string;
  try {
    intentId = await vault.sendToCfo({
      jobId: "",
      instruction: taskDescription,
      priority: 10,
      intentType: "estimate",
      metadata: { taskDescription, models },
    });
  } catch {
    return null; // CFO unavailable — proceed without estimate
  }

  const deadline = Date.now() + CFO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await vault.getCfoResponse(intentId);
      if (response !== null && typeof response === "object") {
        return response as CfoEstimate;
      }
    } catch {
      // Ignore read errors — CFO may not have responded yet
    }
    await new Promise((r) => setTimeout(r, CFO_POLL_INTERVAL_MS));
  }

  return null; // Timeout — proceed without estimate
}

/**
 * Returns true if the estimate is large enough to warrant showing the user a warning.
 */
export function shouldWarnUser(estimate: CfoEstimate): boolean {
  return estimate.estimatedCostUsd >= WARN_THRESHOLD_USD || !!estimate.warning;
}

/**
 * Format a cost estimate into a short human-readable prefix for Discord/chat responses.
 * Example: "⚠️ Est. cost: ~$0.12 | "
 */
export function formatEstimate(estimate: CfoEstimate): string {
  const cost = estimate.estimatedCostUsd;
  const costStr = cost < 0.001 ? "<$0.001" : `~$${cost.toFixed(4)}`;
  const prefix = estimate.warning ? "⚠️ " : "💰 ";
  return `${prefix}Est. cost: ${costStr} | `;
}

/**
 * Record actual token usage for a completed task.
 * Non-throwing — errors are silently swallowed so they never block task completion.
 */
export async function recordTaskUsage(
  vault: VaultClient,
  taskId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const pricing = vault.getPricingCache();
  const prices = pricing[model] ?? { inputPer1k: 0, outputPer1k: 0 };
  const costUsd =
    (inputTokens / 1000) * prices.inputPer1k +
    (outputTokens / 1000) * prices.outputPer1k;

  try {
    await vault.recordUsage({
      taskId,
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd: costUsd,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Never block task completion on usage recording failures
  }
}
