export interface TeamManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  executionMode?: "quick" | "standard" | "thorough";
  estimatedDurationMins: number;
  tags: string[];
  stages: TeamStage[];
  synthesisAgent?: string;
  
  // Optimization metadata (updated by teamOptimizer.ts over time)
  optimization?: {
    lastOptimizedAt?: string;
    agentSubstitutions?: Record<string, string>; // original → current best
    gateThresholdAdjustments?: Record<string, number>;
    averageRunDurationMs?: number;
    successRate?: number;
  };
}

export interface TeamStage {
  stageId: string;
  description: string;
  pattern: "sequential" | "parallel" | "gated";
  agents: string[];
  taskIds: string[];
  gates?: QualityGate[];
  dependsOnStages?: string[];
}

export interface QualityGate {
  gateId: string;
  evaluatorAgent: string;
  evaluatesResultOf: string;
  maxRetries: number;
  passingOutcome: "PASS" | "NEEDS_WORK" | "BLOCKED";
  blockOnFailure: boolean;
}
