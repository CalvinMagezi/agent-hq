/**
 * Persistent lightweight chat session for Discord messages.
 * Uses Pi SDK with minimal tools (dispatch_job, check_job_status, local_context).
 * Handles conversational messages without spinning up a full agent session.
 */

import {
    createAgentSession,
    createBashTool,
    SettingsManager,
    type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import { createDispatchJobTool, createCheckJobStatusTool, type OnJobDispatched } from "./chatTools.js";
import { createGetBlastRadiusTool, createGetDependencyContextTool, createMapRepositoryTool } from "./codeGraphTools.js";
import { LoadSkillTool, ListSkillsTool, SkillLoader } from "../skills.js";
import { createSecuritySpawnHook, SecurityProfile } from "../governance.js";
import { buildModelConfig } from "./modelConfig.js";
import { logger } from "./logger.js";

export interface ChatSessionConfig {
    targetDir: string;
    workerId: string;
    modelId: string;
    openrouterApiKey?: string;
    geminiApiKey?: string;
    convexBaseUrl?: string;
    vaultClient?: any;
    apiKey?: string;
    contextFile: string;
}

export interface DiscordContext {
    channelId: string;
    isDM: boolean;
    onJobDispatched?: OnJobDispatched;
}

/**
 * Optional callbacks for streaming events.
 * Used by the WebSocket server to push real-time deltas to clients.
 * When omitted (e.g. Discord path), the session accumulates text internally.
 */
export interface StreamCallbacks {
    onDelta?: (delta: string) => void;
    onToolStart?: (toolName: string) => void;
    onToolEnd?: (toolName: string) => void;
}

const COMPACT_EVERY_N_MESSAGES = 20;

export class ChatSessionManager {
    private session: any | null = null;
    private messageCount: number = 0;
    private config: ChatSessionConfig;
    private isProcessing: boolean = false;
    private isFirstMessage: boolean = true;
    private discordContext: DiscordContext | null = null;

    constructor(config: ChatSessionConfig) {
        this.config = config;
    }

    /**
     * Set Discord context so dispatched jobs include channel info
     * and the Discord bot can track them for result delivery.
     */
    setDiscordContext(ctx: DiscordContext): void {
        this.discordContext = ctx;
        // Rebuild tools with new context — session will be recreated on next message
        this.session = null;
        this.isFirstMessage = true;
    }

    private buildTools(): AgentTool<any>[] {
        const { config } = this;

        const localContextSchema = Type.Object({
            action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
            content: Type.Optional(Type.String()),
        });

        const localContextTool: AgentTool<typeof localContextSchema> = {
            name: "local_context",
            description: "Read or write to the local persistent memory file. Use this to remember things across conversations.",
            parameters: localContextSchema,
            label: "Local Context",
            execute: async (_toolCallId, args) => {
                if (args.action === "read") {
                    if (!fs.existsSync(config.contextFile)) {
                        return { content: [{ type: "text", text: "No local context found." }], details: {} };
                    }
                    return { content: [{ type: "text", text: fs.readFileSync(config.contextFile, "utf-8") }], details: {} };
                } else {
                    fs.writeFileSync(config.contextFile, args.content || "");
                    return { content: [{ type: "text", text: "Context updated." }], details: {} };
                }
            },
        };

        const dispatchJobTool = createDispatchJobTool({
            baseUrl: config.convexBaseUrl,
            apiKey: config.apiKey,
            vaultClient: config.vaultClient,
            discordChannelId: this.discordContext?.channelId,
            discordIsDM: this.discordContext?.isDM,
            onJobDispatched: this.discordContext?.onJobDispatched,
        });

        const checkJobStatusTool = createCheckJobStatusTool({
            baseUrl: config.convexBaseUrl,
            apiKey: config.apiKey,
            vaultClient: config.vaultClient,
        });

        // Add secure bash tool with GUARDED profile (requires approval for dangerous commands)
        const spawnHook = createSecuritySpawnHook(
            SecurityProfile.GUARDED,
            (msg) => logger.info(`[Chat Bash Security] ${msg}`)
        );
        const bashTool = createBashTool(config.targetDir, { spawnHook });

        // Code-Graph tools — native wrappers for the vault graph functions
        const vaultPath = config.vaultClient?.vaultPath ?? config.targetDir;
        const getBlastRadiusTool = createGetBlastRadiusTool(vaultPath);
        const getDependencyContextTool = createGetDependencyContextTool(vaultPath);
        const mapRepositoryTool = createMapRepositoryTool(vaultPath);

        const tools = [
            localContextTool,
            bashTool,
            dispatchJobTool,
            checkJobStatusTool,
            // Skills
            LoadSkillTool,
            ListSkillsTool,
            // Code-Graph (Code Mode superpower)
            getBlastRadiusTool,
            getDependencyContextTool,
            mapRepositoryTool,
        ];
        logger.info("Chat tools built", { names: tools.map(t => t.name), count: tools.length });
        return tools;
    }

    /**
     * Handle a message. Returns the assistant's text response.
     * Creates the session lazily on first call.
     * Optional callbacks enable real-time streaming (used by WS server).
     */
    async handleMessage(text: string, callbacks?: StreamCallbacks): Promise<string> {
        // Prevent concurrent message processing
        if (this.isProcessing) {
            return "I'm still thinking about your previous message. Give me a moment!";
        }

        this.isProcessing = true;
        try {
            // Check for external orchestration mode
            if (this.config.vaultClient) {
                const context = await this.config.vaultClient.getAgentContext();
                if (context.config?.["orchestration_mode"] === "external") {
                    const intentId = await this.config.vaultClient.sendToCoo({
                        jobId: "",
                        instruction: text,
                        priority: 50,
                        metadata: {
                            discordChannelId: this.discordContext?.channelId,
                            discordIsDM: this.discordContext?.isDM,
                            source: "chat"
                        }
                    });
                    return `Message routed to external COO (Intent ID: ${intentId}). You will be notified when the response is ready.`;
                }
            }

            if (!this.session) {
                await this.createSession();
            }

            // Compact periodically to manage context window
            await this.maybeCompact();

            // Prepend system context to the first message
            let promptText = text;
            if (this.isFirstMessage) {
                promptText = await this.buildSystemContext() + "\n\nUser message: " + text;
                this.isFirstMessage = false;
            }

            // Subscribe to session events to capture the response
            const responseRef = { text: "" };
            const unsubscribe = this.subscribeToEvents(responseRef, callbacks);

            try {
                await this.session.prompt(promptText);
            } catch (error: any) {
                logger.warn("Chat session prompt failed, recreating session", { error: error.message });

                // Clean up old subscription
                if (typeof unsubscribe === "function") unsubscribe();

                // Recreate session and retry once
                this.session = null;
                await this.createSession();
                this.isFirstMessage = false; // Don't double-prepend system context
                responseRef.text = "";

                // Re-subscribe with new session
                const retryUnsubscribe = this.subscribeToEvents(responseRef, callbacks);
                try {
                    await this.session.prompt(promptText);
                } finally {
                    if (typeof retryUnsubscribe === "function") retryUnsubscribe();
                }
            }

            // Clean up subscription
            if (typeof unsubscribe === "function") unsubscribe();

            this.messageCount++;

            // If event-based capture didn't work, fall back to transcript extraction
            let finalResponse = responseRef.text;
            if (!finalResponse) {
                finalResponse = this.extractLastAssistantMessage();
            }

            return finalResponse || "I processed your message but couldn't capture my response. Please try again.";
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Check if the session is currently processing a message.
     */
    get busy(): boolean {
        return this.isProcessing;
    }

    /**
     * Reset the chat session (e.g., on "forget" or "reset" commands).
     */
    reset(): void {
        this.session = null;
        this.messageCount = 0;
        this.isFirstMessage = true;
        logger.info("Chat session reset");
    }

    /**
     * Subscribe to Pi SDK session events to capture assistant text deltas.
     * When StreamCallbacks are provided, forwards events for real-time streaming.
     * Returns an unsubscribe function.
     */
    private subscribeToEvents(responseRef: { text: string }, callbacks?: StreamCallbacks): (() => void) | undefined {
        try {
            return this.session.subscribe((event: AgentSessionEvent) => {
                if (event.type === "message_update") {
                    const assistantEvent = (event as any).assistantMessageEvent;
                    if (assistantEvent?.type === "text_delta") {
                        const delta = assistantEvent.delta || "";
                        responseRef.text += delta;
                        callbacks?.onDelta?.(delta);
                    }
                } else if (event.type === "tool_execution_start") {
                    const toolEvent = event as any;
                    const toolName = toolEvent.toolCall?.tool?.name || toolEvent.toolCall?.name || "tool";
                    callbacks?.onToolStart?.(toolName);
                } else if (event.type === "tool_execution_end") {
                    const toolEvent = event as any;
                    const toolName = toolEvent.toolCall?.tool?.name || toolEvent.toolCall?.name || "tool";
                    callbacks?.onToolEnd?.(toolName);
                }
            });
        } catch {
            // subscribe may not be available — transcript extraction will be used
            return undefined;
        }
    }

    private async buildSystemContext(): Promise<string> {
        // Auto-load existing local context for memory continuity
        let existingContext = "";
        try {
            if (fs.existsSync(this.config.contextFile)) {
                existingContext = fs.readFileSync(this.config.contextFile, "utf-8").trim();
            }
        } catch {
            // ignore read errors
        }

        // Load recent activity for cross-session continuity
        let recentActivity = "";
        try {
            if (this.config.vaultClient) {
                recentActivity = await this.config.vaultClient.getRecentActivityContext(15);
            }
        } catch {
            // Non-critical
        }

        // Load vault context (memory, preferences, pinned notes)
        let vaultContext = "";
        try {
            if (this.config.vaultClient) {
                const ctx = await this.config.vaultClient.getAgentContext();
                if (ctx.memory || ctx.preferences || ctx.pinnedNotes?.length > 0) {
                    const parts: string[] = [];
                    if (ctx.memory) {
                        parts.push(`## Memory\n${ctx.memory.substring(0, 500)}`);
                    }
                    if (ctx.preferences) {
                        parts.push(`## Preferences\n${ctx.preferences.substring(0, 300)}`);
                    }
                    if (ctx.pinnedNotes && ctx.pinnedNotes.length > 0) {
                        const pinnedSummary = ctx.pinnedNotes
                            .slice(0, 3)
                            .map((n: { title: string; content?: string }) => `- **${n.title}**: ${n.content?.substring(0, 100) || ""}`)
                            .join("\n");
                        parts.push(`## Pinned Notes\n${pinnedSummary}`);
                    }
                    vaultContext = parts.join("\n\n");
                }
            }
        } catch {
            // Non-critical
        }

        // Build available skills summary
        const skillsList = SkillLoader.loadAllSkills();

        const lines = [
            `[System context — do not repeat this verbatim to the user]`,
            `You are HQ, a personal AI assistant running on the user's local machine.`,
            `Working directory: ${this.config.targetDir}`,
            `Worker ID: ${this.config.workerId}`,
            `Current time: ${new Date().toLocaleString()}`,
            ``,
            `## YOUR TOOLS:`,
            `### Core`,
            `1. **bash** — Execute shell commands directly (ls, git, npm, cat, grep, etc.)`,
            `2. **dispatch_job** — Create background jobs for complex multi-step tasks`,
            `3. **check_job_status** — Check result of a dispatched job`,
            `4. **local_context** — Read/write your persistent memory file`,
            ``,
            `### Skills`,
            `5. **load_skill** — Load full instructions for a specialized domain (REQUIRED before using a skill)`,
            `6. **list_skills** — List all available skills`,
            ``,
            skillsList,
            ``,
            `### Code Mode (Graph-RAG superpowers)`,
            `7. **get_blast_radius** — Before touching any file, find every file that imports it (blast radius)`,
            `8. **get_dependency_context** — See what a file imports + what those files export`,
            `9. **map_repository** — Parse a TypeScript repo with ts-morph → generate Obsidian dependency graph`,
            ``,
            `## CODE MODE PROTOCOL:`,
            `When asked to modify code, ALWAYS:`,
            `1. Call get_blast_radius on the target file first`,
            `2. Call get_dependency_context to understand imports`,
            `3. If repo is not yet mapped, call map_repository first`,
            ``,
            `## WHEN USER ASKS TO RUN A COMMAND:`,
            `User: "echo hello"  →  You: Call bash({ command: "echo hello" })`,
            `User: "list files"  →  You: Call bash({ command: "ls -la" })`,
            `User: "git status"  →  You: Call bash({ command: "git status" })`,
            ``,
            `## CRITICAL RULES:`,
            `- Shell commands → ALWAYS use bash tool (not dispatch_job)`,
            `- Simple tasks → Use bash directly`,
            `- Complex multi-step tasks → Use dispatch_job`,
            `- NEVER say "I don't have a tool" — check the list above first`,
            `- Keep responses brief. Just execute what the user asks.`,
        ];

        if (existingContext) {
            lines.push(
                ``,
                `## Your persistent memory (from local_context):`,
                existingContext.length > 2000
                    ? existingContext.substring(0, 2000) + "\n...(truncated)"
                    : existingContext,
            );
        }

        if (recentActivity) {
            lines.push(
                ``,
                `## Recent Conversation History (for continuity)`,
                recentActivity,
            );
        }

        if (vaultContext) {
            lines.push(
                ``,
                `## Vault Context`,
                vaultContext,
            );
        }

        return lines.join("\n");
    }

    private async createSession(): Promise<void> {
        const { config } = this;

        const model = buildModelConfig({
            modelId: config.modelId,
            geminiApiKey: config.geminiApiKey,
            openrouterApiKey: config.openrouterApiKey,
        });

        const settingsManager = SettingsManager.inMemory({
            compaction: {
                enabled: true,
                reserveTokens: 2000,
                keepRecentTokens: 10000,
            },
            retry: {
                enabled: true,
                maxRetries: 2,
                baseDelayMs: 500,
                maxDelayMs: 10_000,
            },
        });

        const tools = this.buildTools();
        const { session } = await createAgentSession({
            tools: tools as any,
            model,
            settingsManager,
        });

        this.session = session;
        this.messageCount = 0;
        this.isFirstMessage = true;

        // Verify tools are accessible in session
        try {
            const activeTools = session.getActiveToolNames?.() || [];
            logger.info("Chat session created", {
                model: config.modelId,
                registeredTools: tools.map(t => t.name),
                activeTools: Array.isArray(activeTools) ? activeTools.map((t: any) => t.name || t) : "unknown",
            });
        } catch {
            logger.info("Chat session created", { model: config.modelId, tools: tools.length });
        }
    }

    private async maybeCompact(): Promise<void> {
        if (!this.session) return;

        try {
            const usage = this.session.getContextUsage?.();
            // Compact if high context usage OR many messages accumulated
            if ((usage && usage.percent > 50) || this.messageCount >= COMPACT_EVERY_N_MESSAGES) {
                await this.session.compact(
                    `Preserve: current working directory, recent dispatched job IDs, user preferences. ` +
                    `Discard: old greetings, redundant status checks.`
                );
                this.messageCount = 0;
                logger.info("Chat session compacted", { contextPercent: usage?.percent });
            }
        } catch (error: any) {
            logger.warn("Chat session compaction failed", { error: error.message });
        }
    }

    /**
     * Extract the last assistant message from the session transcript.
     * Fallback for when event-based capture doesn't work.
     */
    private extractLastAssistantMessage(): string {
        try {
            // Pi SDK's transcript is not public — use unsafe access
            const transcript = (this.session as any)?.transcript;
            if (!Array.isArray(transcript)) return "";

            // Find the last assistant message
            for (let i = transcript.length - 1; i >= 0; i--) {
                const msg = transcript[i];
                if (msg.role === "assistant" && typeof msg.content === "string") {
                    return msg.content;
                }
                // Handle structured content
                if (msg.role === "assistant" && Array.isArray(msg.content)) {
                    const textParts = msg.content
                        .filter((p: any) => p.type === "text")
                        .map((p: any) => p.text)
                        .join("");
                    if (textParts) return textParts;
                }
            }
        } catch {
            // transcript access may fail
        }
        return "";
    }
}
