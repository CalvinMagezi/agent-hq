/**
 * HQ Tool Gateway — the 2-tool interface exposed to all agents
 *
 * Inspired by Cloudflare's Code Mode MCP pattern:
 * - hq_discover: search the registry (fixed ~200 token footprint)
 * - hq_call: execute any tool by name (fixed ~300 token footprint)
 *
 * Adding 100 more tools to the registry costs ZERO additional context tokens.
 */

import { Type } from "@sinclair/typebox";
import type { ToolRegistry, HQContext } from "./registry.js";
import type { HQAgentTool } from "@repo/agent-core";

// Re-export the canonical tool type from agent-core for backward compat
export type { HQAgentTool };
/** @deprecated Use HQAgentTool from @repo/agent-core instead */
export type AgentToolShape<S = any> = HQAgentTool<S>;

const HQDiscoverSchema = Type.Object({
  query: Type.String({
    description:
      'Keywords to search for tools (e.g. "image generation", "web search", "file"). Pass empty string to list all tools.',
  }),
});

const HQCallSchema = Type.Object({
  tool: Type.String({
    description: "Exact tool name returned by hq_discover",
  }),
  input: Type.Record(Type.String(), Type.Any(), {
    description: "Input parameters for the tool (see tool description for schema)",
  }),
});

export function createHQGatewayTools(
  registry: ToolRegistry,
  ctx: HQContext
): [AgentToolShape<typeof HQDiscoverSchema>, AgentToolShape<typeof HQCallSchema>] {
  const discoverTool: AgentToolShape<typeof HQDiscoverSchema> = {
    name: "hq_discover",
    description:
      "Search the HQ tool registry by keyword. Returns matching tool names and descriptions. Use this before hq_call to find the right tool. The registry can contain many tools — this search keeps context costs fixed regardless of registry size.",
    parameters: HQDiscoverSchema,
    label: "HQ Discover",
    execute: async (_id, args) => {
      const results = registry.search(args.query);
      if (!results.length) {
        return {
          content: [
            {
              type: "text",
              text: `No tools found matching "${args.query}". Try broader keywords, or pass an empty string to list all tools.`,
            },
          ],
          details: {},
        };
      }
      const text = results
        .map((t) => `**${t.name}**: ${t.description}\n  tags: ${t.tags.join(", ")}`)
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { results } };
    },
  };

  const callTool: AgentToolShape<typeof HQCallSchema> = {
    name: "hq_call",
    description:
      "Execute an HQ tool by name with the given input. Use hq_discover first to find available tools and understand their expected inputs.",
    parameters: HQCallSchema,
    label: "HQ Call",
    execute: async (_id, args) => {
      try {
        const result = await registry.execute(args.tool, args.input, ctx);
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }], details: { result } };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `HQ tool error: ${error.message}` }],
          details: { error: error.message },
        };
      }
    },
  };

  return [discoverTool, callTool];
}
