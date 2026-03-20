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
import { VaultClient, resolveChatProvider } from "@repo/vault-client";
import type { TeamManifest, TeamStage, QualityGate } from "./types/teamManifest.js";
import type { WorkflowRunRecord, AgentRunScore, GateOutcome } from "./types/teamPerformance.js";
import { parseAgentFile, listAgentNames, buildAgentPromptSection } from "./agentLoader.js";
import { recordRun } from "./performanceTracker.js";
import { SmartTraceWriter } from "./smartTrace.js";
import type { SmartDimensions } from "./smartTrace.js";

interface WorkflowOptions {
  team: TeamManifest;
  instruction: string;
  executionMode?: "quick" | "standard" | "thorough";
  /** Override the LLM model for all agents in this run (e.g. "anthropic/claude-haiku-4-5-20251001") */
  modelOverride?: string;
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
  private modelOverride?: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.vault = new VaultClient(vaultPath);
  }

  async run(options: WorkflowOptions): Promise<WorkflowResult> {
    const { team, instruction, executionMode = "standard" } = options;
    this.modelOverride = options.modelOverride;
    const runId = generateId();
    const startedAt = nowISO();
    const startMs = Date.now();

    // ── SMART Trace: track this run ──
    const trace = new SmartTraceWriter(this.vaultPath, runId);
    trace.appendEvent({ type: "run_start", runId, teamName: team.name, instruction: instruction.substring(0, 200) });

    const allGateResults: Record<string, GateOutcome> = {};
    const allAgentScores: Record<string, AgentRunScore> = {};
    const taskAssignments: SmartDimensions["achievable"]["assignments"] = [];
    let stagesCompleted = 0;
    let finalStatus: WorkflowResult["status"] = "completed";

    const priorResults: Record<string, string> = {};

    for (const stage of team.stages) {
      trace.appendEvent({ type: "stage_start", stageId: stage.stageId, pattern: stage.pattern, agents: stage.agents });

      const stageResult = await this.runStage(
        stage,
        team.name,
        runId,
        instruction,
        priorResults,
        executionMode,
        trace,
      );

      // Accumulate results
      for (const [agent, text] of Object.entries(stageResult.agentResults)) {
        priorResults[`${stage.stageId}:${agent}`] = text;
      }
      for (const [gateId, outcome] of Object.entries(stageResult.gateOutcomes)) {
        allGateResults[gateId] = outcome;
        trace.appendEvent({ type: "gate_evaluated", gateId, outcome });
      }
      for (const [agentName, score] of Object.entries(allAgentScores)) {
        // accumulate scores — merge if already present
        if (allAgentScores[agentName]) {
          allAgentScores[agentName].gatesPassed += score.gatesPassed;
          allAgentScores[agentName].gatesFailed += score.gatesFailed;
        }
      }

      // Collect assignment info from stage results
      for (const agentName of stage.agents) {
        const harness = this.resolveHarness(agentName);
        const status = stageResult.agentResults[agentName] ? "completed" : "unknown";
        taskAssignments.push({ agent: agentName, harness, reason: `stage ${stage.stageId}`, status });
      }

      stagesCompleted++;
      trace.appendEvent({ type: "stage_complete", stageId: stage.stageId, success: stageResult.success });

      if (!stageResult.success) {
        // Check if any gate was BLOCKED
        const blocked = Object.values(stageResult.gateOutcomes).includes("BLOCKED");
        finalStatus = blocked ? "blocked" : "completed";
        if (blocked) break;
      }
    }

    const completedAt = nowISO();
    const durationMs = Date.now() - startMs;

    // ── Write SMART trace summary ──
    trace.appendEvent({ type: "run_complete", status: finalStatus, durationMs });
    const dimensions: SmartDimensions = {
      specific: { instruction, stagesCompleted, totalStages: team.stages.length },
      measurable: {},
      achievable: { assignments: taskAssignments },
      relevant: { gateResults: Object.fromEntries(Object.entries(allGateResults).map(([k, v]) => [k, String(v)])) },
      timeBound: { deadlineMs: 30 * 60 * 1000, deadlineMet: durationMs < 30 * 60 * 1000 },
    };

    const durationMin = Math.round(durationMs / 60000);
    const gateSection = Object.entries(allGateResults)
      .map(([gateId, outcome]) => `- ${gateId}: **${outcome}**`)
      .join("\n") || "- No gates evaluated";
    const resultsSection = Object.entries(priorResults)
      .map(([stage, result]) => `### ${stage}\n\n${result.substring(0, 1000)}${result.length > 1000 ? "\n\n[truncated...]" : ""}`)
      .join("\n\n");

    trace.writeSummary({
      runId,
      teamName: team.name,
      status: finalStatus,
      startedAt,
      completedAt,
      durationMs,
      dimensions,
      body: [
        `# Workflow Trace: ${team.name} — ${runId}`,
        ``,
        `**Status**: ${finalStatus} | **Duration**: ${durationMin}min | **Stages**: ${stagesCompleted}/${team.stages.length}`,
        ``,
        `## Task`,
        ``,
        instruction,
        ``,
        `## Gate Results`,
        ``,
        gateSection,
        ``,
        `## Stage Results`,
        ``,
        resultsSection,
      ].join("\n"),
    });

    // Also write legacy retro note (for backward compatibility)
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
    trace?: SmartTraceWriter,
  ): Promise<StageResult> {
    const agentResults: Record<string, string> = {};
    const gateOutcomes: Record<string, GateOutcome> = {};

    // Build tasks for this stage
    const agentTasks = stage.agents.map(agentName => {
      const harness = this.resolveHarness(agentName);
      const taskId = `${runId}-${stage.stageId}-${agentName}`;
      trace?.appendEvent({ type: "task_assigned", taskId, agent: agentName, harness, reason: `stage ${stage.stageId}` });
      return {
        taskId,
        agentName,
        instruction: this.buildTaskInstruction(agentName, instruction, priorResults),
        targetHarnessType: harness,
      };
    });

    let taskResults: Array<{ taskId: string; agentName: string; result: string }> = [];

    if (stage.pattern === "parallel") {
      // Run all agents concurrently
      for (const t of agentTasks) trace?.appendEvent({ type: "task_started", taskId: t.taskId, harness: t.targetHarnessType });
      const results = await Promise.all(
        agentTasks.map(t => this.submitAndWaitForTask(t.taskId, t.agentName, t.instruction, t.targetHarnessType, runId))
      );
      taskResults = agentTasks.map((t, i) => {
        const failed = results[i].startsWith("[TIMEOUT]") || results[i].startsWith("[FAILED]");
        trace?.appendEvent({
          type: failed ? "task_failed" : "task_completed",
          taskId: t.taskId,
          ...(failed ? { error: results[i].substring(0, 200) } : {}),
        });
        return { taskId: t.taskId, agentName: t.agentName, result: results[i] };
      });
    } else {
      // Run sequentially
      for (const task of agentTasks) {
        trace?.appendEvent({ type: "task_started", taskId: task.taskId, harness: task.targetHarnessType });
        const startMs = Date.now();
        const result = await this.submitAndWaitForTask(task.taskId, task.agentName, task.instruction, task.targetHarnessType, runId);
        const failed = result.startsWith("[TIMEOUT]") || result.startsWith("[FAILED]");
        trace?.appendEvent({
          type: failed ? "task_failed" : "task_completed",
          taskId: task.taskId,
          durationMs: Date.now() - startMs,
          ...(failed ? { error: result.substring(0, 200) } : {}),
        });
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

    // Record task in vault for traceability
    await this.vault.submitTask(jobId, {
      taskId,
      instruction,
      targetHarnessType,
    });
    await this.vault.claimTask(taskId, "workflow-engine");

    // Execute inline via LLM
    try {
      const result = await this.executeLLMCall(instruction);
      await this.vault.completeTask(taskId, result);
      return result;
    } catch (err: any) {
      const errorMsg = err.message ?? String(err);
      await this.vault.failTask(taskId, errorMsg);
      return `[FAILED] ${errorMsg}`;
    }
  }

  /**
   * Execute a single LLM call via OpenRouter, Anthropic, or Gemini.
   * Uses modelOverride if set, otherwise resolves from environment.
   */
  private async executeLLMCall(instruction: string): Promise<string> {
    const provider = resolveChatProvider();
    const model = this.modelOverride ?? provider.model;

    if (provider.type === "none" && !this.modelOverride) {
      throw new Error("No LLM provider configured. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.");
    }

    // Anthropic native API
    if (provider.type === "anthropic" && !this.modelOverride?.includes("/")) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": provider.apiKey!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: "user", content: instruction }],
        }),
      });
      if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
      const data = await resp.json() as any;
      return data.content?.[0]?.text ?? "(empty response)";
    }

    // Gemini native API
    if (provider.type === "gemini" && !this.modelOverride?.includes("/")) {
      const url = `${provider.baseUrl}/models/${model}:generateContent?key=${provider.apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: instruction }] }],
          generationConfig: { maxOutputTokens: 4096 },
        }),
      });
      if (!resp.ok) throw new Error(`Gemini API ${resp.status}: ${await resp.text()}`);
      const data = await resp.json() as any;
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "(empty response)";
    }

    // OpenRouter (default — supports all model IDs with slash notation)
    const apiKey = provider.type === "openrouter" ? provider.apiKey : process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("No OpenRouter API key available for model: " + model);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: instruction }],
      }),
    });
    if (!resp.ok) throw new Error(`OpenRouter API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json() as any;
    return data.choices?.[0]?.message?.content ?? "(empty response)";
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
    const retroDir = path.join(this.vaultPath, "Notebooks", "Projects", "Agent-HQ", "Retros");
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
