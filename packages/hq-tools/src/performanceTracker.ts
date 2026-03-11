import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import type { WorkflowRunRecord, AgentRunScore, TeamPerformanceSummary, AgentPerformanceSummary, AgentLeaderboard } from "./types/teamPerformance.js";

// Dynamic path detection removed to avoid build errors

// Default vault path — can be overridden
let _vaultPath: string = path.resolve(process.env.HOME || "~", ".vault");

export function initPerformanceTracker(vaultPath: string) {
  _vaultPath = vaultPath;
}

function metricsDir(...parts: string[]) {
  const dir = path.join(_vaultPath, "_metrics", ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRunRecord(record: WorkflowRunRecord) {
  const teamDir = metricsDir("teams", record.teamName);
  const runPath = path.join(teamDir, `run-${record.runId}.md`);
  const fm = yaml.dump(record);
  fs.writeFileSync(runPath, `---\n${fm}---\n`, "utf-8");
}

function updateTeamSummary(teamName: string) {
  const teamDir = metricsDir("teams", teamName);
  const files = fs.readdirSync(teamDir).filter(f => f.startsWith("run-") && f.endsWith(".md"));

  const runs: WorkflowRunRecord[] = files.map(f => {
    const content = fs.readFileSync(path.join(teamDir, f), "utf-8");
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    try { return yaml.load(match[1]) as WorkflowRunRecord; } catch { return null; }
  }).filter((r): r is WorkflowRunRecord => r !== null);

  const totalRuns = runs.length;
  const successRate = totalRuns > 0
    ? runs.filter(r => r.status === "completed").length / totalRuns
    : 0;
  const avgDurationMs = totalRuns > 0
    ? runs.reduce((s, r) => s + r.durationMs, 0) / totalRuns
    : 0;

  const summary: TeamPerformanceSummary = {
    teamName,
    totalRuns,
    successRate,
    avgDurationMs,
    latestRuns: runs.slice(-20).reverse(),
  };

  const summaryPath = path.join(teamDir, "summary.md");
  fs.writeFileSync(summaryPath, `---\n${yaml.dump(summary)}---\n`, "utf-8");
}

export async function recordRun(result: WorkflowRunRecord): Promise<void> {
  writeRunRecord(result);
  updateTeamSummary(result.teamName);

  // Update per-agent summaries
  for (const [agentName, score] of Object.entries(result.agentScores)) {
    const agentDir = metricsDir("agents", agentName);
    const runPath = path.join(agentDir, `run-${result.runId}.md`);
    fs.writeFileSync(runPath, `---\n${yaml.dump({ ...score, teamName: result.teamName, runId: result.runId, startedAt: result.startedAt })}---\n`, "utf-8");
  }
}

export function getTeamSummary(teamName: string): TeamPerformanceSummary | null {
  const summaryPath = path.join(_vaultPath, "_metrics", "teams", teamName, "summary.md");
  if (!fs.existsSync(summaryPath)) return null;
  const content = fs.readFileSync(summaryPath, "utf-8");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  try { return yaml.load(match[1]) as TeamPerformanceSummary; } catch { return null; }
}

export function getAgentSummary(agentName: string): AgentPerformanceSummary | null {
  const agentDir = path.join(_vaultPath, "_metrics", "agents", agentName);
  if (!fs.existsSync(agentDir)) return null;

  const files = fs.readdirSync(agentDir).filter(f => f.startsWith("run-") && f.endsWith(".md"));
  const runs: AgentRunScore[] = files.map(f => {
    const content = fs.readFileSync(path.join(agentDir, f), "utf-8");
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    try { return yaml.load(match[1]) as AgentRunScore; } catch { return null; }
  }).filter((r): r is AgentRunScore => r !== null);

  if (runs.length === 0) return null;

  return {
    agentName,
    totalRuns: runs.length,
    avgSuccessScore: runs.reduce((s, r) => s + r.successScore, 0) / runs.length,
    avgDurationMs: runs.reduce((s, r) => s + r.durationMs, 0) / runs.length,
    avgTurnCount: runs.reduce((s, r) => s + r.turnCount, 0) / runs.length,
    gatesPassedTotal: runs.reduce((s, r) => s + r.gatesPassed, 0),
    gatesFailedTotal: runs.reduce((s, r) => s + r.gatesFailed, 0),
  };
}

export function getLeaderboard(): AgentLeaderboard[] {
  const agentsDir = path.join(_vaultPath, "_metrics", "agents");
  if (!fs.existsSync(agentsDir)) return [];

  return fs.readdirSync(agentsDir)
    .filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory())
    .map(agentName => {
      const summary = getAgentSummary(agentName);
      if (!summary) return null;
      return {
        agentName,
        vertical: agentName.includes("auditor") || agentName.includes("checker") ? "qa" : "general",
        successScore: summary.avgSuccessScore,
        totalRuns: summary.totalRuns,
      } as AgentLeaderboard;
    })
    .filter((l): l is AgentLeaderboard => l !== null)
    .sort((a, b) => b.successScore - a.successScore);
}
