/**
 * HQ Agent Tools — list_agents, load_agent, list_teams, run_team_workflow
 *
 * 4 tools for discovering and running vertical agent teams.
 */

import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";
import { listAgentNames, parseAgentFile, getAllAgents, buildAgentPromptSection } from "../agentLoader.js";
import { getAllTeams, getTeam } from "../teamLoader.js";
import type { AgentDefinition } from "../types/agentDefinition.js";
import type { TeamManifest } from "../types/teamManifest.js";

// ── list_agents ──────────────────────────────────────────────────────────────

interface AgentSummary {
  name: string;
  displayName: string;
  vertical: string;
  baseRole: string;
  preferredHarness: string;
  tags: string[];
  defaultsTo?: string;
}

interface ListAgentsInput {
  vertical?: string;
}

export const ListAgentsTool: HQTool<ListAgentsInput, { agents: AgentSummary[] }> = {
  name: "list_agents",
  description:
    "List all available agents in the HQ agent library. Filter by vertical (engineering, qa, research, content, ops).",
  tags: ["agents", "team", "list", "discover", "engineering", "qa", "research", "content", "ops"],
  schema: Type.Object({
    vertical: Type.Optional(
      Type.Union([
        Type.Literal("engineering"),
        Type.Literal("qa"),
        Type.Literal("research"),
        Type.Literal("content"),
        Type.Literal("ops"),
      ], { description: "Filter by vertical" })
    ),
  }),
  async execute(input, _ctx) {
    const names = listAgentNames(input.vertical);
    const agents = names
      .map(n => parseAgentFile(n.vertical, n.name))
      .filter((a): a is AgentDefinition => a !== null)
      .map(({ name, displayName, vertical, baseRole, preferredHarness, tags, defaultsTo }): AgentSummary => ({
        name, displayName, vertical, baseRole, preferredHarness, tags, defaultsTo,
      }));
    return { agents };
  },
};

// ── load_agent ───────────────────────────────────────────────────────────────

interface LoadAgentInput {
  agentName: string;
}

interface LoadAgentOutput {
  name: string;
  displayName: string;
  vertical: string;
  instruction: string;
  promptSection: string;
}

export const LoadAgentTool: HQTool<LoadAgentInput, LoadAgentOutput> = {
  name: "load_agent",
  description:
    "Load the full personality and instructions for a named agent (e.g. 'reality-checker', 'security-auditor'). Returns the agent's full prompt section for injection into delegation tasks.",
  tags: ["agent", "load", "personality", "prompt", "team"],
  schema: Type.Object({
    agentName: Type.String({
      description: "Name of the agent to load (e.g. 'feature-coder', 'reality-checker', 'synthesis-writer')",
    }),
  }),
  async execute(input, _ctx) {
    const allNames = listAgentNames();
    const found = allNames.find(n => n.name === input.agentName);
    if (!found) {
      const available = allNames.map(n => n.name).join(", ");
      throw new Error(`Agent '${input.agentName}' not found. Available: ${available}`);
    }
    const agent = parseAgentFile(found.vertical, found.name);
    if (!agent) {
      throw new Error(`Failed to parse agent '${input.agentName}'`);
    }
    return {
      name: agent.name,
      displayName: agent.displayName,
      vertical: agent.vertical,
      instruction: agent.instruction,
      promptSection: buildAgentPromptSection(agent),
    };
  },
};

// ── list_teams ───────────────────────────────────────────────────────────────

interface TeamSummary {
  name: string;
  displayName: string;
  description: string;
  estimatedDurationMins: number;
  stageCount: number;
  agents: string[];
  tags: string[];
}

export const ListTeamsTool: HQTool<Record<string, never>, { teams: TeamSummary[] }> = {
  name: "list_teams",
  description:
    "List all available team compositions, including built-in teams and any user-saved custom teams. Returns stage count, agents, and estimated duration.",
  tags: ["teams", "list", "discover", "team", "workflow"],
  schema: Type.Object({}),
  async execute(_input, _ctx) {
    const teams = getAllTeams();
    const summaries: TeamSummary[] = teams.map(t => ({
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      estimatedDurationMins: t.estimatedDurationMins,
      stageCount: t.stages.length,
      agents: Array.from(new Set(t.stages.flatMap(s => s.agents))),
      tags: t.tags,
    }));
    return { teams: summaries };
  },
};

// ── run_team_workflow ────────────────────────────────────────────────────────

interface RunTeamWorkflowInput {
  teamName: string;
  instruction: string;
  executionMode?: "quick" | "standard" | "thorough";
  modelOverride?: string;
}

interface RunTeamWorkflowOutput {
  workflowId: string;
  teamName: string;
  stages: number;
  status: string;
  message: string;
}

export const RunTeamWorkflowTool: HQTool<RunTeamWorkflowInput, RunTeamWorkflowOutput> = {
  name: "run_team_workflow",
  description:
    "Launch a team workflow by team name. This orchestrates the full team pipeline: stages run in order, parallel agents run concurrently, gates evaluate quality between stages. Returns a workflowId for tracking.",
  tags: ["team", "workflow", "run", "launch", "orchestrate", "engineering-sprint", "research-synthesis", "full-stack-feature", "content-pipeline"],
  schema: Type.Object({
    teamName: Type.String({
      description: "Name of the team to launch (e.g. 'engineering-sprint', 'research-synthesis', 'full-stack-feature', 'content-pipeline')",
    }),
    instruction: Type.String({
      description: "The task instruction to pass to the full team. This is the top-level goal all agents will work toward.",
    }),
    executionMode: Type.Optional(
      Type.Union([
        Type.Literal("quick"),
        Type.Literal("standard"),
        Type.Literal("thorough"),
      ], { description: "Override the team's default execution mode" })
    ),
    modelOverride: Type.Optional(
      Type.String({ description: "Override the LLM model for all agents (e.g. 'anthropic/claude-haiku-4-5-20251001' for fast/cheap runs)" })
    ),
  }),
  async execute(input, ctx) {
    const team = getTeam(input.teamName);
    if (!team) {
      const allTeams = getAllTeams().map(t => t.name).join(", ");
      throw new Error(`Team '${input.teamName}' not found. Available: ${allTeams}`);
    }

    // Dynamically import WorkflowEngine to avoid circular deps at module load
    const { WorkflowEngine } = await import("../workflowEngine.js");
    const engine = new WorkflowEngine(ctx.vaultPath);
    
    const result = await engine.run({
      team,
      instruction: input.instruction,
      executionMode: input.executionMode ?? team.executionMode ?? "standard",
      modelOverride: input.modelOverride,
    });

    return {
      workflowId: result.runId,
      teamName: input.teamName,
      stages: result.stagesCompleted,
      status: result.status,
      message: result.status === "completed"
        ? `Workflow complete. Retro note at: ${result.retroNotePath}`
        : `Workflow ended with status: ${result.status}`,
    };
  },
};
