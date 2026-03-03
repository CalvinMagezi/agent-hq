/**
 * HQ Tool Registry
 *
 * Inspired by Cloudflare's Code Mode MCP pattern:
 * - Tools are registered in a central registry
 * - Agents discover tools via hq_discover (search) rather than loading all at once
 * - Fixed ~1K token footprint regardless of how many tools are registered
 * - Validated input via TypeBox schemas before execution
 */

import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";

export interface HQContext {
  vaultPath: string;
  openrouterApiKey?: string;
  geminiApiKey?: string;
  /** Caller's security profile — gates write-access tools */
  securityProfile?: "minimal" | "standard" | "guarded" | "admin";
}

export interface HQToolSummary {
  name: string;
  description: string;
  tags: string[];
}

export interface HQTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  tags: string[];
  schema: TSchema;
  /** If true, requires standard/guarded/admin profile (not minimal) */
  requiresWriteAccess?: boolean;
  execute(input: I, ctx: HQContext): Promise<O>;
}

export class ToolRegistry {
  private tools = new Map<string, HQTool>();

  register(tool: HQTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Fuzzy search by keyword — returns tools whose name/description/tags
   * overlap with query words. Returns all tools if query is empty.
   */
  search(query: string): HQToolSummary[] {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    if (!words.length) {
      return this.list();
    }

    return [...this.tools.values()]
      .map((t) => {
        const haystack =
          `${t.name} ${t.description} ${t.tags.join(" ")}`.toLowerCase();
        const score = words.reduce(
          (s, w) => s + (haystack.includes(w) ? 1 : 0),
          0
        );
        return { tool: t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => ({
        name: x.tool.name,
        description: x.tool.description,
        tags: x.tool.tags,
      }));
  }

  /** Execute a tool by name with validated input */
  async execute(name: string, input: unknown, ctx: HQContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      const available = [...this.tools.keys()].join(", ");
      throw new Error(
        `Unknown HQ tool: "${name}". Available: ${available}. Use hq_discover to search.`
      );
    }

    if (tool.requiresWriteAccess) {
      const profile = ctx.securityProfile ?? "minimal";
      if (profile === "minimal") {
        throw new Error(
          `Tool "${name}" requires write access (standard profile or higher).`
        );
      }
    }

    if (!Value.Check(tool.schema, input)) {
      const errors = [...Value.Errors(tool.schema, input)];
      throw new Error(
        `Invalid input for tool "${name}": ${errors
          .map((e) => `${e.path}: ${e.message}`)
          .join(", ")}`
      );
    }

    return tool.execute(input as never, ctx);
  }

  list(): HQToolSummary[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      tags: t.tags,
    }));
  }
}
