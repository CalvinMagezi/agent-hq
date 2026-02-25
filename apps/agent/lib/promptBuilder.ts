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

// ── Types ────────────────────────────────────────────────────────────

type TaskType = "coding" | "research" | "workspace" | "analysis" | "writing" | "devops" | "general";
type HarnessType = "claude-code" | "opencode" | "gemini-cli" | "any";

interface PromptBuildRequest {
    rawInstruction: string;
    taskType?: TaskType;
    targetHarness?: HarnessType;
    projectName?: string;
    additionalContext?: string;
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

    constructor(vaultPath: string) {
        this.vaultPath = vaultPath;
        this.vault = new VaultClient(vaultPath);
    }

    async build(request: PromptBuildRequest): Promise<BuiltPrompt> {
        const taskType = request.taskType || detectTaskType(request.rawInstruction);
        const projectName = request.projectName || detectProjectName(request.rawInstruction, this.vaultPath);
        const contextSources: string[] = [];

        // Gather context in parallel
        const [systemContext, searchResults, projectContext] = await Promise.all([
            this.vault.getAgentContext().catch(() => null),
            this.vault.searchNotes(request.rawInstruction, 3).catch(() => [] as SearchResult[]),
            projectName ? this.getProjectContext(projectName) : Promise.resolve(null),
        ]);

        // ── Build context sections ────────────────────────────────

        let preferencesSection = "";
        if (systemContext?.preferences) {
            preferencesSection = truncate(systemContext.preferences, BUDGET.preferences);
            contextSources.push("PREFERENCES.md");
        }

        let memorySection = "";
        if (systemContext?.memory) {
            memorySection = extractRelevantMemoryLines(
                systemContext.memory,
                request.rawInstruction,
                BUDGET.memory,
            );
            if (memorySection) contextSources.push("MEMORY.md");
        }

        let searchSection = "";
        if (searchResults.length > 0) {
            searchSection = searchResults
                .map(r => `- **${r.title}** (${r.notebook}): ${truncate(r.snippet, 200)}`)
                .join("\n");
            contextSources.push(...searchResults.map(r => r.title));
        }

        let projectSection = "";
        if (projectContext) {
            projectSection = truncate(projectContext, BUDGET.projectContext);
            contextSources.push(`Projects/${projectName}`);
        }

        let pinnedSection = "";
        if (systemContext?.pinnedNotes && systemContext.pinnedNotes.length > 0) {
            const pinned = systemContext.pinnedNotes
                .slice(0, 3)
                .map(n => `- **${n.title}**: ${truncate(n.content || "", 120)}`)
                .join("\n");
            pinnedSection = truncate(pinned, BUDGET.pinnedNotes);
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
export function initPromptBuilder(vaultPath: string) {
    _builder = new PromptBuilder(vaultPath);
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
