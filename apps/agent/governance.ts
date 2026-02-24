import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { BashSpawnContext } from "@mariozechner/pi-coding-agent";

export enum SecurityProfile {
    // Read-only access to safe resources
    MINIMAL = "minimal",
    // Can write code and execute safe commands
    STANDARD = "standard",
    // All tools allowed, but dangerous operations require approval
    GUARDED = "guarded",
    // Full system access (dangerous)
    ADMIN = "admin"
}

export type ToolPolicy = {
    [key in SecurityProfile]: string[]; // List of allowed tool names
};

// Default policies
export const DEFAULT_POLICIES: ToolPolicy = {
    [SecurityProfile.MINIMAL]: ["read", "ls", "find", "grep", "local_context", "mcp_bridge"],
    [SecurityProfile.STANDARD]: ["read", "ls", "find", "grep", "local_context", "mcp_bridge", "edit", "write"],
    [SecurityProfile.GUARDED]: ["*"], // All tools allowed, but some require approval
    [SecurityProfile.ADMIN]: ["*"] // All tools allowed
};

// Tool name sets for each security profile (for dynamic tool activation)
export const PROFILE_TOOL_NAMES: Record<SecurityProfile, string[] | "*"> = {
    [SecurityProfile.MINIMAL]: [
        "read", "ls", "find", "grep", "local_context", "mcp_bridge", "heartbeat",
        "list_skills", "load_skill",
        // Delegation: read-only monitoring
        "check_relay_health", "check_delegation_status", "get_live_task_output",
    ],
    [SecurityProfile.STANDARD]: [
        "read", "ls", "find", "grep", "local_context", "mcp_bridge", "heartbeat",
        "list_skills", "load_skill", "edit", "write",
        // Clarification protocol
        "chat_with_user", "draft_dispatch_plan", "build_prompt",
        // Delegation: full orchestration
        "delegate_to_relay", "check_relay_health", "check_delegation_status", "aggregate_results",
    ],
    [SecurityProfile.GUARDED]: "*",
    [SecurityProfile.ADMIN]: "*",
};

// Tools that require approval under the GUARDED profile
const APPROVAL_REQUIRED_TOOLS = new Set([
    "bash",
    "shell",
]);

// File operation tools that need approval for destructive patterns
const FILE_WRITE_TOOLS = new Set([
    "write",
    "edit",
]);

// Dangerous bash patterns that always require approval or blocking
export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
    // Destructive file operations
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive|--force)\b/i,
    /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b/i,

    // Multi-line injection attempts
    /\n\s*rm\s+-/i,
    /;\s*rm\s+-/i,
    /&&\s*rm\s+-/i,
    /\|\|\s*rm\s+-/i,

    // Command substitution
    /\$\(\s*rm\s+-/i,
    /`\s*rm\s+-/i,

    // Hex/octal encoding bypass prevention
    /\\x[0-9a-f]{2}/i,
    /\\[0-7]{3}/,

    // IFS injection
    /\$\{IFS\}/i,
    /\$IFS/i,

    // Privilege escalation
    /\bsudo\b/i,
    /\bchmod\s+777\b/,

    // Git force operations
    /\bgit\s+push\s+--force\b/i,
    /\bgit\s+push\s+-f\b/i,
    /\bgit\s+reset\s+--hard\b/i,

    // Database operations
    /\bdrop\s+table\b/i,
    /\bdelete\s+from\b/i,
    /\btruncate\s+/i,

    // Disk operations
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\b>\s*\/dev\/sd/i,
];

// Env vars that should never be leaked to child processes
const SENSITIVE_ENV_VARS = [
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "AGENTHQ_API_KEY",
    "MCP_GATEWAY_TOKEN",
    "DISCORD_BOT_TOKEN",
    "DISCORD_BOT_TOKEN_OPENCODE",
    "DISCORD_BOT_TOKEN_GEMINI",
];

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalResult = {
    approved: boolean;
    reason?: string;
};

export type ApprovalCallback = (
    toolName: string,
    args: unknown,
    riskLevel: RiskLevel,
) => Promise<ApprovalResult>;

/**
 * Creates a Pi SDK BashSpawnHook that intercepts commands BEFORE execution.
 * This is the first line of defense — runs at the process.spawn() level.
 *
 * - MINIMAL/STANDARD profiles: blocks all dangerous patterns
 * - GUARDED profile: logs commands (approval handled at tool level by ToolGuardian)
 * - ADMIN profile: logs only
 * - All profiles: strips sensitive env vars from child process
 */
export function createSecuritySpawnHook(
    profile: SecurityProfile,
    onLog?: (msg: string) => void,
): (ctx: BashSpawnContext) => BashSpawnContext {
    const log = onLog ?? console.log;

    return (ctx: BashSpawnContext): BashSpawnContext => {
        // Audit log all commands
        log(`[AUDIT] bash: ${ctx.command.substring(0, 200)}`);

        // Network Egress Audit
        const egressMatch = ctx.command.match(/\b(curl|wget|nc|ping|ssh)\b/i);
        if (egressMatch) {
            log(`[NETWORK EGRESS] Detected use of ${egressMatch[1]} in command: ${ctx.command.substring(0, 200)}`);
        }

        // Block dangerous patterns for non-admin, non-guarded profiles
        // (GUARDED handles this via approval flow in ToolGuardian instead)
        if (profile === SecurityProfile.MINIMAL || profile === SecurityProfile.STANDARD) {
            for (const pattern of DANGEROUS_BASH_PATTERNS) {
                if (pattern.test(ctx.command)) {
                    throw new Error(
                        `Security Error: Dangerous command blocked by spawn hook (${profile} profile): ${ctx.command.substring(0, 100)}`
                    );
                }
            }
        }

        // Strip sensitive env vars from child processes
        const sanitizedEnv = { ...ctx.env };
        for (const key of SENSITIVE_ENV_VARS) {
            delete sanitizedEnv[key];
        }

        return {
            ...ctx,
            env: sanitizedEnv,
        };
    };
}

/**
 * Assess the risk level of a tool invocation.
 */
function assessRisk(toolName: string, args: unknown): RiskLevel {
    const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? "");

    // Check bash/shell for dangerous patterns
    if (toolName === "bash" || toolName === "shell") {
        for (const pattern of DANGEROUS_BASH_PATTERNS) {
            if (pattern.test(argsStr)) {
                return "critical";
            }
        }
        return "medium";
    }

    // File writes are low risk by default
    if (FILE_WRITE_TOOLS.has(toolName)) {
        return "low";
    }

    return "low";
}

/**
 * Determine if a tool invocation requires approval under the GUARDED profile.
 */
function needsApproval(toolName: string, args: unknown): boolean {
    // Bash/shell always needs approval
    if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
        return true;
    }

    // File writes only need approval if they match dangerous patterns
    if (FILE_WRITE_TOOLS.has(toolName)) {
        const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? "");
        // Only flag file writes to sensitive paths
        if (/\/(etc|sys|proc|boot)\//i.test(argsStr)) {
            return true;
        }
    }

    return false;
}

export class ToolGuardian {
    private profile: SecurityProfile;
    private allowedTools: Set<string> | "ALL";
    private onApprovalRequired?: ApprovalCallback;

    private allowedPaths?: string[];

    constructor(
        profile: SecurityProfile = SecurityProfile.MINIMAL,
        policy: ToolPolicy = DEFAULT_POLICIES,
        onApprovalRequired?: ApprovalCallback,
        allowedPaths?: string[],
    ) {
        this.profile = profile;
        this.onApprovalRequired = onApprovalRequired;
        this.allowedPaths = allowedPaths;
        const allowed = policy[profile];
        if (allowed.includes("*")) {
            this.allowedTools = "ALL";
        } else {
            this.allowedTools = new Set(allowed);
        }
    }

    isAllowed(toolName: string): boolean {
        if (this.allowedTools === "ALL") return true;
        return this.allowedTools.has(toolName);
    }

    /**
     * Wraps a tool with permission checks and optional approval gates.
     */
    govern<T extends AgentTool<any>>(tool: T): T {
        const originalExecute = tool.execute;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const guardian = this;

        return {
            ...tool,
            execute: async (toolCallId, args, signal, onUpdate) => {
                if (!guardian.isAllowed(tool.name)) {
                    throw new Error(
                        `Security Error: Tool '${tool.name}' is not allowed under security profile '${guardian.profile}'.`,
                    );
                }

                // Path sandboxing for file writes
                if (guardian.allowedPaths && guardian.allowedPaths.length > 0 && FILE_WRITE_TOOLS.has(tool.name)) {
                    const argsObj = args as Record<string, any>;
                    const targetPath = argsObj?.file || argsObj?.path || argsObj?.filePath;
                    if (targetPath) {
                        const pathModule = require("path");
                        const resolvedTarget = pathModule.resolve(targetPath);
                        const isAllowed = guardian.allowedPaths.some(p => resolvedTarget.startsWith(pathModule.resolve(p)));
                        if (!isAllowed) {
                            throw new Error(`Security Error: Path ${resolvedTarget} is outside allowed directories.`);
                        }
                    }
                }

                // GUARDED profile: check if this invocation needs approval
                if (
                    guardian.profile === SecurityProfile.GUARDED &&
                    guardian.onApprovalRequired &&
                    needsApproval(tool.name, args)
                ) {
                    const riskLevel = assessRisk(tool.name, args);
                    const result = await guardian.onApprovalRequired(
                        tool.name,
                        args,
                        riskLevel,
                    );
                    if (!result.approved) {
                        const reason = result.reason || "User rejected the action";
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Action blocked: ${reason}. The user did not approve this operation.`,
                                },
                            ],
                            details: { blocked: true, reason },
                        };
                    }
                }

                return originalExecute.call(
                    tool,
                    toolCallId,
                    args,
                    signal,
                    onUpdate,
                );
            },
        } as T;
    }
}
