export type AgentVertical = "engineering" | "qa" | "research" | "content" | "ops";
export type AgentRole = "coder" | "researcher" | "reviewer" | "planner" | "devops" | "workspace";
export type HarnessType = "claude-code" | "opencode" | "gemini-cli" | "any";

export interface AgentDefinitionFrontmatter {
  name: string;              // kebab-case unique ID
  displayName: string;       // "Reality Checker"
  version: string;           // "1.0.0"
  vertical: AgentVertical;
  baseRole: AgentRole;       // maps to 6 existing roles
  preferredHarness: HarnessType;
  modelHint?: string;
  maxTurns: number;
  timeoutMs?: number;
  autoLoad: boolean;
  tags: string[];
  defaultsTo?: "PASS" | "NEEDS_WORK" | "BLOCKED";  // quality gate default

  /**
   * Ordered fallback harness chain when preferredHarness is offline.
   * e.g. ["opencode", "gemini-cli"] means: try opencode first, then gemini-cli.
   * Part of the Capability Resolution Chain feature (dapper-snacking-snowflake).
   */
  fallbackChain?: HarnessType[];

  // Performance tracking
  performanceProfile?: {
    targetSuccessRate: number;    // e.g. 0.85
    avgTurnsBaseline?: number;    // calibrated after 10+ runs
    keyMetrics: string[];         // ["issues_flagged", "pass_rate", "retry_count"]
  };
  
  learningCycle?: {
    retroSection: string;
    metricsToTrack: string[];
  };
}

export interface AgentDefinition extends AgentDefinitionFrontmatter {
  instruction: string;
}
