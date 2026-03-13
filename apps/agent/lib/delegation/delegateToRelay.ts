/**
 * DelegateToRelay tool — sends tasks to Discord relay bots for execution.
 *
 * Supports role-aware routing, model fallback chains, trace spans,
 * security constraints, and execution mode limits.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";
import type { AgentRole } from "../agentRoles.js";
import { getRoleConfig, detectRole } from "../agentRoles.js";
import { getModeConfig } from "../executionModes.js";
import { getFallbackChain, serializeFallbackChain } from "../modelFallback.js";
import { resolveCapability, needsFallback } from "@repo/hq-tools";
import { BudgetGuard } from "@repo/vault-client";
import {
    _vault, _currentJobId, _traceDb, _currentTraceId,
    _currentJobSpanId, _currentExecutionMode,
} from "./state.js";

const BROWSER_KEYWORDS = ["browser", "screenshot", "localhost", "navigate", "webapp",
  "vercel.app", "ngrok.io", "click", "fill form", "test the"];

function injectBrowserGuidance(instruction: string): string {
    const needs = BROWSER_KEYWORDS.some(kw => instruction.toLowerCase().includes(kw));
    if (!needs) return instruction;
    return instruction + `\n\n> **Browser**: Use \`hq_call browser_session_start\` (discover via \`hq_discover browser\`). Server on http://127.0.0.1:19200. Close session when done.`;
}

const SecurityConstraintsSchema = Type.Object({
    noGit: Type.Optional(Type.Boolean({ description: "Block all git commands" })),
    noNetwork: Type.Optional(Type.Boolean({ description: "Block network access" })),
    filesystemAccess: Type.Optional(Type.Union([
        Type.Literal("full"),
        Type.Literal("read-only"),
        Type.Literal("restricted"),
    ], { description: "Filesystem access level" })),
    allowedDirectories: Type.Optional(Type.Array(Type.String(), { description: "Allowed paths when restricted" })),
    blockedCommands: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns for blocked commands" })),
    maxExecutionMs: Type.Optional(Type.Number({ description: "Max execution time in ms" })),
});

const AgentRoleSchema = Type.Optional(Type.Union([
    Type.Literal("coder"),
    Type.Literal("researcher"),
    Type.Literal("reviewer"),
    Type.Literal("planner"),
    Type.Literal("devops"),
    Type.Literal("workspace"),
], { description: "Agent role — affects system prompt, model hint, and turn limits. Auto-detected if omitted." }));

export const DelegateToRelaySchema = Type.Object({
    tasks: Type.Array(
        Type.Object({
            taskId: Type.String({ description: "Unique task identifier within this job (e.g., 'research-1', 'code-fix-2')" }),
            instruction: Type.String({ description: "The full prompt/instruction for the relay bot to execute" }),
            targetHarnessType: Type.Union([
                Type.Literal("claude-code"),
                Type.Literal("opencode"),
                Type.Literal("gemini-cli"),
                Type.Literal("any"),
            ], { description: "Which relay bot type to target" }),
            role: AgentRoleSchema,
            agentName: Type.Optional(Type.String({
                description: "Named agent from library (e.g. 'security-auditor'). Overrides role prompt with full personality when set."
            })),
            modelOverride: Type.Optional(Type.String({ description: "Optional model override" })),
            dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete first" })),
            priority: Type.Optional(Type.Number({ description: "Priority (higher = processed first, default 50)" })),
            securityConstraints: Type.Optional(SecurityConstraintsSchema),
        }),
    ),
    discordChannelId: Type.Optional(Type.String({ description: "Discord channel to post results to" })),
});

export const DelegateToRelayTool: AgentTool<typeof DelegateToRelaySchema> = {
    name: "delegate_to_relay",
    description: `Delegate tasks to Discord relay bots for execution. Each task is sent to a specific relay bot type:
- claude-code: Best for code editing, git operations, debugging, complex refactoring
- opencode: Multi-model flexibility, quick code generation, model comparison
- gemini-cli: Google Workspace (Docs, Sheets, Drive, Gmail, Calendar, Keep), research, analysis, summarization. NOT for coding tasks.
- any: Auto-select the healthiest available relay

AGENT ROLES (optional — auto-detected if omitted):
- coder: Writes, modifies, debugs code. Reads before editing, verifies after.
- researcher: Investigates questions, explores codebases. Read-only — does NOT modify files.
- reviewer: Validates code changes for correctness and security. Read-only — only reports findings.
- planner: Analyzes requirements, creates implementation plans. Does NOT implement.
- devops: Handles deployment, CI/CD, infrastructure. Validates before applying.
- workspace: Google Workspace operations (Calendar, Gmail, Drive, Docs).

ROUTING GUIDELINES:
- Google Docs/Sheets/Drive/Gmail/Calendar/Keep tasks → gemini-cli + workspace role
- Code editing, debugging, git operations → claude-code + coder role
- Code review, security audit → claude-code + reviewer role
- Research, investigation → claude-code + researcher role

Tasks can have dependencies (dependsOn) to create execution chains. Always check relay health first with check_relay_health.
Use securityConstraints per task to restrict what the relay can do (e.g., noGit: true, filesystemAccess: "read-only").`,
    parameters: DelegateToRelaySchema,
    label: "Delegate to Relay",
    execute: async (_toolCallId, args) => {
        if (!_currentJobId || !_vault) {
            return {
                content: [{ type: "text", text: "Error: No active job context or vault not initialized." }],
                details: {},
            };
        }

        // Check execution mode limits
        const modeConfig = getModeConfig(_currentExecutionMode);
        if (args.tasks.length > modeConfig.maxParallelTasks) {
            const independent = args.tasks.filter(t => !t.dependsOn || t.dependsOn.length === 0);
            if (independent.length > modeConfig.maxParallelTasks) {
                return {
                    content: [{
                        type: "text",
                        text: `⚠️ Execution mode "${_currentExecutionMode}" allows max ${modeConfig.maxParallelTasks} parallel tasks, but ${independent.length} independent tasks were submitted. Reduce the number of parallel tasks or switch to a higher mode (e.g., [THOROUGH] prefix in instruction).`,
                    }],
                    details: { mode: _currentExecutionMode, maxParallel: modeConfig.maxParallelTasks },
                };
            }
        }

        try {
            // ── Compute per-task budget ceiling from remaining agent budget ──
            let budgetCeilingUsd: number | undefined;
            if (_vault) {
                try {
                    const budgetGuard = new BudgetGuard(path.resolve(_vault.resolve(".")));
                    const agentName = args.tasks[0]?.agentName ?? "default";
                    const check = await budgetGuard.checkBudget(agentName);
                    if (check.allowed && check.remaining < Infinity) {
                        // Split remaining budget evenly across tasks
                        budgetCeilingUsd = Math.max(0.01, check.remaining / args.tasks.length);
                    }
                } catch {
                    // Non-critical — skip budget ceiling
                }
            }

            const tasksWithTrace = args.tasks.map((t) => {
                const role: AgentRole = (t.role as AgentRole | undefined) ?? detectRole(t.instruction);
                const roleConfig = getRoleConfig(role);

                let effectiveHarness = t.targetHarnessType;
                if (effectiveHarness === "any" && roleConfig?.preferredHarness && roleConfig.preferredHarness !== "any") {
                    effectiveHarness = roleConfig.preferredHarness;
                }

                // ── Capability Resolution Chain ─────────────────────────────
                // When a named agent is provided and harness is "any", walk the
                // agent's fallbackChain to find the best available relay.
                // "Available" is approximated by querying the vault relay health.
                if (t.agentName && effectiveHarness === "any") {
                    try {
                        // Get relay health to determine available harnesses
                        const relayHealthDir = _vault?.resolve("_delegation/relay-health");
                        if (relayHealthDir) {
                            const availableHarnesses: string[] = [];
                            if (fs.existsSync(relayHealthDir)) {
                                const files = fs.readdirSync(relayHealthDir).filter((f: string) => f.endsWith(".md"));
                                for (const f of files) {
                                    const content = fs.readFileSync(path.join(relayHealthDir, f), "utf-8");
                                    if (content.includes("status: online") || content.includes("status: healthy")) {
                                        // Extract harness type from filename (e.g. claude-code-xyz.md)
                                        if (f.startsWith("claude-code")) availableHarnesses.push("claude-code");
                                        else if (f.startsWith("opencode")) availableHarnesses.push("opencode");
                                        else if (f.startsWith("gemini-cli")) availableHarnesses.push("gemini-cli");
                                    }
                                }
                            }
                            if (availableHarnesses.length > 0 && needsFallback(t.agentName, availableHarnesses)) {
                                const resolution = resolveCapability(t.agentName, availableHarnesses);
                                if (resolution) {
                                    console.warn(`⚡ Capability fallback: "${t.agentName}" preferred ${resolution.preferredHarness} → routing to ${resolution.harness} (depth: ${resolution.fallbackDepth})`);
                                    effectiveHarness = resolution.harness;
                                }
                            }
                        }
                    } catch {
                        // Non-critical — fall through to original harness resolution
                    }
                }


                const effectiveModel = t.modelOverride
                    ?? roleConfig?.modelHint
                    ?? (modeConfig.preferredModel || undefined);

                const fallbackChain = effectiveModel ? getFallbackChain(effectiveModel) : undefined;

                let spanId: string | undefined;
                if (_traceDb && _currentTraceId) {
                    spanId = _traceDb.createSpan({
                        traceId: _currentTraceId,
                        parentSpanId: _currentJobSpanId ?? undefined,
                        taskId: t.taskId,
                        type: "delegation",
                        name: `${effectiveHarness}${role ? `/${role}` : ""}: ${t.taskId}`,
                    });
                    _traceDb.addSpanEvent(spanId, _currentTraceId, "started",
                        `Delegated to ${effectiveHarness}${role ? ` (role: ${role})` : ""}: ${t.instruction.substring(0, 80)}`);
                    _traceDb.updateTraceCounts(_currentTraceId, { total: 1 });
                }

                return {
                    taskId: t.taskId,
                    instruction: injectBrowserGuidance(t.instruction),
                    targetHarnessType: effectiveHarness as any,
                    modelOverride: effectiveModel,
                    dependsOn: t.dependsOn || [],
                    priority: t.priority,
                    traceId: _currentTraceId ?? undefined,
                    spanId,
                    parentSpanId: _currentJobSpanId ?? undefined,
                    securityConstraints: t.securityConstraints as any,
                    metadata: {
                        role,
                        ...(fallbackChain && fallbackChain.fallbacks.length > 0 && {
                            fallbackModels: serializeFallbackChain(fallbackChain),
                        }),
                        executionMode: _currentExecutionMode,
                        ...(budgetCeilingUsd !== undefined && { budgetCeilingUsd }),
                    },
                };
            });

            await _vault.createDelegatedTasks(_currentJobId, tasksWithTrace);

            const taskList = args.tasks
                .map((t) => {
                    const detectedRole = (t.role as AgentRole | undefined) ?? detectRole(t.instruction);
                    const roleTag = ` [${detectedRole}]`;
                    return `  - ${t.taskId}${roleTag} → ${t.targetHarnessType}: ${t.instruction.substring(0, 80)}${t.instruction.length > 80 ? "..." : ""}`;
                })
                .join("\n");

            const traceInfo = _currentTraceId
                ? `\nTrace ID: ${_currentTraceId} (use get_trace_status for real-time progress)`
                : "";

            const modeInfo = `\nExecution mode: ${_currentExecutionMode} (max ${modeConfig.maxParallelTasks} parallel, ${Math.round(modeConfig.delegationTimeoutMs / 60000)}min timeout)`;

            return {
                content: [{
                    type: "text",
                    text: `Delegated ${args.tasks.length} task(s) to vault queue:\n${taskList}\n${traceInfo}${modeInfo}\nUse check_delegation_status to monitor progress.`,
                }],
                details: { taskIds: args.tasks.map((t) => t.taskId) },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Delegation error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};
