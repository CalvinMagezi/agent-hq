/**
 * Model Registry — Single source of truth for model capabilities.
 *
 * Resolution order: exact ID → alias → prefix match → default.
 * Specs can be overridden at runtime via vault file or programmatic merge.
 */

import * as fs from "fs";
import * as path from "path";
import type { ModelSpec, ModelRegistryConfig, CheckpointConfig } from "./types.js";
import { DEFAULT_SPECS } from "./defaults.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8_192;

const VAULT_REGISTRY_FILE = "_system/MODEL-REGISTRY.md";

export class ModelRegistry {
  private specs: Map<string, ModelSpec> = new Map();
  private aliasIndex: Map<string, string> = new Map(); // alias → canonical id
  private vaultPath?: string;

  constructor(config?: ModelRegistryConfig) {
    this.vaultPath = config?.vaultPath;

    // Load baseline defaults
    for (const spec of DEFAULT_SPECS) {
      this.addSpec(spec);
    }

    // Merge extra specs (for testing or custom models)
    if (config?.extraSpecs) {
      for (const spec of config.extraSpecs) {
        this.addSpec(spec);
      }
    }

    // Load vault overrides if path available
    if (this.vaultPath) {
      this.loadVaultOverrides();
    }
  }

  /** Get full spec for a model. Tries: exact → alias → prefix → default stub. */
  getSpec(modelId: string): ModelSpec {
    // Exact match
    const exact = this.specs.get(modelId);
    if (exact) return exact;

    // Alias match
    const aliasTarget = this.aliasIndex.get(modelId.toLowerCase());
    if (aliasTarget) {
      const aliased = this.specs.get(aliasTarget);
      if (aliased) return aliased;
    }

    // Prefix match — try progressively shorter prefixes (check specs then aliases)
    const parts = modelId.split(/[-/]/);
    for (let i = parts.length; i > 0; i--) {
      // Try dash-joined prefix
      const dashPrefix = parts.slice(0, i).join("-");
      const dashMatch = this.specs.get(dashPrefix);
      if (dashMatch) return dashMatch;
      // Also check alias index
      const dashAlias = this.aliasIndex.get(dashPrefix.toLowerCase());
      if (dashAlias) {
        const aliased = this.specs.get(dashAlias);
        if (aliased) return aliased;
      }

      // Try slash-joined prefix (OpenRouter paths like "google/gemini-2.5-flash")
      const slashPrefix = parts.slice(0, i).join("/");
      const slashMatch = this.specs.get(slashPrefix);
      if (slashMatch) return slashMatch;
      const slashAlias = this.aliasIndex.get(slashPrefix.toLowerCase());
      if (slashAlias) {
        const aliased = this.specs.get(slashAlias);
        if (aliased) return aliased;
      }
    }

    // Default stub — unknown model gets conservative defaults
    return {
      id: modelId,
      provider: "other",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_MAX_OUTPUT,
      tier: "standard",
    };
  }

  /** Get context window size for a model. */
  getContextWindow(modelId: string): number {
    return this.getSpec(modelId).contextWindow;
  }

  /** Check if model has >500K context window. */
  isLargeContext(modelId: string): boolean {
    return this.getContextWindow(modelId) > 500_000;
  }

  /** Get checkpoint config derived from model's context window size. */
  getCheckpointConfig(modelId: string): CheckpointConfig {
    const window = this.getContextWindow(modelId);
    if (window >= 2_000_000) {
      return { thresholdPct: 90, summaryTargetTokens: 1000, maxChainDepth: 10 };
    }
    if (window >= 500_000) {
      return { thresholdPct: 85, summaryTargetTokens: 800, maxChainDepth: 10 };
    }
    if (window >= 200_000) {
      return { thresholdPct: 75, summaryTargetTokens: 500, maxChainDepth: 5 };
    }
    return { thresholdPct: 70, summaryTargetTokens: 300, maxChainDepth: 3 };
  }

  /** Get all known model specs. */
  listModels(): ModelSpec[] {
    return Array.from(this.specs.values());
  }

  /** Merge in updated specs (overwrites existing by ID). */
  updateSpecs(specs: ModelSpec[]): void {
    for (const spec of specs) {
      this.addSpec(spec);
    }
  }

  /**
   * Load overrides from vault file (_system/MODEL-REGISTRY.md).
   * File format: markdown table with columns: id, contextWindow, maxOutputTokens, tier, aliases
   */
  loadVaultOverrides(): void {
    if (!this.vaultPath) return;

    const filePath = path.join(this.vaultPath, VAULT_REGISTRY_FILE);
    if (!fs.existsSync(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const overrides = parseRegistryTable(content);
      for (const partial of overrides) {
        if (!partial.id) continue;
        const existing = this.specs.get(partial.id);
        if (existing) {
          // Merge override fields into existing spec
          this.addSpec({ ...existing, ...partial } as ModelSpec);
        } else if (
          partial.provider &&
          partial.contextWindow &&
          partial.maxOutputTokens &&
          partial.tier
        ) {
          // Only add as new if all required fields are present
          this.addSpec(partial as ModelSpec);
        }
      }
    } catch {
      // Non-critical — vault file may be malformed or missing
    }
  }

  // ─── Private ──────────────────────────────────────────────────

  private addSpec(spec: ModelSpec): void {
    this.specs.set(spec.id, spec);

    // Index aliases
    if (spec.aliases) {
      for (const alias of spec.aliases) {
        this.aliasIndex.set(alias.toLowerCase(), spec.id);
      }
    }

    // Also index lowercase ID as alias
    this.aliasIndex.set(spec.id.toLowerCase(), spec.id);
  }
}

// ─── Vault File Parser ────────────────────────────────────────

/**
 * Parse a markdown table from MODEL-REGISTRY.md into ModelSpec overrides.
 *
 * Expected columns: id | contextWindow | maxOutputTokens | tier | aliases
 * Rows after the header separator (---|---|---|---|---) are parsed.
 */
function parseRegistryTable(content: string): Partial<ModelSpec>[] {
  const lines = content.split("\n");
  const results: Partial<ModelSpec>[] = [];

  let headerFound = false;
  let columnOrder: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    const cells = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    // Detect header row
    if (!headerFound && cells.some((c) => c.toLowerCase() === "id")) {
      columnOrder = cells.map((c) => c.toLowerCase());
      headerFound = true;
      continue;
    }

    // Skip separator row (---|---|---...)
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;

    // Skip rows before header
    if (!headerFound) continue;

    // Parse data row
    const spec: Record<string, any> = {};
    for (let i = 0; i < cells.length && i < columnOrder.length; i++) {
      const col = columnOrder[i];
      const val = cells[i];

      switch (col) {
        case "id":
          spec.id = val;
          break;
        case "contextwindow":
          spec.contextWindow = parseInt(val, 10) || undefined;
          break;
        case "maxoutputtokens":
          spec.maxOutputTokens = parseInt(val, 10) || undefined;
          break;
        case "tier":
          if (["flash", "standard", "pro"].includes(val)) {
            spec.tier = val;
          }
          break;
        case "aliases":
          spec.aliases = val
            .split(",")
            .map((a: string) => a.trim())
            .filter((a: string) => a.length > 0);
          break;
        case "provider":
          spec.provider = val;
          break;
        case "inputcostper1m":
          spec.inputCostPer1M = parseFloat(val) || undefined;
          break;
        case "outputcostper1m":
          spec.outputCostPer1M = parseFloat(val) || undefined;
          break;
      }
    }

    if (spec.id) {
      // Merge with existing spec if present (override only provided fields)
      results.push(spec as Partial<ModelSpec>);
    }
  }

  // Convert partial overrides to full specs by merging with defaults
  return results.map((partial) => {
    const existing = DEFAULT_SPECS.find((s) => s.id === partial.id);
    if (existing) {
      return {
        ...existing,
        ...Object.fromEntries(
          Object.entries(partial).filter(([, v]) => v !== undefined)
        ),
      } as ModelSpec;
    }
    // New model — fill in defaults for missing fields
    return {
      provider: "other" as const,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_MAX_OUTPUT,
      tier: "standard" as const,
      ...Object.fromEntries(
        Object.entries(partial).filter(([, v]) => v !== undefined)
      ),
    } as ModelSpec;
  });
}

// ─── Singleton for backward compatibility ─────────────────────

let _defaultRegistry: ModelRegistry | undefined;

/** Get or create a default ModelRegistry instance (no vault overrides). */
export function getDefaultRegistry(): ModelRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new ModelRegistry();
  }
  return _defaultRegistry;
}

/** Reset the default registry (for testing). */
export function resetDefaultRegistry(): void {
  _defaultRegistry = undefined;
}
