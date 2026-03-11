/**
 * Prompt Builder — Core orchestrator tool for context-enriched delegation.
 *
 * Gathers vault context (preferences, memory, project notes, relevant knowledge)
 * and structures prompts using 5 philosophies:
 *   1. Clear Instructions
 *   2. Elaborate Explanation
 *   3. Sequential Design
 *   4. Clear Definition of Done
 *   5. Context Efficiency
 *
 * Registered as `build_prompt` in orchestrator mode alongside `delegate_to_relay`.
 */

import * as fs from "fs";
import * as path from "path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { VaultClient } from "@repo/vault-client";
import type { SearchResult, SystemContext } from "@repo/vault-client";
import type { AgentRole } from "./agentRoles.js";
import { buildRolePromptSection } from "./agentRoles.js";
import type { ExecutionMode } from "./executionModes.js";
import { getModeConfig } from "./executionModes.js";

// ── Types ────────────────────────────────────────────────────────────

type TaskType = "coding" | "research" | "workspace" | "analysis" | "writing" | "devops" | "general";
type HarnessType = "claude-code" | "opencode" | "gemini-cli" | "any";

interface PromptBuildRequest {
    rawInstruction: string;
    taskType?: TaskType;
    targetHarness?: HarnessType;
    projectName?: string;
    projectId?: string;   // Optional: link job to project for goal ancestry context
    additionalContext?: string;
    role?: AgentRole;
    executionMode?: ExecutionMode;
}

interface BuiltPrompt {
    instruction: string;
    taskType: TaskType;
    contextSources: string[];
}

// ── Context Budgets (chars) ──────────────────────────────────────────

const BUDGET = {
    preferences: 600,
    memory: 600,
    searchResults: 600,     // ~200 per result x 3
    projectContext: 500,
    pinnedNotes: 400,
    newsContext: 200,
};

// ── Task Type Detection ──────────────────────────────────────────────

const TASK_PATTERNS: Array<[TaskType, RegExp]> = [
    ["coding", /\b(refactor|debug|fix\s?bug|implement|code|function|class|api|endpoint|component|module|test|lint|typescript|javascript|python|rust|go|compile|build|dependency|package|import|migrate|schema|database|query|sql)\b/i],
    ["devops", /\b(deploy|ci[/-]?cd|docker|kubernetes|k8s|pipeline|infrastructure|terraform|ansible|nginx|ssl|dns|server|hosting|vercel|aws|gcp)\b/i],
    ["workspace", /\b(google\s?doc|spreadsheet|sheet|gmail|calendar|drive|slides|keep|workspace|form)\b/i],
    ["research", /\b(research|investigate|find\s?out|look\s?up|compare|evaluate|survey|review|explore\s?options|alternatives)\b/i],
    ["analysis", /\b(analyze|analysis|summarize|summary|report|statistics|metrics|dashboard|audit|review\s?data)\b/i],
    ["writing", /\b(write|draft|blog|article|documentation|readme|proposal|email|copy|content)\b/i],
];

function detectTaskType(instruction: string): TaskType {
    for (const [type, pattern] of TASK_PATTERNS) {
        if (pattern.test(instruction)) return type;
    }
    return "general";
}

// ── Project Detection ────────────────────────────────────────────────

function detectProjectName(instruction: string, vaultPath: string): string | null {
    const projectsDir = path.join(vaultPath, "Notebooks", "Projects");
    if (!fs.existsSync(projectsDir)) return null;

    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    const lower = instruction.toLowerCase();
    for (const dir of dirs) {
        if (lower.includes(dir.toLowerCase())) return dir;
    }
    return null;
}

// ── Helper: Truncate to budget ───────────────────────────────────────

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 3) + "...";
}

// ── Goal Ancestry ─────────────────────────────────────────────────────

/**
 * Build a Mission → Project Goal → Task context section.
 * Reads SOUL.md for the mission statement and project notes for the goal.
 * Gracefully degrades if files are missing.
 * Part of the Goal Ancestry feature (dapper-snacking-snowflake).
 */
function buildGoalAncestrySection(
    vaultPath: string,
    projectId: string | undefined,
    taskInstruction: string,
): string {
    const parts: string[] = [];

    // 1. Mission from SOUL.md
    try {
        const soulPath = path.join(vaultPath, "_system", "SOUL.md");
        if (fs.existsSync(soulPath)) {
            const raw = fs.readFileSync(soulPath, "utf-8");
            // Extract first meaningful paragraph after frontmatter
            const body = raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
            const firstPara = body.split("\n\n")[0]?.trim();
            if (firstPara) {
                parts.push(`**Mission:** ${truncate(firstPara, 300)}`);
            }
        }
    } catch {
        // Non-critical
    }

    // 2. Project Goal from Notebooks/Projects/{projectId}/
    if (projectId) {
        try {
            const projectDir = path.join(vaultPath, "Notebooks", "Projects", projectId);
            const overviewNames = [`${projectId}.md`, "README.md", "Overview.md", "Goal.md", "Index.md"];
            let projectGoal: string | null = null;

            for (const name of overviewNames) {
                const fp = path.join(projectDir, name);
                if (fs.existsSync(fp)) {
                    const raw = fs.readFileSync(fp, "utf-8");
                    // Look for a ## Goal or ## Objective section first
                    const goalMatch = raw.match(/##\s+(?:Goal|Objective|Mission)[\s\S]*?\n([^#]+)/i);
                    if (goalMatch) {
                        projectGoal = goalMatch[1].trim();
                    } else {
                        // Fall back to first paragraph of body
                        const body = raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
                        projectGoal = body.split("\n\n")[0]?.trim() ?? null;
                    }
                    break;
                }
            }

            if (projectGoal) {
                parts.push(`**Project Goal (${projectId}):** ${truncate(projectGoal, 400)}`);
            } else {
                parts.push(`**Project:** ${projectId}`);
            }
        } catch {
            parts.push(`**Project:** ${projectId}`);
        }
    }

    // 3. Current Task
    parts.push(`**Task:** ${truncate(taskInstruction, 200)}`);

    if (parts.length <= 1) return ""; // Only "Task" — not useful as ancestry

    return `## Goal Ancestry\n\n${parts.join("\n")}\n`;
}

function extractRelevantMemoryLines(memory: string, instruction: string, maxChars: number): string {
    if (!memory) return "";
    const keywords = instruction.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const lines = memory.split("\n");
    const relevant: string[] = [];
    let charCount = 0;

    for (const line of lines) {
        const lower = line.toLowerCase();
        if (keywords.some(kw => lower.includes(kw))) {
            if (charCount + line.length > maxChars) break;
            relevant.push(line);
            charCount += line.length;
        }
    }

    // If no keyword matches, take the first lines as general context
    if (relevant.length === 0) {
        for (const line of lines) {
            if (!line.trim()) continue;
            if (charCount + line.length > maxChars) break;
            relevant.push(line);
            charCount += line.length;
        }
    }

    return relevant.join("\n");
}

// ── Harness-Specific Constraints ─────────────────────────────────────

function getHarnessConstraints(harness?: HarnessType): string {
    switch (harness) {
        case "claude-code":
            return "- You have full access to bash, file editing, and git operations\n- Verify your work by reading files after writing them\n- Run tests if a test suite exists";
        case "opencode":
            return "- You have access to code generation and file operations\n- Focus on producing clean, working code";
        case "gemini-cli":
            return "- You have access to Google Workspace APIs\n- Do NOT attempt coding tasks — focus on workspace operations\n- Use structured output where possible";
        default:
            return "- Execute the task using available tools\n- Verify your work before reporting completion";
    }
}

// ── Task-Type-Specific Steps & DoD ───────────────────────────────────

function getTaskTypeGuidance(taskType: TaskType): { steps: string; dod: string } {
    switch (taskType) {
        case "coding":
            return {
                steps: [
                    "[CODE MODE PROTOCOL] CALL `mcp:map_repository` if the repository isn't mapped to Obsidian yet",
                    "[CODE MODE PROTOCOL] CALL `mcp:get_blast_radius` on target files FIRST to understand breakages",
                    "[CODE MODE PROTOCOL] CALL `mcp:get_dependency_context` to understand imports and dependencies",
                    "Read and understand the existing code in the relevant files",
                    "Identify the specific changes needed",
                    "Implement the changes surgically — edit only what's necessary",
                    "Verify the changes compile/lint without errors",
                    "Run existing tests if available, or manually verify the behavior",
                ].map((s, i) => `${i + 1}. ${s}`).join("\n"),
                dod: [
                    "Code compiles without errors",
                    "Changes are minimal and focused on the task",
                    "Code Mode structural graph queried before modifications",
                    "Existing tests pass (if applicable)",
                    "Files follow the project's naming and style conventions",
                ].map(c => `- [ ] ${c}`).join("\n"),
            };
        case "research":
            return {
                steps: [
                    "Clarify the research scope and key questions",
                    "Search for relevant information using available tools",
                    "Evaluate source credibility and relevance",
                    "Synthesize findings into a structured report",
                    "Highlight key takeaways and recommendations",
                ].map((s, i) => `${i + 1}. ${s}`).join("\n"),
                dod: [
                    "All key questions addressed",
                    "Sources cited where applicable",
                    "Clear summary with actionable recommendations",
                ].map(c => `- [ ] ${c}`).join("\n"),
            };
        case "workspace":
            return {
                steps: [
                    "Identify the target Google Workspace resource",
                    "Retrieve current state if needed",
                    "Apply the requested changes",
                    "Verify the changes were applied correctly",
                ].map((s, i) => `${i + 1}. ${s}`).join("\n"),
                dod: [
                    "Workspace resource updated as requested",
                    "Changes verified",
                    "Summary of what was changed provided",
                ].map(c => `- [ ] ${c}`).join("\n"),
            };
        case "devops":
            return {
                steps: [
                    "Review current infrastructure/deployment configuration",
                    "Identify changes needed",
                    "Implement configuration changes",
                    "Validate configuration syntax",
                    "Test in a safe manner before applying to production",
                ].map((s, i) => `${i + 1}. ${s}`).join("\n"),
                dod: [
                    "Configuration changes are valid and tested",
                    "No breaking changes to existing services",
                    "Deployment/infrastructure change documented",
                ].map(c => `- [ ] ${c}`).join("\n"),
            };
        case "analysis":
            return {
                steps: [
                    "Gather the relevant data or information",
                    "Process and organize the data",
                    "Analyze patterns, trends, or anomalies",
                    "Create visualizations or structured output if appropriate",
                    "Summarize findings with conclusions",
                ].map((s, i) => `${i + 1}. ${s}`).join("\n"),
                dod: [
                    "Data analyzed thoroughly",
                    "Findings clearly presented",
                    "Conclusions and next steps provided",
                ].map(c => `- [ ] ${c}`).join("\n"),
            };
        case "writing":
            return {
                steps: [
                    "Understand the target audience and tone",
                    "Outline the key points to cover",
                    "Draft the content",
                    "Review for clarity, accuracy, and style",
                ].map((s, i) => `${i + 1}. ${s}`).join("\n"),
                dod: [
                    "Content covers all required topics",
                    "Tone matches the intended audience",
                    "Clear, concise, and well-structured",
                ].map(c => `- [ ] ${c}`).join("\n"),
            };
        default:
            return {
                steps: [
                    "Understand the full scope of the request",
                    "Break down into actionable sub-steps if complex",
                    "Execute each step methodically",
                    "Verify the outcome",
                ].map((s, i) => `${i + 1}. ${s}`).join("\n"),
                dod: [
                    "Task completed as requested",
                    "Results verified",
                    "Summary of actions provided",
                ].map(c => `- [ ] ${c}`).join("\n"),
            };
    }
}

// ── PromptBuilder Class ──────────────────────────────────────────────

export class PromptBuilder {
    private vault: VaultClient;
    private vaultPath: string;
    private searchClient: any; // Ideally SearchClient type from @repo/vault-client/search

    constructor(vaultPath: string, searchClient?: any) {
        this.vaultPath = vaultPath;
        this.vault = new VaultClient(vaultPath);
        this.searchClient = searchClient;
    }

    async build(request: PromptBuildRequest): Promise<BuiltPrompt> {
        const taskType = request.taskType || detectTaskType(request.rawInstruction);
        const projectName = request.projectName || detectProjectName(request.rawInstruction, this.vaultPath);
        const contextSources: string[] = [];

        // Apply execution mode budget multiplier
        const modeMultiplier = request.executionMode
            ? getModeConfig(request.executionMode).contextBudgetMultiplier
            : 1.0;

        const scaledBudget = {
            preferences: Math.round(BUDGET.preferences * modeMultiplier),
            memory: Math.round(BUDGET.memory * modeMultiplier),
            searchResults: Math.round(BUDGET.searchResults * modeMultiplier),
            projectContext: Math.round(BUDGET.projectContext * modeMultiplier),
            pinnedNotes: Math.round(BUDGET.pinnedNotes * modeMultiplier),
            newsContext: Math.round(BUDGET.newsContext * modeMultiplier),
        };

        // In "quick" mode, skip search and pinned notes entirely
        const skipSearch = request.executionMode === "quick";

        // Gather context in parallel
        const [systemContext, searchResults, projectContext] = await Promise.all([
            this.vault.getAgentContext().catch(() => null),
            skipSearch ? Promise.resolve([] as SearchResult[]) : (this.searchClient ? this.searchClient.keywordSearch(request.rawInstruction, 5) : this.vault.searchNotes(request.rawInstruction, 3)).catch(() => [] as SearchResult[]),
            projectName ? this.getProjectContext(projectName) : Promise.resolve(null),
        ]);

        // ── Build context sections (budgets scaled by execution mode) ──

        // Goal Ancestry (Mission → Project → Task) — injected at the top of the prompt
        const goalAncestry = buildGoalAncestrySection(
            this.vaultPath,
            request.projectId,
            request.rawInstruction,
        );
        if (goalAncestry) contextSources.push("Goal Ancestry");

        let preferencesSection = "";
        if (systemContext?.preferences) {
            preferencesSection = truncate(systemContext.preferences, scaledBudget.preferences);
            contextSources.push("PREFERENCES.md");
        }

        let memorySection = "";
        if (systemContext?.memory) {
            memorySection = extractRelevantMemoryLines(
                systemContext.memory,
                request.rawInstruction,
                scaledBudget.memory,
            );
            if (memorySection) contextSources.push("MEMORY.md");
        }

        let searchSection = "";
        if (searchResults.length > 0) {
            searchSection = searchResults
                .map((r: any) => `- **${r.title}** (${r.notebook}): ${truncate(r.snippet, 200)}`)
                .join("\n");
            contextSources.push(...searchResults.map((r: any) => r.title));

            // Log query→context pairs for SBLU-4 (Weaver) training data
            try {
                const avgRelevance = searchResults.reduce((s: number, r: any) => s + (r.relevance ?? 0), 0) / searchResults.length;
                const weaverLogPath = path.join(this.vaultPath, "_embeddings", "weaver-training.jsonl");
                const entry = JSON.stringify({
                    jobInstruction: request.rawInstruction.slice(0, 400),
                    queryUsed: request.rawInstruction.slice(0, 200),
                    contextSelected: searchResults.map((r: any) => r.title),
                    relevanceScore: Math.min(1, avgRelevance / 5),
                    ts: new Date().toISOString(),
                });
                fs.appendFileSync(weaverLogPath, entry + "\n", "utf-8");
            } catch {
                // Non-critical — never block prompt building
            }
        }

        let projectSection = "";
        if (projectContext) {
            projectSection = truncate(projectContext, scaledBudget.projectContext);
            contextSources.push(`Projects/${projectName}`);
        }

        let pinnedSection = "";
        if (!skipSearch && systemContext?.pinnedNotes && systemContext.pinnedNotes.length > 0) {
            const pinned = systemContext.pinnedNotes
                .slice(0, 3)
                .map(n => `- **${n.title}**: ${truncate(n.content || "", 120)}`)
                .join("\n");
            pinnedSection = truncate(pinned, scaledBudget.pinnedNotes);
            contextSources.push("Pinned Notes");
        }

        // ── Assemble prompt using 5-philosophy template ───────────

        const guidance = getTaskTypeGuidance(taskType);
        const harnessConstraints = getHarnessConstraints(request.targetHarness);

        const sections: string[] = [];

        // Philosophy 1: Clear Instructions — objective
        sections.push(`# TASK\n\n## Objective\n${request.rawInstruction}`);

        // Philosophy 2: Elaborate Explanation — context
        const contextParts: string[] = [];
        if (goalAncestry) {
            contextParts.push(goalAncestry);
        }
        if (preferencesSection) {
            contextParts.push(`### User Preferences\n${preferencesSection}`);
        }
        if (projectSection) {
            contextParts.push(`### Project Context\n${projectSection}`);
        }
        if (searchSection) {
            contextParts.push(`### Relevant Knowledge\n${searchSection}`);
        }
        if (pinnedSection) {
            contextParts.push(`### Pinned Notes\n${pinnedSection}`);
        }
        if (memorySection) {
            contextParts.push(`### Agent Memory (Relevant)\n${memorySection}`);
        }

        // Current Events (skip in quick mode)
        if (request.executionMode !== "quick") {
            const briefsPath = path.join(this.vaultPath, "_system/NEWS-BRIEFS.md");
            if (fs.existsSync(briefsPath)) {
                try {
                    const briefsRaw = fs.readFileSync(briefsPath, "utf-8");
                    const briefsBody = briefsRaw.replace(/---[\s\S]*?---/, "").trim().slice(0, scaledBudget.newsContext);
                    if (briefsBody) contextParts.push(`### Current Events\n${briefsBody}`);
                } catch { /* ignore */ }
            }
        }
        if (request.additionalContext) {
            contextParts.push(`### Additional Context\n${request.additionalContext}`);
        }

        if (contextParts.length > 0) {
            sections.push(`## Context\n\n${contextParts.join("\n\n")}`);
        }

        // Philosophy 3: Sequential Design — steps
        sections.push(`## Steps\n${guidance.steps}`);

        // Philosophy 4: Clear Definition of Done
        sections.push(`## Definition of Done\n${guidance.dod}`);

        // Philosophy 5: Context Efficiency — constraints are compact
        sections.push(`## Constraints\n${harnessConstraints}`);

        // Agent Role (if specified) — injects role identity, behavior, and output format
        if (request.role) {
            sections.push(buildRolePromptSection(request.role));
            contextSources.push(`Role: ${request.role}`);
        }

        const instruction = sections.join("\n\n");

        return { instruction, taskType, contextSources };
    }

    private async getProjectContext(projectName: string): Promise<string | null> {
        const projectDir = path.join(this.vaultPath, "Notebooks", "Projects", projectName);
        if (!fs.existsSync(projectDir)) return null;

        // Look for overview/README-style file first
        const overviewNames = [`${projectName}.md`, "README.md", "Overview.md", "Index.md"];
        for (const name of overviewNames) {
            const fp = path.join(projectDir, name);
            if (fs.existsSync(fp)) {
                const raw = fs.readFileSync(fp, "utf-8");
                return raw;
            }
        }

        // Fallback: list project files as context
        const files = fs.readdirSync(projectDir)
            .filter(f => f.endsWith(".md"))
            .slice(0, 10);

        if (files.length === 0) return null;
        return `Project "${projectName}" contains: ${files.join(", ")}`;
    }
}

// ── Module-Level State (mirrors delegationToolsVault.ts pattern) ─────

let _builder: PromptBuilder | null = null;

/** Initialize prompt builder with vault path (call once at startup) */
export function initPromptBuilder(vaultPath: string, searchClient?: any) {
    _builder = new PromptBuilder(vaultPath, searchClient);
}

// ── BuildPromptTool ──────────────────────────────────────────────────

const BuildPromptSchema = Type.Object({
    rawInstruction: Type.String({
        description: "The user's original task instruction to enrich with vault context",
    }),
    taskType: Type.Optional(Type.Union([
        Type.Literal("coding"),
        Type.Literal("research"),
        Type.Literal("workspace"),
        Type.Literal("analysis"),
        Type.Literal("writing"),
        Type.Literal("devops"),
        Type.Literal("general"),
    ], { description: "Task category. Auto-detected from instruction if omitted." })),
    targetHarness: Type.Optional(Type.Union([
        Type.Literal("claude-code"),
        Type.Literal("opencode"),
        Type.Literal("gemini-cli"),
        Type.Literal("any"),
    ], { description: "Target relay bot type — used for harness-specific constraints" })),
    role: Type.Optional(Type.Union([
        Type.Literal("coder"),
        Type.Literal("researcher"),
        Type.Literal("reviewer"),
        Type.Literal("planner"),
        Type.Literal("devops"),
        Type.Literal("workspace"),
    ], { description: "Agent role — injects role-specific system prompt, behavior guidance, and output format." })),
    executionMode: Type.Optional(Type.Union([
        Type.Literal("quick"),
        Type.Literal("standard"),
        Type.Literal("thorough"),
    ], { description: "Execution mode — affects context budget. Quick uses 0.5x budget, thorough uses 2x." })),
    projectName: Type.Optional(Type.String({
        description: "Project name to pull context from Notebooks/Projects/{name}/. Auto-detected if omitted.",
    })),
    additionalContext: Type.Optional(Type.String({
        description: "Any extra context the orchestrator wants to include in the prompt",
    })),
});

export const BuildPromptTool: AgentTool<typeof BuildPromptSchema> = {
    name: "build_prompt",
    description: `Build a context-enriched prompt for delegation to relay bots. Call this BEFORE delegate_to_relay to produce a high-quality instruction that includes vault context (user preferences, project notes, relevant knowledge, memory).

The tool auto-detects task type (coding, research, workspace, etc.) and project name from the instruction. It returns a structured prompt with:
- Clear objective
- Relevant vault context (preferences, memory, project notes, search results)
- Sequential execution steps tailored to the task type
- Explicit definition of done
- Harness-specific constraints

Use the returned instruction as the 'instruction' field in delegate_to_relay.`,
    parameters: BuildPromptSchema,
    label: "Build Prompt",
    execute: async (_toolCallId, args) => {
        if (!_builder) {
            return {
                content: [{ type: "text", text: "Error: Prompt builder not initialized." }],
                details: {},
            };
        }

        try {
            const result = await _builder.build({
                rawInstruction: args.rawInstruction,
                taskType: args.taskType as TaskType | undefined,
                targetHarness: args.targetHarness as HarnessType | undefined,
                role: args.role as AgentRole | undefined,
                executionMode: args.executionMode as ExecutionMode | undefined,
                projectName: args.projectName,
                additionalContext: args.additionalContext,
            });

            const meta = [
                `Task type: ${result.taskType}`,
                `Context sources: ${result.contextSources.length > 0 ? result.contextSources.join(", ") : "none"}`,
                `Prompt length: ${result.instruction.length} chars`,
            ].join("\n");

            return {
                content: [{
                    type: "text",
                    text: `Enriched prompt built successfully.\n\n${meta}\n\n---\n\n${result.instruction}`,
                }],
                details: {
                    taskType: result.taskType,
                    contextSources: result.contextSources,
                    promptLength: result.instruction.length,
                },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Prompt build error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};
