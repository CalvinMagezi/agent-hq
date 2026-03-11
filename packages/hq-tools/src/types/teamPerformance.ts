export type GateOutcome = "PASS" | "NEEDS_WORK" | "BLOCKED";

export interface WorkflowRunRecord {
  runId: string;           // unique per execution
  teamName: string;
  customTeamId?: string;   // if user-assembled team
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "completed" | "blocked" | "failed";
  stagesCompleted: number;
  totalStages: number;
  gateResults: Record<string, GateOutcome>;  // gateId → PASS/NEEDS_WORK/BLOCKED
  agentScores: Record<string, AgentRunScore>; // agentName → per-run score
  synthesisQuality?: number; // 0-1, extracted from synthesis agent output
  retroNotePath: string;
}

export interface AgentRunScore {
  agentName: string;
  durationMs: number;
  turnCount: number;
  gatesPassed: number;   // times this agent's output passed a gate
  gatesFailed: number;   // times it failed and needed retry
  retriesNeeded: number;
  successScore: number;  // 0-1 composite
}

export interface TeamPerformanceSummary {
  teamName: string;
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  latestRuns: WorkflowRunRecord[];
}

export interface AgentPerformanceSummary {
  agentName: string;
  totalRuns: number;
  avgSuccessScore: number;
  avgDurationMs: number;
  avgTurnCount: number;
  gatesPassedTotal: number;
  gatesFailedTotal: number;
}

export interface AgentLeaderboard {
  agentName: string;
  vertical: string;
  successScore: number;
  totalRuns: number;
}

export interface OptimizationRecommendation {
  teamName: string;
  agentSubstitutions: Array<{
    stage: string;
    currentAgent: string;
    recommendedAgent: string;
    reason: string;           // "success rate 42% → 89% across similar tasks"
    confidence: number;       // 0-1
  }>;
  gateAdjustments: Array<{
    gateId: string;
    currentMaxRetries: number;
    recommendedMaxRetries: number;
    reason: string;
  }>;
  newAgentSuggestions: Array<{
    vertical: string;
    gapIdentified: string;    // "no agent specializes in database migration"
    suggestedName: string;
  }>;
  appliedAt?: string;
}
