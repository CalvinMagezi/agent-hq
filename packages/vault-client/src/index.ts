/**
 * VaultClient — Local filesystem replacement for Convex backend.
 *
 * Reads/writes markdown files with YAML frontmatter in the Obsidian vault.
 * Job claiming uses atomic fs.renameSync for concurrency safety.
 *
 * Domain methods are split across files for maintainability:
 *   core.ts           — Constructor, helpers, locking, parsers
 *   vaultJobs.ts      — Job queue operations
 *   vaultNotes.ts     — Note CRUD
 *   vaultDelegation.ts — Delegation, relay health, live task output
 *   vaultSystem.ts    — Context, settings, threads, approvals
 *   vaultUsage.ts     — Usage tracking, recent activity
 */

// Side-effect imports — augment VaultClient.prototype with domain methods
import "./vaultJobs";
import "./vaultNotes";
import "./vaultDelegation";
import "./vaultSystem";
import "./vaultUsage";

// Re-export the fully augmented VaultClient
export { VaultClient } from "./core";

// Re-export types and utilities
export type {
  Job,
  Note,
  DelegatedTask,
  RelayHealth,
  SystemContext,
  SearchResult,
  RecentActivityEntry,
} from "./types";

export { calculateCost } from "./pricing";
export * from "./types";
export { SearchClient } from "./search";
export { TraceDB } from "./traceDb";
export { BudgetGuard } from "./budgetGuard";
export type { BudgetCheckResult } from "./budgetGuard";

// Provider abstraction
export {
  resolveEmbeddingProvider,
  resolveChatProvider,
  resolveVisionProvider,
  fetchEmbedding,
  isEmbeddingProviderAvailable,
  MODEL_DEFAULTS,
} from "./models";
export type {
  EmbeddingProviderConfig,
  EmbeddingProviderType,
  ChatProviderConfig,
  ChatProviderType,
} from "./models";
