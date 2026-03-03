/**
 * Agent Role System — Typed sub-agent profiles for delegation.
 *
 * Inspired by CodeBuff's specialized agent pattern (editor, researcher,
 * reviewer, file-picker, thinker). Each role carries a system prompt suffix,
 * preferred harness, model hint, turn limit, and output guidance.
 *
 * Usage:
 *   const role = detectRole("Review the PR for security issues");
 *   // → "reviewer"
 *   const config = getRoleConfig(role);
 *   const promptSection = buildRolePromptSection(role);
 */

// ── Types ────────────────────────────────────────────────────────────

export type AgentRole =
    | "coder"
    | "researcher"
    | "reviewer"
    | "planner"
    | "devops"
    | "workspace";

export type HarnessType = "claude-code" | "opencode" | "gemini-cli" | "any";

export interface AgentRoleConfig {
    role: AgentRole;
    description: string;
    systemPromptSuffix: string;
    preferredHarness: HarnessType;
    modelHint?: string;
    maxTurns?: number;
    outputGuidance: string;
}

// ── Role Configurations ──────────────────────────────────────────────

const ROLE_CONFIGS: Record<AgentRole, AgentRoleConfig> = {
    coder: {
        role: "coder",
        description: "Writes, modifies, and debugs code",
        systemPromptSuffix: [
            "You are a precise code editor.",
            "Read files before modifying them — understand existing code first.",
            "Make minimal, surgical changes. Do not refactor surrounding code.",
            "Verify by reading back the files you modified.",
            "Run tests if a test suite exists.",
        ].join(" "),
        preferredHarness: "claude-code",
        maxTurns: 100,
        outputGuidance:
            "Return: files changed (with paths), tests run and results, verification status.",
    },
    researcher: {
        role: "researcher",
        description: "Investigates questions, explores codebases, gathers information",
        systemPromptSuffix: [
            "You are a thorough researcher.",
            "Search broadly first, then deep-dive into the most relevant findings.",
            "Cite sources. Structure findings with clear headings.",
            "DO NOT modify any files — only read and report.",
        ].join(" "),
        preferredHarness: "claude-code",
        modelHint: "gemini-2.5-flash",
        maxTurns: 50,
        outputGuidance:
            "Return: structured findings with sources, key takeaways, actionable recommendations.",
    },
    reviewer: {
        role: "reviewer",
        description: "Validates code changes for correctness, style, and completeness",
        systemPromptSuffix: [
            "You are a code reviewer.",
            "Read all changed files. Check for bugs, style violations, missing edge cases, and security issues.",
            "DO NOT modify any files — only report findings.",
            "If everything looks good, say so in one sentence.",
        ].join(" "),
        preferredHarness: "claude-code",
        modelHint: "claude-opus-4-6",
        maxTurns: 30,
        outputGuidance:
            "Return: approved/rejected, list of issues (severity + location + suggestion), summary.",
    },
    planner: {
        role: "planner",
        description: "Analyzes requirements and creates implementation plans",
        systemPromptSuffix: [
            "You are an implementation planner.",
            "Explore the codebase to understand architecture before planning.",
            "Create detailed step-by-step plans with file paths, function signatures, and dependency ordering.",
            "DO NOT implement — only plan.",
        ].join(" "),
        preferredHarness: "claude-code",
        maxTurns: 40,
        outputGuidance:
            "Return: numbered steps, files to create/modify, dependency order, risks and mitigations.",
    },
    devops: {
        role: "devops",
        description: "Handles deployment, CI/CD, infrastructure tasks",
        systemPromptSuffix: [
            "You are a DevOps engineer.",
            "Review configurations before changing them. Validate syntax.",
            "Test in safe mode first.",
            "Never force-push or delete production resources without explicit confirmation.",
        ].join(" "),
        preferredHarness: "claude-code",
        maxTurns: 60,
        outputGuidance:
            "Return: changes made, validation results, rollback instructions if applicable.",
    },
    workspace: {
        role: "workspace",
        description: "Google Workspace operations (Calendar, Gmail, Drive, Docs)",
        systemPromptSuffix: [
            "You are a workspace assistant.",
            "Use Google APIs for calendar, email, drive, and document operations.",
            "Confirm destructive actions before executing.",
            "Provide structured summaries of what was done.",
        ].join(" "),
        preferredHarness: "gemini-cli",
        maxTurns: 30,
        outputGuidance:
            "Return: what was done, links to resources, confirmation of changes.",
    },
};

// ── Role Detection Patterns ──────────────────────────────────────────

const ROLE_PATTERNS: Array<[AgentRole, RegExp]> = [
    // Reviewer — must be checked before coder (both match code keywords)
    [
        "reviewer",
        /\b(review|audit|validate|check\s+for\s+bugs|code\s+review|security\s+review|pr\s+review|pull\s+request\s+review|lint\s+check)\b/i,
    ],
    // Planner — must be checked before coder
    [
        "planner",
        /\b(plan|design|architect|blueprint|spec|specification|rfc|proposal|outline\s+implementation|implementation\s+plan)\b/i,
    ],
    // DevOps
    [
        "devops",
        /\b(deploy|ci[/-]?cd|docker|kubernetes|k8s|pipeline|infrastructure|terraform|ansible|nginx|ssl|dns|server|hosting|vercel|aws|gcp|monitoring|alerting)\b/i,
    ],
    // Workspace
    [
        "workspace",
        /\b(google\s?doc|spreadsheet|sheet|gmail|calendar|drive|slides|keep|workspace|form|meeting|schedule|event|email)\b/i,
    ],
    // Researcher
    [
        "researcher",
        /\b(research|investigate|find\s?out|look\s?up|compare|evaluate|survey|explore\s?options|alternatives|documentation|what\s+is|how\s+does|explain)\b/i,
    ],
    // Coder — broadest match, checked last
    [
        "coder",
        /\b(refactor|debug|fix|implement|code|function|class|api|endpoint|component|module|test|typescript|javascript|python|rust|go|compile|build|dependency|package|import|migrate|schema|database|query|sql|git|commit|branch|merge|pr)\b/i,
    ],
];

// ── Public API ───────────────────────────────────────────────────────

/** Get the full configuration for a given role. */
export function getRoleConfig(role: AgentRole): AgentRoleConfig {
    return ROLE_CONFIGS[role];
}

/** Get all available role configs. */
export function getAllRoleConfigs(): Record<AgentRole, AgentRoleConfig> {
    return { ...ROLE_CONFIGS };
}

/**
 * Detect the best-fit agent role from a task instruction.
 * Falls back to "coder" if no patterns match (most common delegation).
 */
export function detectRole(instruction: string): AgentRole {
    for (const [role, pattern] of ROLE_PATTERNS) {
        if (pattern.test(instruction)) return role;
    }
    return "coder"; // Default fallback
}

/**
 * Build the role-specific prompt section for injection into a delegation prompt.
 * Returns a formatted string with role identity, behavioral guidance, and output format.
 */
export function buildRolePromptSection(role: AgentRole): string {
    const config = ROLE_CONFIGS[role];
    const lines: string[] = [];

    lines.push(`## Agent Role: ${config.role.toUpperCase()}`);
    lines.push("");
    lines.push(`**Role**: ${config.description}`);
    lines.push("");
    lines.push(`### Behavioral Guidance`);
    lines.push(config.systemPromptSuffix);
    lines.push("");
    lines.push(`### Expected Output Format`);
    lines.push(config.outputGuidance);

    if (config.maxTurns) {
        lines.push("");
        lines.push(
            `### Turn Budget`
        );
        lines.push(
            `You have up to ${config.maxTurns} turns to complete this task. Be efficient.`
        );
    }

    return lines.join("\n");
}
