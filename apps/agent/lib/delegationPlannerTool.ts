/**
 * Delegation Planner Tool — Clarification-First Protocol.
 *
 * Generates a human-readable DISPATCH PLAN for the orchestrator to present
 * to the user BEFORE calling delegate_to_relay. This is a pure formatting
 * tool — no async, no vault access, no network.
 *
 * Workflow position: AFTER chat_with_user (clarification), BEFORE build_prompt + delegate_to_relay.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const ProposedTaskSchema = Type.Object({
    taskId: Type.String({ description: "Unique task identifier (e.g., 'schema-1', 'ui-build-2')" }),
    description: Type.String({ description: "What this task does, in plain English" }),
    targetHarness: Type.Union([
        Type.Literal("claude-code"),
        Type.Literal("opencode"),
        Type.Literal("gemini-cli"),
        Type.Literal("any"),
    ], { description: "Which relay bot type will execute this task" }),
    deliverable: Type.String({ description: "Concrete output: file path created, schema added, page built, etc." }),
    dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete before this one" })),
});

const DraftDispatchPlanSchema = Type.Object({
    instruction: Type.String({ description: "The original user instruction, verbatim or lightly cleaned up" }),
    targetRepo: Type.Optional(Type.String({ description: "The git repository name (e.g., 'kolaborate-monorepo', 'agent-hq')" })),
    targetApp: Type.Optional(Type.String({ description: "The specific app or service within the repo (e.g., 'marketplace', 'api', 'mobile')" })),
    targetPath: Type.Optional(Type.String({ description: "Absolute or repo-relative path where outputs should land" })),
    constraints: Type.Optional(Type.Array(Type.String(), { description: "Explicit off-limits items (e.g., 'Do not modify .vault/', 'No DB migrations without review')" })),
    additionalContext: Type.Optional(Type.String({ description: "Any extra context from the user that should appear in the plan" })),
    proposedTasks: Type.Array(ProposedTaskSchema, { description: "The task breakdown to present for approval" }),
});

function formatDispatchPlan(args: {
    instruction: string;
    targetRepo?: string;
    targetApp?: string;
    targetPath?: string;
    constraints?: string[];
    additionalContext?: string;
    proposedTasks: Array<{
        taskId: string;
        description: string;
        targetHarness: string;
        deliverable: string;
        dependsOn?: string[];
    }>;
}): string {
    const lines: string[] = [];

    lines.push("DISPATCH PLAN — Awaiting Your Approval");
    lines.push("=".repeat(42));
    lines.push("");
    lines.push(`TASK: ${args.instruction}`);
    lines.push("");

    const hasTarget = args.targetRepo || args.targetApp || args.targetPath;
    if (hasTarget) {
        lines.push("TARGET:");
        if (args.targetRepo) lines.push(`  Repository : ${args.targetRepo}`);
        if (args.targetApp)  lines.push(`  App/Service: ${args.targetApp}`);
        if (args.targetPath) lines.push(`  Output Path: ${args.targetPath}`);
        lines.push("");
    }

    if (args.additionalContext) {
        lines.push("ADDITIONAL CONTEXT:");
        lines.push(`  ${args.additionalContext}`);
        lines.push("");
    }

    lines.push("PROPOSED TASKS:");
    for (let i = 0; i < args.proposedTasks.length; i++) {
        const t = args.proposedTasks[i];
        const depNote = t.dependsOn && t.dependsOn.length > 0
            ? ` (after: ${t.dependsOn.join(", ")})`
            : "";
        lines.push(`${i + 1}. [${t.targetHarness}] ${t.description}${depNote}`);
        lines.push(`   -> Deliverable: ${t.deliverable}`);
    }
    lines.push("");

    if (args.constraints && args.constraints.length > 0) {
        lines.push("OFF-LIMITS / CONSTRAINTS:");
        for (const c of args.constraints) lines.push(`  - ${c}`);
        lines.push("");
    }

    lines.push("-".repeat(42));
    lines.push("Reply YES to dispatch, or tell me what to change.");

    return lines.join("\n");
}

export const DraftDispatchPlanTool: AgentTool<typeof DraftDispatchPlanSchema> = {
    name: "draft_dispatch_plan",
    description: `Generate a structured DISPATCH PLAN to present to the user for approval BEFORE delegating any coding/build tasks.

Call this AFTER gathering clarification from the user (via chat_with_user) and BEFORE calling build_prompt or delegate_to_relay.

The tool formats a clear, human-readable plan showing the task, target repo/app/path, proposed task breakdown with relay assignments and deliverables, and off-limits constraints.

The returned plan text should be sent to the user via chat_with_user (waitForResponse: true) asking for YES or change requests.

Do NOT call for: relay health checks, vault lookups, status queries, or tasks where the target is already fully specified.`,
    parameters: DraftDispatchPlanSchema,
    label: "Draft Dispatch Plan",
    execute: async (_toolCallId, args) => {
        const planText = formatDispatchPlan(args);
        return {
            content: [{ type: "text", text: planText }],
            details: {
                instruction: args.instruction,
                targetRepo: args.targetRepo,
                targetApp: args.targetApp,
                targetPath: args.targetPath,
                taskCount: args.proposedTasks.length,
                constraintCount: args.constraints?.length ?? 0,
            },
        };
    },
};
