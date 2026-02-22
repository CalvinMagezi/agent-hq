import {
    createAgentSession,
    createCodingTools,
    createBashTool,
    type AgentSessionEvent,
    SettingsManager
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { AgentAdapter } from "@repo/vault-client/agent-adapter";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { ToolGuardian, SecurityProfile, DEFAULT_POLICIES, PROFILE_TOOL_NAMES, createSecuritySpawnHook, type ApprovalCallback } from "./governance.js";
import { LoadSkillTool, ListSkillsTool, SkillLoader } from "./skills.js";
import { loadDiscordConfig, type DiscordBot } from "./discordBot.js";
import { shouldFlushMemory, executeMemoryFlush, createFlushState, DEFAULT_FLUSH_OPTIONS } from "./lib/memoryFlush.js";
import { logger } from "./lib/logger.js";
import { ChatSessionManager } from "./lib/chatSession.js";
import { buildModelConfig } from "./lib/modelConfig.js";
import { AgentWsServer } from "./lib/wsServer.js";
import { PtyManager } from "./lib/ptyManager.js";
import { Orchestrator } from "./lib/orchestrator.js";
import { createDispatchParallelTasksTool } from "./lib/orchestrationTools.js";
import {
    initDelegationTools,
    setCurrentJob,
    DelegateToRelayTool,
    CheckRelayHealthTool,
    CheckDelegationStatusTool,
    AggregateResultsTool,
} from "./lib/delegationToolsVault.js";

dotenv.config({ path: ".env.local" });

// Load environment variables
const VAULT_PATH = process.env.VAULT_PATH || path.resolve(process.cwd(), "../../.vault");
const TARGET_DIR = process.env.TARGET_DIR || process.cwd();
const API_KEY = process.env.AGENTHQ_API_KEY || "local-master-key";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    console.warn("Warning: Neither OPENROUTER_API_KEY nor GEMINI_API_KEY is set. LLM calls will fail.");
} else {
    if (GEMINI_API_KEY) console.log("✓ GEMINI_API_KEY configured — Gemini models will use Google API directly");
    if (OPENROUTER_API_KEY) console.log("✓ OPENROUTER_API_KEY configured — non-Gemini models available via OpenRouter");
    if (!GEMINI_API_KEY) console.log("Note: GEMINI_API_KEY not set — Gemini models will route through OpenRouter");
}

const MODEL_ID = process.env.DEFAULT_MODEL || "gemini-2.5-flash";
const WORKER_ID_FILE = ".agent-hq-worker-id";
const CONTEXT_FILE = "agent-hq-context.md";
const SESSIONS_DIR = ".agent-hq-sessions";

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Get or generate Worker ID
let WORKER_ID = "";
if (fs.existsSync(WORKER_ID_FILE)) {
    WORKER_ID = fs.readFileSync(WORKER_ID_FILE, "utf-8").trim();
} else {
    WORKER_ID = `worker-${Math.random().toString(36).substring(2, 11)}`;
    fs.writeFileSync(WORKER_ID_FILE, WORKER_ID);
}

console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║         🤖 HQ Orchestrator Agent                       ║
║                                                        ║
║  Worker ID: ${WORKER_ID.padEnd(44)} ║
║  Mode: Orchestrator (delegates to relay bots)          ║
║  Status: Online and waiting for jobs                   ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
`);

logger.info("HQ Agent starting", { workerId: WORKER_ID, targetDir: TARGET_DIR, model: MODEL_ID });

// Initialize Vault Adapter (replaces ConvexClient)
const adapter = new AgentAdapter(VAULT_PATH);

// Initialize delegation tools with vault path
initDelegationTools(VAULT_PATH);

// ── Task Classification ─────────────────────────────────────────────
// Keywords that indicate the task is HQ-internal (not delegatable)
const HQ_INTERNAL_KEYWORDS = [
    "relay health", "relay status", "check relay", "relay diagnos",
    "setup relay", "configure relay", "restart relay", "stop relay",
    "hq config", "hq setup", "hq status", "bot connection", "bot token",
    "update config", "heartbeat", "worker status", "agent session",
    "local context", "memory flush", "skill", "mcp bridge",
];

function isHqInternalTask(instruction: string): boolean {
    const lower = instruction.toLowerCase();
    return HQ_INTERNAL_KEYWORDS.some((kw) => lower.includes(kw));
}

// Agent State
let isBusy = false;
let currentSession: any = null;
let currentJobId: string | null = null;
let lastProcessedJobId: string | null = null;
let lastJobStatus: string | null = null;
let lastJobUpdatedAt: number | null = null;
let rpcResult: any = null; // For RPC mode
let heartbeatInterval: NodeJS.Timeout | null = null;
let discordBot: DiscordBot | null = null;
let chatSession: ChatSessionManager | null = null;
let ptyManager: PtyManager | null = null;
let wsServer: AgentWsServer | null = null;
let orchestrator: Orchestrator | null = null;

// Exponential backoff state
let consecutiveFailures = 0;
const BACKOFF_SCHEDULE = [0, 30_000, 60_000, 300_000, 900_000, 3_600_000];
let backoffUntil = 0;

// Helper to cast 'any' for excessive type instantiation issues
const cast = <T>(value: any): T => value as T;


// --- Custom Tools Definitions ---

const LocalContextSchema = Type.Object({
    action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
    content: Type.Optional(Type.String())
});

const LocalContextTool: AgentTool<typeof LocalContextSchema> = {
    name: "local_context",
    description: "Read or write to the local persistent memory file (agent-hq-context.md). Use this to remember things across sessions.",
    parameters: LocalContextSchema,
    label: "Local Context",
    execute: async (toolCallId, args) => {
        if (args.action === "read") {
            if (!fs.existsSync(CONTEXT_FILE)) return { content: [{ type: "text", text: "No local context found." }], details: {} };
            return { content: [{ type: "text", text: fs.readFileSync(CONTEXT_FILE, "utf-8") }], details: {} };
        } else {
            fs.writeFileSync(CONTEXT_FILE, args.content || "");
            return { content: [{ type: "text", text: "Context updated." }], details: {} };
        }
    }
};

const HeartbeatSchema = Type.Object({
    action: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("append")]),
    content: Type.Optional(Type.String({ description: "New content for 'write', or text to append for 'append'" }))
});

const HeartbeatTool: AgentTool<typeof HeartbeatSchema> = {
    name: "heartbeat",
    description: "Read, write, or append to the HQ Heartbeat note. This note is processed by a server-side cron every 2 minutes — any actionable content will be dispatched as a background job to an available worker. Use 'write' to replace the entire content, 'append' to add a task, or 'read' to check current content.",
    parameters: HeartbeatSchema,
    label: "Heartbeat",
    execute: async (toolCallId, args) => {
        try {
            if (args.action === "read") {
                const context = await adapter.getAgentContext();
                const hb = context.find((n: any) => n.title === "Heartbeat");
                return { content: [{ type: "text", text: hb ? hb.content : "No heartbeat note found." }], details: {} };
            } else if (args.action === "write") {
                await adapter.updateSystemNote({
                    title: "Heartbeat",
                    content: args.content || ""
                });
                return { content: [{ type: "text", text: "Heartbeat note updated." }], details: {} };
            } else {
                await adapter.appendToSystemNote({
                    title: "Heartbeat",
                    content: args.content || ""
                });
                return { content: [{ type: "text", text: "Appended to heartbeat note." }], details: {} };
            }
        } catch (error: any) {
            return { content: [{ type: "text", text: `Heartbeat error: ${error.message}` }], details: { error } };
        }
    }
};

const MCPBridgeSchema = Type.Object({
    toolName: Type.String(),
    arguments: Type.Any()
});

const MCPBridgeTool: AgentTool<typeof MCPBridgeSchema> = {
    name: "mcp_bridge",
    description: "Call cloud-hosted MCP servers (Knowledge Graphs, Browser Tools) via the Convex MCP gateway.",
    parameters: MCPBridgeSchema,
    label: "MCP Bridge",
    execute: async (toolCallId, args) => {
        const mcpGatewayUrl = process.env.MCP_GATEWAY_URL || "";
        const mcpGatewayToken = process.env.MCP_GATEWAY_TOKEN;
        if (!mcpGatewayUrl || !mcpGatewayToken) {
            return { content: [{ type: "text", text: "MCP Bridge not configured: set MCP_GATEWAY_URL and MCP_GATEWAY_TOKEN env vars." }], details: {} };
        }
        const mcpUrl = mcpGatewayUrl;
        const authHeader = `Bearer ${mcpGatewayToken}`;

        try {
            const response = await fetch(mcpUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": authHeader,
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: {
                        name: args.toolName,
                        arguments: args.arguments,
                    },
                }),
            });
            const data: any = await response.json();
            const resultText = JSON.stringify(data.result || data.error || data);
            return { content: [{ type: "text", text: resultText }], details: { data } };
        } catch (error: any) {
            return { content: [{ type: "text", text: `MCP Error: ${error.message}` }], details: { error } };
        }
    }
};

const SubmitResultSchema = Type.Object({
    result: Type.Any()
});

const SubmitResultTool: AgentTool<typeof SubmitResultSchema> = {
    name: "submit_result",
    description: "Submit the final result of an RPC job. Use this ONLY when the user asks for a direct return value (RPC mode).",
    parameters: SubmitResultSchema,
    label: "Submit Result",
    execute: async (toolCallId, args) => {
        if (currentJobId) {
            rpcResult = args.result;
            return { content: [{ type: "text", text: "Result submitted. You may now stop." }], details: {} };
        }
        return { content: [{ type: "text", text: "Error: No active job." }], details: {} };
    }
};

// --- Interactive Chat Tool ---

const ChatWithUserSchema = Type.Object({
    message: Type.String({ description: "The message or question to ask the user" }),
    waitForResponse: Type.Optional(Type.Boolean({ description: "Whether to wait for the user to respond before continuing" }))
});

let pendingUserResponse: string | null = null;

const ChatWithUserTool: AgentTool<typeof ChatWithUserSchema> = {
    name: "chat_with_user",
    description: "Send a message to the user and optionally wait for a response. Use this to ask clarifying questions, confirm actions, or provide updates during long-running tasks. For interactive jobs, set waitForResponse=true to pause execution until the user replies.",
    parameters: ChatWithUserSchema,
    label: "Chat with User",
    execute: async (toolCallId, args) => {
        // Log the message
        console.log(`[Agent -> User]: ${args.message}`);
        
        // If we're in an interactive job and need to wait for a response
        if (args.waitForResponse && currentJobId) {
            // Update job status to waiting
            await adapter.updateJobStatus({
                jobId: currentJobId,
                status: "waiting_for_user" as any,
                conversationHistory: []
            });

            // Add to job logs
            await adapter.addJobLog({
                jobId: currentJobId,
                type: "info",
                content: `Agent: ${args.message}`,
            });

            // Wait for user response with polling
            pendingUserResponse = null;
            const startTime = Date.now();
            const timeout = 30 * 60 * 1000; // 30 minute timeout

            while (Date.now() - startTime < timeout) {
                // Check for user response
                const job = await adapter.getJob({ jobId: currentJobId });

                if (job && job.status === "running" && job.pendingUserMessage) {
                    pendingUserResponse = job.pendingUserMessage;
                    // Clear the pending message
                    await adapter.updateJobStatus({
                        jobId: currentJobId,
                        status: "running" as any,
                        conversationHistory: job.conversationHistory
                    });
                    break;
                }

                // Wait 500ms before checking again
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            if (pendingUserResponse) {
                return { 
                    content: [{ type: "text", text: pendingUserResponse }], 
                    details: { received: true, message: pendingUserResponse }
                };
            } else {
                return { 
                    content: [{ type: "text", text: "No response received within timeout period." }], 
                    details: { timeout: true }
                };
            }
        }
        
        // Non-blocking message
        return { 
            content: [{ type: "text", text: `Message sent to user: "${args.message}"` }], 
            details: { acknowledged: true }
        };
    }
};

async function setupAgent() {
    // 1. Initialize System Identity
    try {
        console.log("🧠 Initializing system identity...");
        await adapter.ensureSystemIdentity();
    } catch (err: any) {
        console.warn("⚠️ Failed to initialize system identity:", err.message);
    }

    // 2. Initial Heartbeat & Skill Sync
    try {
        const availableSkills = SkillLoader.listSkills();
        console.log(`📡 Registering worker in: ${TARGET_DIR}`);
        console.log(`🧩 Available skills: ${availableSkills.join(", ") || "None found"}`);

        await adapter.workerHeartbeat({
            workerId: WORKER_ID,
            status: "online",
            metadata: { type: "hq-agent", name: "HQ Agent", cwd: TARGET_DIR, folderName: path.basename(TARGET_DIR) }
        });

        // Sync skills on startup
        const skillEntries = availableSkills.map(name => {
            const skill = SkillLoader.getSkill(name);
            return { name, description: skill?.description };
        });
        await adapter.syncSkills({
            workerId: WORKER_ID,
            skills: skillEntries,
        });
    } catch (err: any) {
        console.error("❌ Initial heartbeat failed:", err.message);
    }

    // 3. Start Heartbeat Loop
    heartbeatInterval = setInterval(async () => {
        try {
            const status = isBusy ? "busy" : "online";
            await adapter.workerHeartbeat({
                workerId: WORKER_ID,
                status,
                metadata: { type: "hq-agent", name: "HQ Agent", cwd: TARGET_DIR, folderName: path.basename(TARGET_DIR) }
            });

            // Sync Discord presence
            await discordBot?.updatePresence(status);
        } catch (err: any) {
            console.error("Heartbeat failed:", err);
            logger.warn("Heartbeat failed", { error: err.message });
        }
    }, 10000); // 10 seconds

    // 4. Initialize Chat Session (shared brain for all clients: Discord, WebSocket, etc.)
    if (OPENROUTER_API_KEY || GEMINI_API_KEY) {
        chatSession = new ChatSessionManager({
            targetDir: TARGET_DIR,
            workerId: WORKER_ID,
            modelId: MODEL_ID,
            openrouterApiKey: OPENROUTER_API_KEY,
            geminiApiKey: GEMINI_API_KEY,
            vaultClient: adapter.client,
            apiKey: API_KEY,
            contextFile: CONTEXT_FILE,
        });
        console.log("💬 Chat session initialized (vault mode)");
    } else {
        console.log("⚠️  Chat session disabled (no API keys configured)");
    }

    // 5. Initialize Discord Bot (optional — only if settings are configured)
    try {
        discordBot = await loadDiscordConfig(adapter, API_KEY, "");
        if (discordBot) {
            await discordBot.start();

            // Give Discord the shared chat session
            if (chatSession) {
                discordBot.setChatSession(chatSession);
            }

            // Provide agent context to Discord bot for intent classifier
            discordBot.setAgentContext({
                targetDir: TARGET_DIR,
                workerId: WORKER_ID,
                isBusy: false,
            });
        } else {
            console.log("ℹ️  Discord bot not configured (set discord_bot_token in settings to enable)");
        }
    } catch (err: any) {
        console.warn("⚠️ Discord bot initialization failed:", err.message);
    }

    // 5. Initialize PtyManager for terminal orchestration
    ptyManager = new PtyManager(
        // onOutput: broadcast PTY data to WebSocket clients
        (sessionId, data) => {
            if (wsServer) {
                wsServer.broadcastBinary(sessionId, data);
            }
        },
        // onExit: update terminal status
        async (sessionId, exitCode) => {
            try {
                await adapter.updateTerminalStatus({
                    sessionId,
                    status: "exited",
                    exitCode,
                });
                if (wsServer) {
                    wsServer.broadcast({
                        type: "event",
                        event: "terminal.exit",
                        payload: { sessionId, exitCode },
                    });
                }
            } catch (err: any) {
                logger.error("Failed to update terminal exit status", {
                    sessionId,
                    exitCode,
                    error: err.message,
                });
            }
        }
    );
    console.log("🖥️  PTY Manager initialized");

    // 6b. Initialize Orchestrator for task DAG execution
    orchestrator = new Orchestrator(ptyManager, adapter as any, WORKER_ID);
    console.log("🎯 Orchestrator initialized");

    // 6. Start WebSocket server for web UI
    if (chatSession) {
        const wsPort = parseInt(process.env.WS_PORT || "5678", 10);
        wsServer = new AgentWsServer({
            port: wsPort,
            chatSession,
            agentContext: () => ({
                targetDir: TARGET_DIR,
                workerId: WORKER_ID,
                isBusy,
            }),
            ptyManager,
            convexMutate: async (name, args) => {
                // Route WebSocket mutations through adapter
                const [ns, fn] = name.split(":");
                const method = (adapter as any)[fn];
                if (typeof method === "function") return await method.call(adapter, args);
                console.warn(`Unknown mutation: ${name}`);
                return null;
            },
            convexQuery: async (name, args) => {
                // Route WebSocket queries through adapter
                const [ns, fn] = name.split(":");
                const method = (adapter as any)[fn];
                if (typeof method === "function") return await method.call(adapter, args);
                console.warn(`Unknown query: ${name}`);
                return null;
            },
        });
        wsServer.start();
        console.log(`🌐 WebSocket server on ws://127.0.0.1:${wsPort}`);
    }

    // 7. Subscribe to Jobs (file-based polling)
    console.log("📡 Listening for tasks...\n");

    const unsubscribe = adapter.onUpdate(
        null,
        { workerId: WORKER_ID },
        async (job: any) => {
            if (isBusy) return;
            if (Date.now() < backoffUntil) {
                const remainingS = Math.ceil((backoffUntil - Date.now()) / 1000);
                console.log(`⏳ Skipping job during backoff (${remainingS}s remaining)`);
                return;
            }
            if (job) {
                const isNewJob = job._id !== lastProcessedJobId;
                const isWaiting = job.status === "waiting_for_user";

                if (isNewJob || isWaiting) {
                    lastProcessedJobId = job._id;
                    lastJobStatus = job.status;
                    lastJobUpdatedAt = job.updatedAt;
                    await handleJob(job);
                }
            }
        }
    );

    // 8. Startup Catchup — check for pending jobs from offline period
    try {
        const pendingJob = await adapter.getPendingJob({
            workerId: WORKER_ID,
            workerSecret: "",
        });
        if (pendingJob && pendingJob.status === "pending") {
            console.log("📋 Found pending job from offline period, processing...");
            await handleJob(pendingJob);
        }
    } catch (err: any) {
        console.warn("⚠️ Startup catchup check failed:", err.message);
    }

    return unsubscribe;
}

// --- Handover Classification ---

/**
 * Determines if a job failure is recoverable by creating a follow-up job
 * with a fresh session. Only specific failure types qualify.
 */
function isHandoverableFailure(error: Error): boolean {
    const msg = error.message.toLowerCase();

    // Compaction failures — fresh session may fix
    if (msg.includes("compaction") && msg.includes("fail")) return true;

    // Context overflow — fresh session starts clean
    if (msg.includes("context") && (msg.includes("too large") || msg.includes("exceeded"))) return true;

    // Role ordering conflicts — fresh transcript avoids
    if (msg.includes("role") && msg.includes("order")) return true;

    // Do NOT handover: auth errors, permission errors, safety breaker
    if (msg.includes("invalid") && msg.includes("key")) return false;
    if (msg.includes("security error")) return false;
    if (msg.includes("safety breaker")) return false;

    return false;
}

// --- Job Handling & Recovery ---

async function handleJob(job: any) {
    if (isBusy) return;
    isBusy = true;
    currentJobId = job._id;

    // Update Discord presence and agent context
    await discordBot?.updatePresence("busy");
    discordBot?.setAgentContext({
        targetDir: TARGET_DIR,
        workerId: WORKER_ID,
        isBusy: true,
        currentJobInstruction: job.instruction,
    });

    try {
        // Try to claim the job - this will fail if another worker grabbed it
        try {
            await adapter.updateJobStatus({
                jobId: job._id,
                status: "running" as any,
            });
        } catch (claimError: any) {
            // Claim failures (another worker grabbed it) should not trigger backoff
            console.log(`⚡ Job already claimed by another worker, skipping.`);
            isBusy = false;
            currentJobId = null;
            return;
        }

        console.log(`\n💬 New task received: "${job.instruction}"\n`);
        logger.info("Job started", { jobId: job._id, type: job.type, instruction: job.instruction.substring(0, 100) });

        // Check if this is a terminal-only job (no Pi SDK processing needed)
        // Terminal jobs are marked with orchestrationType: "single" or instruction starts with [TERMINAL]
        const isTerminalOnly = job.orchestrationType === "single" || job.instruction.startsWith("[TERMINAL]");

        if (isTerminalOnly) {
            console.log("🖥️  Terminal-only job detected. Waiting for WebSocket terminal connection...");
            console.log("   (This job will be handled by PTY terminal, not Pi SDK)");

            // Notify Discord of job start
            if (discordBot) {
                void discordBot.sendJobEvent({
                    type: "started",
                    jobId: job._id,
                    instruction: job.instruction.replace("[TERMINAL] ", ""),
                });
            }

            // Keep job running so terminal can connect, but don't process with Pi SDK
            // The terminal will handle all execution via PTY
            // Job will be marked as done when terminal exits
            isBusy = false;
            currentJobId = null;
            return;
        }

        console.log("Assistant: ");

        // Notify Discord of job start
        if (discordBot) {
            void discordBot.sendJobEvent({
                type: "started",
                jobId: job._id,
                instruction: job.instruction,
            });
        }

        // Setup Governance & Tools — use per-job profile if specified, default GUARDED
        const profileMap: Record<string, SecurityProfile> = {
            minimal: SecurityProfile.MINIMAL,
            standard: SecurityProfile.STANDARD,
            guarded: SecurityProfile.GUARDED,
            admin: SecurityProfile.ADMIN,
        };
        const securityProfile = profileMap[job.securityProfile || ""] || SecurityProfile.GUARDED;

        const onApprovalRequired: ApprovalCallback = async (toolName, args, riskLevel) => {
            const argsPreview = typeof args === "string"
                ? args.substring(0, 200)
                : JSON.stringify(args ?? {}).substring(0, 200);

            console.log(`\n🛡️ Approval required for '${toolName}' (${riskLevel} risk)`);

            try {
                // Create approval in vault
                const approvalId = await adapter.client.createApproval({
                    title: `${toolName}: ${argsPreview}`,
                    description: `The agent wants to execute '${toolName}' with args: ${argsPreview}`,
                    toolName,
                    toolArgs: args as Record<string, any>,
                    riskLevel,
                    jobId: job._id,
                    timeoutMinutes: 10,
                });

                console.log(`⏳ Waiting for approval (ID: ${approvalId})...`);

                // Poll for decision
                const POLL_INTERVAL = 2000;
                const TIMEOUT = 10 * 60 * 1000; // 10 minutes
                const startTime = Date.now();

                while (Date.now() - startTime < TIMEOUT) {
                    const approval = await adapter.client.getApproval(approvalId);

                    if (approval && approval.status !== "pending") {
                        if (approval.status === "approved") {
                            console.log(`✅ Approved!`);
                            return { approved: true, reason: undefined };
                        } else {
                            console.log(`❌ Rejected: ${approval.rejectionReason || "No reason"}`);
                            return { approved: false, reason: approval.rejectionReason };
                        }
                    }

                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
                }

                console.log(`⏰ Approval timed out`);
                return { approved: false, reason: "Approval request timed out" };
            } catch (err: any) {
                console.error(`Approval error: ${err.message}`);
                return { approved: false, reason: `Approval error: ${err.message}` };
            }
        };

        const guardian = new ToolGuardian(securityProfile, DEFAULT_POLICIES, onApprovalRequired);

        // Create bash tool with security spawn hook (intercepts commands BEFORE execution)
        const spawnHook = createSecuritySpawnHook(securityProfile, (msg) => logger.info(msg));
        const secureBashTool = createBashTool(TARGET_DIR, { spawnHook });

        // Use secure bash tool + all other coding tools (read, edit, write, find, grep, ls)
        const codingToolsWithoutBash = createCodingTools(TARGET_DIR).filter((t: any) => t.name !== "bash");

        // Create dispatch_parallel_tasks tool with orchestrator callback
        const dispatchParallelTasksTool = createDispatchParallelTasksTool(
            async (taskPlan, jobId) => {
                // Store task plan in vault
                await adapter.updateTaskPlan({
                    jobId: job._id,
                    taskPlan,
                });

                // Execute the plan via orchestrator
                if (!orchestrator) {
                    throw new Error("Orchestrator not initialized");
                }
                await orchestrator.executePlan(
                    job._id,
                    job.userId,
                    taskPlan,
                    TARGET_DIR
                );
            }
        );

        // Set current job context for delegation tools
        setCurrentJob(job._id, job.userId);

        // Classify task: HQ-internal (uses local tools) vs delegatable (uses relay orchestration)
        const isHqTask = isHqInternalTask(job.instruction);
        logger.info("Task classification", { jobId: job._id, isHqInternal: isHqTask, instruction: job.instruction.substring(0, 80) });

        const rawTools: AgentTool<any>[] = isHqTask
            ? [
                // HQ-internal: full local tools + relay monitoring
                LocalContextTool,
                HeartbeatTool,
                MCPBridgeTool,
                LoadSkillTool,
                ListSkillsTool,
                ChatWithUserTool,
                dispatchParallelTasksTool,
                secureBashTool,
                ...codingToolsWithoutBash,
                CheckRelayHealthTool,
                DelegateToRelayTool,
              ]
            : [
                // Delegatable: orchestration tools only (no local execution)
                LocalContextTool,
                HeartbeatTool,
                MCPBridgeTool,
                ChatWithUserTool,
                DelegateToRelayTool,
                CheckRelayHealthTool,
                CheckDelegationStatusTool,
                AggregateResultsTool,
              ];

        if (job.type === "rpc") {
            rawTools.push(SubmitResultTool);
        }

        const governedTools = rawTools.map(tool => guardian.govern(tool));

        const settingsManager = SettingsManager.inMemory({
            compaction: {
                enabled: true,
                reserveTokens: 4000,
                keepRecentTokens: 20000
            },
            retry: {
                enabled: true,
                maxRetries: 3,
                baseDelayMs: 500,
                maxDelayMs: 30_000
            }
        });

        // Determine Model — per-job override takes priority, then env default
        const effectiveModelId = job.modelOverride || MODEL_ID;

        // Scan folder for project context to provide better grounding
        let folderContent = "";
        try {
            const files = fs.readdirSync(TARGET_DIR);
            folderContent = files.slice(0, 20).join(", ");
            if (files.length > 20) folderContent += "...";
        } catch (_e) {
            // Ignore folder read errors - not critical
        }

        const model = buildModelConfig({
            modelId: effectiveModelId,
            geminiApiKey: GEMINI_API_KEY,
            openrouterApiKey: OPENROUTER_API_KEY,
        });

        if (job.modelOverride) {
            logger.info("Job model override", { jobId: job._id, model: job.modelOverride, provider: model.provider });
        }

        // Create Session — pass per-job thinkingLevel if specified
        const sessionOptions: any = {
            tools: cast(governedTools),
            model: model,
            settingsManager: settingsManager
        };
        if (job.thinkingLevel) {
            sessionOptions.thinkingLevel = job.thinkingLevel;
            logger.info("Job thinking level", { jobId: job._id, thinkingLevel: job.thinkingLevel });
        }
        const { session } = await createAgentSession(sessionOptions);

        currentSession = session;

        // Dynamic tool activation based on security profile
        const profileToolNames = PROFILE_TOOL_NAMES[securityProfile];
        if (profileToolNames !== "*") {
            try {
                session.setActiveToolsByName(profileToolNames);
                logger.info("Tools restricted by profile", { profile: securityProfile, tools: profileToolNames });
            } catch (e) {
                // setActiveToolsByName may not be available on all Pi SDK versions
                logger.warn("Dynamic tool activation not supported", { error: (e as Error).message });
            }
        }

        // Strictly sequential logging for terminal and streaming text for web
        let currentAgentText = "";
        let lastUpdateTime = 0;
        let toolCallCount = 0;
        const MAX_TOOL_CALLS = 20; // Safety breaker
        const UPDATE_THROTTLE_MS = 200;

        const syncStreamingText = async (force = false) => {
            const now = Date.now();
            if (!force && now - lastUpdateTime < UPDATE_THROTTLE_MS) return;
            lastUpdateTime = now;

            try {
                await adapter.updateJobStreamingText({
                    jobId: job._id,
                    streamingText: currentAgentText,
                });
            } catch (_e) {
                // Ignore streaming text update errors
            }
        };

        const logQueue: any[] = [];
        let isFlushing = false;
        const processLogQueue = async () => {
            if (isFlushing || logQueue.length === 0) return;
            isFlushing = true;
            while (logQueue.length > 0) {
                const event = logQueue.shift();
                try {
                    await adapter.addJobLog({
                        jobId: job._id,
                        type: event.type,
                        content: JSON.stringify(event),
                    });
                } catch (_e) {
                    // Ignore log queue flush errors
                }
            }
            isFlushing = false;
        };

        // --- Event Listeners ---
        session.subscribe(async (event: AgentSessionEvent) => {
            const eventType = event.type as string;
            
            // 1. Stream to Console and accumulate for web
            if (eventType === "message_update") {
                const updateEvent = event as any;
                if (updateEvent.assistantMessageEvent?.type === "text_delta") {
                    const delta = updateEvent.assistantMessageEvent.delta;
                    process.stdout.write(delta);
                    currentAgentText += delta;
                    void syncStreamingText();
                }
            } else if (eventType === "message_stop") {
                process.stdout.write("\n\n");
                // Commit to history
                await syncStreamingText(true);
                await adapter.commitStreamingText({
                    jobId: job._id,
                });
                currentAgentText = "";

                // Log context usage for observability
                try {
                    const usage = session.getContextUsage?.();
                    if (usage && usage.percent != null) {
                        void adapter.addJobLog({
                            jobId: job._id,
                            type: "context_usage",
                            content: `Context: ${usage.tokens}/${usage.contextWindow} tokens (${Math.round(usage.percent)}%)`,
                            metadata: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent },
                        });

                        if (usage.percent > 70) {
                            console.log(`⚠️  Context usage: ${Math.round(usage.percent)}%`);
                            void adapter.addJobLog({
                                jobId: job._id,
                                type: "warning",
                                content: `High context usage: ${Math.round(usage.percent)}% — compaction may trigger soon`,
                            });
                        }
                    }
                } catch (e) {
                    // Context usage is best-effort
                }
            } else if (eventType === "tool_execution_start") {
                const toolEvent = event as any;
                const toolName = toolEvent.toolCall?.tool?.name || toolEvent.toolCall?.name || "tool";
                const toolArgs = JSON.stringify(toolEvent.toolCall?.arguments || {});
                console.log(`\n[🛠️ Tool Call]: ${toolName} -> ${toolArgs.substring(0, 100)}${toolArgs.length > 100 ? "..." : ""}`);
                
                toolCallCount++;
                if (toolCallCount > MAX_TOOL_CALLS) {
                    console.error("\n🛑 SAFETY BREAKER: Too many tool calls. Aborting to save tokens.");
                    await session.abort();
                    throw new Error("Safety breaker: Maximum tool call limit reached.");
                }
            } else if (eventType === "tool_execution_end") {
                const toolEvent = event as any;
                if (toolEvent.toolResult?.error) {
                    console.log(`[❌ Tool Error]: ${toolEvent.toolResult.error}`);
                } else {
                    console.log(`[✅ Tool Complete]`);
                }

                // Check for cancellation or steering on every tool completion
                try {
                    const latestJob = await adapter.getJob({ jobId: job._id });
                    if (latestJob) {
                        // Job cancellation
                        if (latestJob.status === "cancelled") {
                            console.log("\n❌ Job cancelled by user");
                            logger.info("Job cancelled by user", { jobId: job._id });
                            await session.abort();
                            throw new Error("Job cancelled by user");
                        }
                        // Mid-job steering
                        if (latestJob.steeringMessage) {
                            console.log(`\n🎯 Steering: ${latestJob.steeringMessage}`);
                            logger.info("Job steered", { jobId: job._id, message: latestJob.steeringMessage });
                            await session.steer(latestJob.steeringMessage);
                            // Clear steering message
                            await adapter.clearSteeringMessage({
                                jobId: job._id,
                            });
                        }
                        // Mid-job thinking level change
                        if (latestJob.thinkingLevel && typeof session.setThinkingLevel === "function") {
                            const currentLevel = session.thinkingLevel;
                            if (currentLevel !== latestJob.thinkingLevel) {
                                console.log(`\n🧠 Thinking level: ${currentLevel} → ${latestJob.thinkingLevel}`);
                                logger.info("Thinking level changed mid-job", { jobId: job._id, from: currentLevel, to: latestJob.thinkingLevel });
                                session.setThinkingLevel(latestJob.thinkingLevel);
                            }
                        }
                    }
                } catch (e: any) {
                    if (e.message === "Job cancelled by user") throw e;
                    // Non-fatal: cancellation/steer/thinking check failed, continue execution
                }
            } else if (eventType === "auto_retry_start") {
                const retryEvent = event as any;
                const msg = `Retry ${retryEvent.attempt}/${retryEvent.maxAttempts} after ${retryEvent.delayMs}ms: ${retryEvent.errorMessage}`;
                console.log(`\n⚠️  ${msg}`);
                logger.warn(msg, { jobId: job._id, attempt: retryEvent.attempt });
            } else if (eventType === "auto_retry_end") {
                const retryEvent = event as any;
                if (retryEvent.success) {
                    console.log(`✅ Retry succeeded on attempt ${retryEvent.attempt}`);
                } else {
                    console.log(`❌ All retries exhausted: ${retryEvent.finalError || "unknown error"}`);
                    logger.error("All retries exhausted", { jobId: job._id, finalError: retryEvent.finalError });
                }
            }

            // Queue other events for Terminal View
            if (eventType !== "message_update") {
                logQueue.push(event);
                void processLogQueue();
            }
            
            // Periodic State Sync (Throttled)
            if (eventType === "message_stop" || eventType === "tool_execution_end") {
                await syncSessionState(session, job._id);
            }
        });

        // Build prompt
        const preloadedSkills = isHqTask ? SkillLoader.loadAllSkills() : "";
        const autoLoadedSkillContent = isHqTask ? SkillLoader.getAutoLoadedContent() : "";
        let promptText = job.pendingUserMessage || job.instruction;

        // Fetch Pinned Context from vault
        let pinnedContext = "";
        try {
            const contextData = await adapter.getAgentContext();
            if (contextData && contextData.length > 0) {
                pinnedContext = "# PERSISTENT CONTEXT\n\n" +
                    contextData.map((c: any) => `## ${c.title}\n${c.content}`).join("\n\n");
            }
        } catch (e) {
            console.warn("⚠️ Failed to load pinned context");
        }

        // Build conversation history for interactive jobs
        let historyBlock = "";
        if (job.type === "interactive" && job.conversationHistory && job.conversationHistory.length > 0) {
            const history = job.pendingUserMessage ? job.conversationHistory.slice(0, -1) : job.conversationHistory.slice(0, -1);
            const historyText = history.length > 0
                ? history.map((msg: any) => `${msg.role === "user" ? "User" : "Agent"}: ${msg.content}`).join("\n")
                : "No previous conversation.";
            historyBlock = `\n# CONVERSATION HISTORY\n${historyText}\n`;
        }

        if (isHqTask) {
            // HQ-internal task: executor prompt with full local tools
            promptText = `SYSTEM INFO:
Working Directory: ${TARGET_DIR}
Contents: ${folderContent}

# CORE OPERATING RULES
1. **Never Hallucinate Actions**: If you say you are creating a file or running a command, you MUST call the tool to do it. Never just describe the outcome.
2. **Mandatory Verification**: After creating a file or running a command, you MUST verify it (e.g., list the directory or read the file) before telling the user it is done.
3. **Be Surgical**: When editing files, find the exact string and replace it. Do not rewrite entire files unless necessary.
4. **Load Skills First**: If a task matches an available skill, call 'load_skill' BEFORE taking any other action.

${pinnedContext}

${preloadedSkills}
${autoLoadedSkillContent}
${historyBlock}
# ${job.type === "interactive" ? "CURRENT TASK" : "USER INSTRUCTION"}
${promptText}

IMPORTANT: Verify your work with tools before responding.`;
        } else {
            // Delegatable task: orchestrator prompt — delegate to relay bots
            promptText = `SYSTEM INFO:
Working Directory: ${TARGET_DIR}
Job ID: ${job._id}

# YOU ARE THE HQ ORCHESTRATOR

You coordinate work across Discord relay agents. You do NOT execute code or file operations directly.
Your role is to analyze tasks, check relay health, delegate work, monitor progress, and aggregate results.

## Your Workflow
1. **Analyze** the incoming task
2. **Check relay health** with check_relay_health to see which relays are available
3. **Break down** complex tasks into subtasks if needed
4. **Delegate** using delegate_to_relay — choose the right relay type:
   - **claude-code**: Code editing, git operations, debugging, complex refactoring
   - **opencode**: Multi-model queries, quick code generation
   - **gemini-cli**: Research, analysis, summarization, large context processing
   - **any**: Auto-select the healthiest available relay
5. **Monitor** with check_delegation_status (poll every few seconds)
6. **Aggregate** results with aggregate_results when all tasks complete
7. **Report** a synthesized response to the user

## Self-Execute ONLY For
- Relay health monitoring and diagnostics
- HQ configuration and setup
- Memory and context management

## Rules
- ALWAYS check relay health before delegating
- NEVER try to write code or run bash commands — delegate those tasks
- If no relays are available, inform the user and suggest starting the discord-relay process
- For complex tasks, break them into parallel subtasks with clear instructions
- Include relevant context in each task's instruction so relays have full information

${pinnedContext}
${historyBlock}
# ${job.type === "interactive" ? "CURRENT TASK" : "USER INSTRUCTION"}
${promptText}

Remember: You are the ORCHESTRATOR. Delegate the work, monitor progress, and report results.`;
        }

        // Pre-compaction: uses session.compact() with context-aware instructions
        const memoryFlushState = createFlushState();
        if (shouldFlushMemory(session, memoryFlushState, DEFAULT_FLUSH_OPTIONS)) {
            await executeMemoryFlush(session, memoryFlushState, (msg) => {
                console.log(msg);
                logger.info(msg);
            }, job.type || "background", job.instruction);
        }

        // Run the Agent — Pi SDK handles retry internally via SettingsManager.retry config
        // auto_retry_start/auto_retry_end events are emitted and logged via the event handler
        await session.prompt(promptText);
        
        // Final completion message for interactive mode
        if (job.type === "interactive" && !currentAgentText.toLowerCase().includes("completed")) {
            const completionMsg = "\n\n✓ Task completed. Let me know if you need anything else!";
            process.stdout.write(completionMsg);
            currentAgentText += completionMsg;
        }

        // AUTO-MEMORY: Store a brief summary of the work in the Memory note
        try {
            const workSummary = `- [${new Date().toLocaleTimeString()}] Task: ${job.instruction.substring(0, 50)}${job.instruction.length > 50 ? "..." : ""} Status: ${currentAgentText.includes("✓") ? "Success" : "Finished"}`;
            await adapter.appendToSystemNote({
                title: "Memory",
                content: workSummary
            });
        } catch (e) {
            // Memory note might not exist yet, ignore
        }

        await syncStreamingText(true);
        await adapter.commitStreamingText({
            jobId: job._id,
        });
        currentAgentText = "";

        // Capture Pi SDK session stats for observability
        let jobStats: any = undefined;
        try {
            const piStats = session.getSessionStats?.();
            if (piStats) {
                jobStats = {
                    tokens: {
                        input: piStats.tokens?.input ?? 0,
                        output: piStats.tokens?.output ?? 0,
                        cacheRead: piStats.tokens?.cacheRead ?? 0,
                        total: piStats.tokens?.total ?? 0,
                    },
                    cost: piStats.cost ?? 0,
                    toolCalls: piStats.toolCalls ?? 0,
                    messages: piStats.totalMessages ?? 0,
                };
                logger.info("Job stats", { jobId: job._id, ...jobStats });
            }
        } catch (e) {
            // Stats are best-effort
        }

        // Finalize job status
        await adapter.updateJobStatus({
            jobId: job._id,
            status: "done" as any,
            result: rpcResult,
            stats: jobStats,
        });

        lastJobStatus = "done";
        lastJobUpdatedAt = Date.now();
        consecutiveFailures = 0;
        backoffUntil = 0;

        if (job.type !== "interactive") console.log("\n✓ Task completed");
        logger.info("Job completed", { jobId: job._id, type: job.type, stats: jobStats });

        // Notify Discord of job completion
        if (discordBot) {
            void discordBot.sendJobEvent({
                type: "completed",
                jobId: job._id,
                instruction: job.instruction,
            });
        }
    } catch (error: any) {
        const errorMsg = error.message || String(error);
        const isCancellation = errorMsg.includes("cancelled by user");

        if (isCancellation) {
            // Cancelled jobs: don't backoff, don't handover, just mark as cancelled
            console.log("\n🚫 Job cancelled");
            logger.info("Job cancelled", { jobId: job._id });
            lastJobStatus = "cancelled";
            lastJobUpdatedAt = Date.now();
            // Status already set to "cancelled" by the cancelJob mutation
            await adapter.addJobLog({ jobId: job._id, type: "info", content: "Job cancelled by user" });
        } else {
            console.error("\n❌ Error:", errorMsg);
            logger.error("Job failed", { jobId: job._id, error: errorMsg });
            lastJobStatus = "failed";
            lastJobUpdatedAt = Date.now();

            consecutiveFailures++;
            const backoffMs = BACKOFF_SCHEDULE[Math.min(consecutiveFailures, BACKOFF_SCHEDULE.length - 1)];
            backoffUntil = Date.now() + backoffMs;
            if (backoffMs > 0) {
                console.log(`⏳ Backing off ${backoffMs / 1000}s after ${consecutiveFailures} consecutive failure(s)`);
                logger.info(`Backing off ${backoffMs / 1000}s`, { consecutiveFailures });
            }

            await adapter.updateJobStatus({ jobId: job._id, status: "failed" as any });
            await adapter.addJobLog({ jobId: job._id, type: "error", content: errorMsg });
        }

        // Task handover: only for recoverable failures, NOT cancellations
        if (!isCancellation && isHandoverableFailure(error)) {
            try {
                const newJobId = await adapter.createFollowUpJob({
                    instruction: errorMsg,
                    parentJobId: job._id,
                });
                console.log(`🔄 Created follow-up job: ${newJobId}`);
                logger.info("Created follow-up job", { originalJobId: job._id, newJobId, reason: errorMsg });
            } catch (handoverErr: any) {
                console.warn("⚠️  Failed to create follow-up job:", handoverErr.message);
                logger.warn("Follow-up job creation failed", { error: handoverErr.message });
            }
        }

        // Notify Discord of job failure/cancellation
        if (discordBot) {
            void discordBot.sendJobEvent({
                type: isCancellation ? "cancelled" : "failed",
                jobId: job._id,
                instruction: job.instruction,
                error: isCancellation ? "Cancelled by user" : errorMsg,
            });
        }
    } finally {
        isBusy = false;
        currentJobId = null;
        currentSession = null;
        rpcResult = null;
        setCurrentJob(null, null); // Clear delegation context

        // Update Discord presence and agent context back to idle
        await discordBot?.updatePresence("online");
        discordBot?.setAgentContext({
            targetDir: TARGET_DIR,
            workerId: WORKER_ID,
            isBusy: false,
        });
    }
}

// --- Helper Functions ---

async function syncSessionState(session: any, jobId: string) {
    try {
        const sessionFile = session.sessionFile;
        if (typeof sessionFile === 'string' && fs.existsSync(sessionFile)) {
            await adapter.workerHeartbeat({
                workerId: WORKER_ID,
                status: "busy",
            });
            await adapter.updateJobStatus({
                jobId: jobId,
                status: "running" as any,
            });
        }
    } catch (err) {
        console.warn("Failed to sync session state:", err);
    }
}

// --- Signal Handlers ---
let shutdownAttempted = false;
async function shutdown() {
    if (shutdownAttempted) {
        console.log("\n🛑 Force exiting...");
        process.exit(1);
    }
    shutdownAttempted = true;
    
    console.log("\n👋 Shutting down...");
    logger.info("Agent shutting down", { workerId: WORKER_ID });
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    // Stop PTY Manager
    if (ptyManager) {
        ptyManager.shutdown();
    }

    // Stop WebSocket server
    if (wsServer) {
        wsServer.stop();
    }

    // Update Discord presence to offline before stopping
    if (discordBot) {
        await discordBot.updatePresence("offline");
        await discordBot.stop();
    }

    if (isBusy && currentJobId && currentSession) {
        console.log(`💾 Saving state for active job...`);
        await syncSessionState(currentSession, currentJobId);
    }

    try {
        await adapter.workerHeartbeat({
            workerId: WORKER_ID,
            status: "offline",
        });
    } catch (_e) {
        // Ignore offline heartbeat errors during shutdown
    }

    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Entry Point ---
setupAgent().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
