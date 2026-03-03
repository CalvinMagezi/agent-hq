/**
 * @repo/hq-tools
 *
 * HQ Tool Registry — shared tool infrastructure for all Agent-HQ consumers.
 *
 * Pattern inspired by Cloudflare Code Mode MCP:
 * - Tools registered in a central registry
 * - Agents access everything via 2 gateway tools (hq_discover + hq_call)
 * - Fixed ~1K token footprint regardless of registry size
 *
 * Usage in the HQ agent:
 *   import { createDefaultRegistry, createHQGatewayTools } from "@repo/hq-tools";
 *   const registry = createDefaultRegistry(ctx);
 *   const [discoverTool, callTool] = createHQGatewayTools(registry, ctx);
 *   // Add to rawTools array in index.ts
 *
 * Adding a new tool:
 *   1. Create src/tools/myTool.ts implementing HQTool<Input, Output>
 *   2. Register it in createDefaultRegistry() below
 *   3. Zero changes needed in any consumer — it's discoverable immediately
 */

export { ToolRegistry } from "./registry.js";
export type { HQTool, HQContext, HQToolSummary } from "./registry.js";
export { createHQGatewayTools } from "./gateway.js";
export type { AgentToolShape } from "./gateway.js";

// Built-in tools
export { ImageGenTool } from "./tools/imageGen.js";
export {
  ListSkillsTool,
  LoadSkillTool,
  getAutoLoadedSkillContent,
  buildSkillsSummary,
  SKILLS_DIR,
} from "./tools/skills.js";

import { ToolRegistry, type HQContext } from "./registry.js";
import { ImageGenTool } from "./tools/imageGen.js";
import { ListSkillsTool, LoadSkillTool } from "./tools/skills.js";

/**
 * Create the default registry with all built-in HQ tools pre-registered.
 * Adding a new tool here makes it available to ALL agents via hq_discover/hq_call.
 */
export function createDefaultRegistry(_ctx?: HQContext): ToolRegistry {
  const registry = new ToolRegistry();
  // Skill discovery and loading (pdf, docx, xlsx, pptx, frontend-design, etc.)
  registry.register(ListSkillsTool);
  registry.register(LoadSkillTool);
  // Image generation via OpenRouter
  registry.register(ImageGenTool);
  // Future tools:
  // registry.register(WebSearchTool);
  // registry.register(VaultSearchTool);
  return registry;
}
