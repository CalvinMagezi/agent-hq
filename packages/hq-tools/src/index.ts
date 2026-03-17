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
export { openPlanDB } from "./planDB.js";

// Built-in tools
export { ImageGenTool } from "./tools/imageGen.js";
export {
  ListSkillsTool,
  LoadSkillTool,
  getAutoLoadedSkillContent,
  buildSkillsSummary,
  SKILLS_DIR,
} from "./tools/skills.js";
export {
  DrawItRenderTool,
  DrawItExportTool,
  DrawItMapTool,
  DrawItFlowTool,
  DrawItAnalyzeTool,
  CreateDiagramTool,
} from "./tools/drawit.js";
export {
  VaultSearchTool,
  VaultReadTool,
  VaultContextTool,
  VaultListTool,
  VaultBatchReadTool,
  VaultWriteNoteTool,
  VaultCreateJobTool
} from "./tools/vault.js";

import { ToolRegistry, type HQContext } from "./registry.js";
import { ImageGenTool } from "./tools/imageGen.js";
import { ListSkillsTool, LoadSkillTool } from "./tools/skills.js";
import {
  DrawItRenderTool,
  DrawItExportTool,
  DrawItMapTool,
  DrawItFlowTool,
  DrawItAnalyzeTool,
  CreateDiagramTool,
} from "./tools/drawit.js";
import {
  GoogleWorkspaceSchemaTool,
  GoogleWorkspaceReadTool,
  GoogleWorkspaceWriteTool
} from "./tools/googleWorkspace.js";
import { SpeakTool } from "./tools/tts.js";
import {
  ListAgentsTool,
  LoadAgentTool,
  ListTeamsTool,
  RunTeamWorkflowTool,
} from "./tools/agents.js";
import {
  VaultSearchTool,
  VaultReadTool,
  VaultContextTool,
  VaultListTool,
  VaultBatchReadTool,
  VaultWriteNoteTool,
  VaultCreateJobTool
} from "./tools/vault.js";
import { BenchmarkModelTool } from "./tools/modelBenchmark.js";
import { browserTools } from "./tools/browser.js";
import {
  PlanCreateTool,
  PlanStatusTool,
  PlanAnswerTool,
  PlanSearchTool,
  PlanUpdateTool,
  CodemapQueryTool,
  CodemapUpdateTool,
  PlanAttachTool,
  PlanVisualizeTool,
  PlanGalleryTool,
  PlanPhaseUpdateTool,
} from "./tools/planning.js";

export {
  GoogleWorkspaceSchemaTool,
  GoogleWorkspaceReadTool,
  GoogleWorkspaceWriteTool
};
export { SpeakTool } from "./tools/tts.js";
export { BenchmarkModelTool } from "./tools/modelBenchmark.js";
export {
  ListAgentsTool,
  LoadAgentTool,
  ListTeamsTool,
  RunTeamWorkflowTool,
} from "./tools/agents.js";
export {
  parseAgentFile,
  listAgentNames,
  getAllAgents,
  buildAgentPromptSection,
  getAgentFallbacks,
  AGENTS_DIR,
} from "./agentLoader.js";
export {
  resolveCapability,
  getCapabilityChain,
  needsFallback,
} from "./capabilityResolver.js";
export type { CapabilityResolution } from "./capabilityResolver.js";
export {
  parseTeamFile,
  getBuiltInTeam,
  getCustomTeam,
  getTeam,
  listBuiltInTeams,
  listCustomTeams,
  getAllTeams,
  TEAMS_DIR,
  VAULT_TEAMS_DIR,
} from "./teamLoader.js";
export * from "./types/agentDefinition.js";
export * from "./types/teamManifest.js";
export * from "./types/teamPerformance.js";

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
  // DrawIt diagram tools (generate, export, map, flow, analyze)
  registry.register(DrawItRenderTool);
  registry.register(DrawItExportTool);
  registry.register(DrawItMapTool);
  registry.register(DrawItFlowTool);
  registry.register(DrawItAnalyzeTool);
  // High-level diagram creation (structured input, no NDJSON knowledge needed)
  registry.register(CreateDiagramTool);
  // Google Workspace tools
  registry.register(GoogleWorkspaceSchemaTool);
  registry.register(GoogleWorkspaceReadTool);
  registry.register(GoogleWorkspaceWriteTool);
  // Text-to-speech (Kokoro-82M MLX primary, F5-TTS clone, macOS say fallback)
  registry.register(SpeakTool);
  // Agent library and team workflow tools
  registry.register(ListAgentsTool);
  registry.register(LoadAgentTool);
  registry.register(ListTeamsTool);
  registry.register(RunTeamWorkflowTool);
  // Vault storage and search tools
  registry.register(VaultSearchTool);
  registry.register(VaultReadTool);
  registry.register(VaultContextTool);
  registry.register(VaultListTool);
  registry.register(VaultBatchReadTool);
  registry.register(VaultWriteNoteTool);
  registry.register(VaultCreateJobTool);
  // AI model benchmarking (user-triggered only, never automated)
  registry.register(BenchmarkModelTool);
  // Browser automation tools (requires hq-browser server running on :19200)
  for (const tool of browserTools) registry.register(tool);
  // Cross-agent planning system tools
  registry.register(PlanCreateTool);
  registry.register(PlanStatusTool);
  registry.register(PlanAnswerTool);
  registry.register(PlanSearchTool);
  registry.register(PlanUpdateTool);
  registry.register(CodemapQueryTool);
  registry.register(CodemapUpdateTool);
  registry.register(PlanAttachTool);
  registry.register(PlanVisualizeTool);
  registry.register(PlanGalleryTool);
  registry.register(PlanPhaseUpdateTool);
  return registry;
}
