/**
 * Model context window limits.
 *
 * Thin wrapper around ModelRegistry for backward compatibility.
 * All model specs are now managed by the unified registry in src/models/.
 */

import { getDefaultRegistry } from "../models/registry.js";

/**
 * Get the context window token limit for a model.
 * Delegates to ModelRegistry — supports exact match, alias, and prefix matching.
 */
export function getModelLimit(model: string): number {
  return getDefaultRegistry().getContextWindow(model);
}

/**
 * Check if a model has a large context window (>500K tokens).
 * Useful for deciding whether aggressive compaction is needed.
 */
export function isLargeContextModel(model: string): boolean {
  return getDefaultRegistry().isLargeContext(model);
}
