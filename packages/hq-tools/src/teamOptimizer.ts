import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import type { WorkflowRunRecord, GateOutcome, OptimizationRecommendation } from "./types/teamPerformance.js";
import type { TeamManifest } from "./types/teamManifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _vaultPath: string = path.resolve(process.env.HOME || "~", ".vault");
export function initTeamOptimizer(vaultPath: string) { _vaultPath = vaultPath; }

function metricsDir(...parts: string[]) {
  const d = path.join(_vaultPath, "_metrics", ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readTeamRuns(teamName: string): WorkflowRunRecord[] {
  const teamDir = path.join(_vaultPath, "_metrics", "teams", teamName);
  if (!fs.existsSync(teamDir)) return [];
  return fs.readdirSync(teamDir)
    .filter(f => f.startsWith("run-") && f.endsWith(".md"))
    .map(f => {
      const content = fs.readFileSync(path.join(teamDir, f), "utf-8");
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) return null;
      try { return yaml.load(match[1]) as WorkflowRunRecord; } catch { return null; }
    })
    .filter((r): r is WorkflowRunRecord => r !== null);
}

export function analyzeTeam(teamName: string): OptimizationRecommendation {
  const runs = readTeamRuns(teamName);
  const rec: OptimizationRecommendation = {
    teamName,
    agentSubstitutions: [],
    gateAdjustments: [],
    newAgentSuggestions: [],
  };

  if (runs.length < 3) return rec; // Not enough data

  // Analyze per-agent performance
  const agentScoreMap: Record<string, number[]> = {};
  for (const run of runs) {
    for (const [agentName, score] of Object.entries(run.agentScores)) {
      if (!agentScoreMap[agentName]) agentScoreMap[agentName] = [];
      agentScoreMap[agentName].push(score.successScore);
    }
  }

  for (const [agentName, scores] of Object.entries(agentScoreMap)) {
    if (scores.length < 3) continue;
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
    if (avg < 0.5) {
      rec.agentSubstitutions.push({
        stage: "unknown",
        currentAgent: agentName,
        recommendedAgent: `[suggest same-vertical alternative]`,
        reason: `Average success score ${(avg * 100).toFixed(0)}% across ${scores.length} runs is below 50% threshold`,
        confidence: 0.7,
      });
    }
  }

  // Analyze gate failure rates
  const gateFailures: Record<string, number[]> = {};
  const gateTotal: Record<string, number> = {};
  for (const run of runs) {
    for (const [gateId, outcome] of Object.entries(run.gateResults)) {
      if (!gateTotal[gateId]) { gateTotal[gateId] = 0; gateFailures[gateId] = []; }
      gateTotal[gateId]++;
      if (outcome === "NEEDS_WORK") gateFailures[gateId].push(1);
    }
  }

  for (const [gateId, total] of Object.entries(gateTotal)) {
    const failRate = (gateFailures[gateId]?.length ?? 0) / total;
    if (failRate > 0.7) {
      rec.gateAdjustments.push({
        gateId,
        currentMaxRetries: 2,
        recommendedMaxRetries: 3,
        reason: `Gate triggers NEEDS_WORK on ${(failRate * 100).toFixed(0)}% of runs — increasing retries may help`,
      });
    }
  }

  // Check if average duration exceeds double the estimate
  const avgDurationMs = runs.reduce((s, r) => s + r.durationMs, 0) / runs.length;
  if (avgDurationMs > 0) {
    // We can't read the manifest here easily, so just flag if over 2h
    if (avgDurationMs > 7200000) {
      rec.newAgentSuggestions.push({
        vertical: "ops",
        gapIdentified: `Average run duration ${Math.round(avgDurationMs / 60000)}min — consider adding performance-sentinel to identify bottlenecks`,
        suggestedName: "performance-sentinel",
      });
    }
  }

  return rec;
}

export function applyRecommendation(
  rec: OptimizationRecommendation,
  teamManifestPath: string,
  autoApply = false,
): void {
  if (!autoApply) {
    // Write to pending-optimizations for user review
    const pendingDir = metricsDir("pending-optimizations");
    const pendingPath = path.join(pendingDir, `${rec.teamName}-${Date.now()}.md`);
    fs.writeFileSync(pendingPath, `---\n${yaml.dump(rec)}---\n`, "utf-8");
    return;
  }

  // Auto-apply: update team manifest optimization block
  if (!fs.existsSync(teamManifestPath)) return;
  const content = fs.readFileSync(teamManifestPath, "utf-8");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return;

  try {
    const manifest = yaml.load(match[1]) as TeamManifest;
    const substitutions: Record<string, string> = {};
    for (const sub of rec.agentSubstitutions) {
      substitutions[sub.currentAgent] = sub.recommendedAgent;
    }
    manifest.optimization = {
      ...manifest.optimization,
      lastOptimizedAt: new Date().toISOString(),
      agentSubstitutions: substitutions,
    };
    const updatedYaml = yaml.dump(manifest);
    fs.writeFileSync(teamManifestPath, `---\n${updatedYaml}---\n`, "utf-8");
  } catch { /* skip on parse error */ }
}

export async function scheduledOptimizationCycle(teamsDir: string): Promise<void> {
  if (!fs.existsSync(teamsDir)) return;
  const teamFiles = fs.readdirSync(teamsDir).filter(f => f.endsWith(".md"));

  for (const teamFile of teamFiles) {
    const teamName = teamFile.replace(".md", "");
    const runs = readTeamRuns(teamName);
    if (runs.length < 5) continue; // Need at least 5 runs

    const rec = analyzeTeam(teamName);
    const teamManifestPath = path.join(teamsDir, teamFile);
    applyRecommendation(rec, teamManifestPath, false); // Write to pending, never auto-apply
  }
}
