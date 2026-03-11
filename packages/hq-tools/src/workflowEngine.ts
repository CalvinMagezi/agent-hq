/**
 * WorkflowEngine — Multi-stage team workflow orchestrator.
 *
 * Runs a TeamManifest through its stages in order:
 * - Sequential stages: run agents one at a time
 * - Parallel stages: Promise.all() for concurrent agents
 * - Gates: evaluator agent (e.g. reality-checker) must PASS before proceeding
 *
 * After each run, calls PerformanceTracker.recordRun() and writes a retro note.
 */

import * as fs from "fs";
import * as path from "path";
import { VaultClient } from "@repo/vault-client";
import type { TeamManifest, TeamStage, QualityGate } from "./types/teamManifest.js";
import type { WorkflowRunRecord, AgentRunScore, GateOutcome } from "./types/teamPerformance.js";
import { parseAgentFile, listAgentNames, buildAgentPromptSection } from "./agentLoader.js";
import { recordRun } from "./performanceTracker.js";

interface WorkflowOptions {
  team: TeamManifest;
  instruction: string;
  executionMode?: "quick" | "standard" | "thorough";
}

interface StageResult {
  stageId: string;
  agentResults: Record<string, string>; // agentName → result text
  gateOutcomes: Record<string, GateOutcome>;
  success: boolean;
}

function nowISO(): string {
  return new Date().toISOString();
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

export interface WorkflowResult {
  runId: string;
  teamName: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "completed" | "blocked" | "failed";
  stagesCompleted: number;
  totalStages: number;
  gateResults: Record<string, GateOutcome>;
  agentScores: Record<string, AgentRunScore>;
  retroNotePath: string;
}

export class WorkflowEngine {
  private vault: VaultClient;
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.vault = new VaultClient(vaultPath);
  }

  async run(options: WorkflowOptions): Promise<WorkflowResult> {
    const { team, instruction, executionMode = "standard" } = options;
    const runId = generateId();
    const startedAt = nowISO();
    const startMs = Date.now();

    const allGateResults: Record<string, GateOutcome> = {};
    const allAgentScores: Record<string, AgentRunScore> = {};
    let stagesCompleted = 0;
    let finalStatus: WorkflowResult["status"] = "completed";

    const priorResults: Record<string, string> = {};

    for (const stage of team.stages) {
      const stageResult = await this.runStage(
        stage,
        team.name,
        runId,
        instruction,
        priorResults,
        executionMode,
      );

      // Accumulate results
      for (const [agent, text] of Object.entries(stageResult.agentResults)) {
        priorResults[`${stage.stageId}:${agent}`] = text;
      }
      for (const [gateId, outcome] of Object.entries(stageResult.gateOutcomes)) {
        allGateResults[gateId] = outcome;
      }
      for (const [agentName, score] of Object.entries(allAgentScores)) {
        // accumulate scores — merge if already present
        if (allAgentScores[agentName]) {
          allAgentScores[agentName].gatesPassed += score.gatesPassed;
          allAgentScores[agentName].gatesFailed += score.gatesFailed;
        }
      }

      stagesCompleted++;

      if (!stageResult.success) {
        // Check if any gate was BLOCKED
        const blocked = Object.values(stageResult.gateOutcomes).includes("BLOCKED");
        finalStatus = blocked ? "blocked" : "completed";
        if (blocked) break;
      }
    }

    const completedAt = nowISO();
    const durationMs = Date.now() - startMs;

    const retroNotePath = await this.writeRetroNote({
      runId,
      teamName: team.name,
      instruction,
      stagesCompleted,
      totalStages: team.stages.length,
      status: finalStatus,
      gateResults: allGateResults,
      priorResults,
      startedAt,
      completedAt,
      durationMs,
    });

    const result: WorkflowResult = {
      runId,
      teamName: team.name,
      startedAt,
      completedAt,
      durationMs,
      status: finalStatus,
      stagesCompleted,
      totalStages: team.stages.length,
      gateResults: allGateResults,
      agentScores: allAgentScores,
      retroNotePath,
    };

    // Persist metrics
    const record: WorkflowRunRecord = {
      ...result,
      customTeamId: undefined,
      synthesisQuality: undefined,
    };
    await recordRun(record);

    return result;
  }

  private async runStage(
    stage: TeamStage,
    teamName: string,
    runId: string,
    instruction: string,
    priorResults: Record<string, string>,
    executionMode: string,
  ): Promise<StageResult> {
    const agentResults: Record<string, string> = {};
    const gateOutcomes: Record<string, GateOutcome> = {};

    // Build tasks for this stage
    const agentTasks = stage.agents.map(agentName => ({
      taskId: `${runId}-${stage.stageId}-${agentName}`,
      agentName,
      instruction: this.buildTaskInstruction(agentName, instruction, priorResults),
      targetHarnessType: this.resolveHarness(agentName),
    }));

    let taskResults: Array<{ taskId: string; agentName: string; result: string }> = [];

    if (stage.pattern === "parallel") {
      // Run all agents concurrently
      const results = await Promise.all(
        agentTasks.map(t => this.submitAndWaitForTask(t.taskId, t.agentName, t.instruction, t.targetHarnessType, runId))
      );
      taskResults = agentTasks.map((t, i) => ({ taskId: t.taskId, agentName: t.agentName, result: results[i] }));
    } else {
      // Run sequentially
      for (const task of agentTasks) {
        const result = await this.submitAndWaitForTask(task.taskId, task.agentName, task.instruction, task.targetHarnessType, runId);
        taskResults.push({ taskId: task.taskId, agentName: task.agentName, result });
      }
    }

    for (const r of taskResults) {
      agentResults[r.agentName] = r.result;
    }

    let stageSuccess = true;

    // Evaluate gates
    if (stage.gates) {
      for (const gate of stage.gates) {
        const evaluating = agentResults[gate.evaluatesResultOf] ?? Object.values(agentResults).join("\n");
        let outcome: GateOutcome = "NEEDS_WORK";
        let retries = 0;

        while (retries <= gate.maxRetries) {
          outcome = await this.evaluateGate(gate, evaluating, instruction, runId, retries);
          gateOutcomes[gate.gateId] = outcome;

          if (outcome === "PASS") break;
          if (outcome === "BLOCKED") {
            stageSuccess = false;
            break;
          }
          // NEEDS_WORK — retry the original agent
          if (retries < gate.maxRetries) {
            const retryTask = `${runId}-${stage.stageId}-${gate.evaluatesResultOf}-retry-${retries + 1}`;
            const retryInstruction = this.buildTaskInstruction(
              gate.evaluatesResultOf,
              `${instruction}\n\nPrevious attempt received NEEDS_WORK gate verdict. Fix the issues and resubmit.\n\nPrior result:\n${evaluating}`,
              priorResults,
            );
            const harness = this.resolveHarness(gate.evaluatesResultOf);
            const retryResult = await this.submitAndWaitForTask(retryTask, gate.evaluatesResultOf, retryInstruction, harness, runId);
            agentResults[gate.evaluatesResultOf] = retryResult;
          }
          retries++;
        }

        if (outcome !== "PASS" && gate.blockOnFailure) {
          stageSuccess = false;
        }
      }
    }

    return { stageId: stage.stageId, agentResults, gateOutcomes, success: stageSuccess };
  }

  private async evaluateGate(
    gate: QualityGate,
    contentToEvaluate: string,
    originalInstruction: string,
    runId: string,
    retryCount: number,
  ): Promise<GateOutcome> {
    const taskId = `${runId}-gate-${gate.gateId}-eval-${retryCount}`;
    const instruction = [
      `You are acting as a quality gate evaluator (${gate.evaluatorAgent}).`,
      `Original task: ${originalInstruction}`,
      `\nContent to evaluate:\n${contentToEvaluate.substring(0, 4000)}`,
      `\nReturn your verdict on the FIRST line: PASS, NEEDS_WORK, or BLOCKED.`,
      `PASS = complete, correct, evidence present. NEEDS_WORK = fixable issues. BLOCKED = fundamental problem requiring redesign.`,
    ].join("\n");

    const harness = this.resolveHarness(gate.evaluatorAgent);
    const result = await this.submitAndWaitForTask(taskId, gate.evaluatorAgent, instruction, harness, runId);

    const firstLine = result.trim().split("\n")[0].toUpperCase();
    if (firstLine.includes("PASS")) return "PASS";
    if (firstLine.includes("BLOCKED")) return "BLOCKED";
    return "NEEDS_WORK";
  }

  private buildTaskInstruction(
    agentName: string,
    mainInstruction: string,
    priorResults: Record<string, string>,
  ): string {
    const allNames = listAgentNames();
    const found = allNames.find(n => n.name === agentName);
    let agentPromptSection = "";

    if (found) {
      const agent = parseAgentFile(found.vertical, found.name);
      if (agent) {
        agentPromptSection = buildAgentPromptSection(agent) + "\n\n---\n\n";
      }
    }

    const priorResultsSection = Object.keys(priorResults).length > 0
      ? `\n\n## Prior Stage Results\n\n${Object.entries(priorResults)
          .map(([key, val]) => `### ${key}\n${val.substring(0, 1000)}`)
          .join("\n\n")}`
      : "";

    return `${agentPromptSection}## Your Task\n\n${mainInstruction}${priorResultsSection}`;
  }

  private resolveHarness(agentName: string): string {
    const allNames = listAgentNames();
    const found = allNames.find(n => n.name === agentName);
    if (found) {
      const agent = parseAgentFile(found.vertical, found.name);
      if (agent) return agent.preferredHarness;
    }
    return "claude-code";
  }

  private async submitAndWaitForTask(
    taskId: string,
    agentName: string,
    instruction: string,
    targetHarnessType: string,
    runId: string,
  ): Promise<string> {
    const jobId = `workflow-${runId}`;
    
    // Create the delegation task in vault
    await this.vault.createDelegatedTasks(jobId, [{
      taskId,
      instruction,
      targetHarnessType: targetHarnessType as any,
      priority: 60,
      dependsOn: [],
    }]);

    // Poll for completion (every 3s, timeout 30min)
    const timeoutMs = 30 * 60 * 1000;
    const pollIntervalMs = 3000;
    const startMs = Date.now();

    while (true) {
      if (Date.now() - startMs > timeoutMs) {
        return `[TIMEOUT] Task ${taskId} timed out after 30 minutes`;
      }

      const tasks = await this.vault.getTasksForJob(jobId);
      const task = tasks.find(t => t.taskId === taskId);

      if (task?.status === "completed") {
        return task.result ?? "(no result)";
      }
      if (task?.status === "failed") {
        return `[FAILED] ${task.error ?? "unknown error"}`;
      }
      if (task?.status === "cancelled") {
        return `[CANCELLED] Task was cancelled`;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  private async writeRetroNote(options: {
    runId: string;
    teamName: string;
    instruction: string;
    stagesCompleted: number;
    totalStages: number;
    status: string;
    gateResults: Record<string, GateOutcome>;
    priorResults: Record<string, string>;
    startedAt: string;
    completedAt: string;
    durationMs: number;
  }): Promise<string> {
    const retroDir = path.join(this.vaultPath, "Notebooks", "Projects", "Cloud-HQ", "Retros");
    fs.mkdirSync(retroDir, { recursive: true });

    const retroPath = path.join(retroDir, `${options.runId}-retro.md`);
    const durationMin = Math.round(options.durationMs / 60000);

    const gateSection = Object.entries(options.gateResults)
      .map(([gateId, outcome]) => `- ${gateId}: **${outcome}**`)
      .join("\n") || "- No gates evaluated";

    const resultsSection = Object.entries(options.priorResults)
      .map(([stage, result]) => `### ${stage}\n\n${result.substring(0, 1000)}${result.length > 1000 ? "\n\n[truncated...]" : ""}`)
      .join("\n\n");

    const content = [
      `---`,
      `runId: ${options.runId}`,
      `teamName: ${options.teamName}`,
      `status: ${options.status}`,
      `startedAt: "${options.startedAt}"`,
      `completedAt: "${options.completedAt}"`,
      `durationMs: ${options.durationMs}`,
      `stagesCompleted: ${options.stagesCompleted}`,
      `totalStages: ${options.totalStages}`,
      `---`,
      ``,
      `# Workflow Retro: ${options.teamName} — ${options.runId}`,
      ``,
      `**Status**: ${options.status} | **Duration**: ${durationMin}min | **Stages**: ${options.stagesCompleted}/${options.totalStages}`,
      ``,
      `## Task`,
      ``,
      options.instruction,
      ``,
      `## Gate Results`,
      ``,
      gateSection,
      ``,
      `## Stage Results`,
      ``,
      resultsSection,
      ``,
      `## Retrospective Notes`,
      ``,
      `*What went well:*`,
      ``,
      `*What could improve:*`,
      ``,
      `*Patterns to remember:*`,
      ``,
    ].join("\n");

    fs.writeFileSync(retroPath, content, "utf-8");
    return retroPath;
  }
}
