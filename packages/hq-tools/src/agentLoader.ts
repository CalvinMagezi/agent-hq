import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import type { AgentDefinition, AgentDefinitionFrontmatter } from "./types/agentDefinition.js";

// Resolve relative to this file's location so it works from MCP and non-root CWDs
const __dir = path.dirname(fileURLToPath(import.meta.url));
export const AGENTS_DIR = path.resolve(__dir, "../agents");

export function parseAgentFile(vertical: string, name: string): AgentDefinition | null {
  const agentPath = path.join(AGENTS_DIR, vertical, `${name}.md`);
  // Path traversal guard
  const resolvedAgents = path.resolve(AGENTS_DIR);
  const resolvedAgent = path.resolve(agentPath);
  if (!resolvedAgent.startsWith(resolvedAgents + path.sep)) return null;
  if (!fs.existsSync(agentPath)) return null;

  const content = fs.readFileSync(agentPath, "utf-8");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  try {
    const fm = yaml.load(match[1]) as AgentDefinitionFrontmatter;
    return {
      ...fm,
      instruction: content
    };
  } catch (err) {
    console.error(`Failed to parse agent ${name}:`, err);
    return null;
  }
}

export function listAgentNames(vertical?: string): { vertical: string, name: string }[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  
  const agents: { vertical: string, name: string }[] = [];
  const verticals = vertical 
    ? [vertical] 
    : fs.readdirSync(AGENTS_DIR).filter(f => fs.statSync(path.join(AGENTS_DIR, f)).isDirectory());
  
  for (const v of verticals) {
    const vDir = path.join(AGENTS_DIR, v);
    if (!fs.existsSync(vDir)) continue;
    
    const files = fs.readdirSync(vDir).filter(f => f.endsWith(".md"));
    for (const f of files) {
      agents.push({ vertical: v, name: f.replace(".md", "") });
    }
  }
  
  return agents;
}

export function getAllAgents(): AgentDefinition[] {
  const names = listAgentNames();
  return names
    .map(n => parseAgentFile(n.vertical, n.name))
    .filter((a): a is AgentDefinition => a !== null);
}

export function buildAgentPromptSection(agent: AgentDefinition): string {
  // Strip frontmatter from instruction for clean injection
  const instructionBody = agent.instruction.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
  
  return [
    `## Vertical Agent: ${agent.displayName} (${agent.vertical})`,
    `Base Role: ${agent.baseRole}`,
    `Version: ${agent.version}`,
    `Tags: ${agent.tags.join(", ")}`,
    "",
    instructionBody
  ].join("\n");
}

/**
 * Return the fallback harness chain for a named agent.
 * Returns [] if the agent doesn't exist or has no fallbackChain set.
 * Part of the Capability Resolution Chain feature (dapper-snacking-snowflake).
 */
export function getAgentFallbacks(agentName: string): string[] {
  const names = listAgentNames();
  for (const { vertical, name } of names) {
    if (name === agentName) {
      const agent = parseAgentFile(vertical, name);
      if (agent?.fallbackChain) return agent.fallbackChain;
    }
  }
  return [];
}

