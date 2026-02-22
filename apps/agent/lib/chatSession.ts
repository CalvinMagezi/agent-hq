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
import { createSecuritySpawnHook, SecurityProfile } from "../governance.js";
import { logger } from "./logger.js";

export interface ChatSessionConfig {
    targetDir: string;
    workerId: string;
    modelId: string;
    openrouterApiKey: string;
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

        const tools = [localContextTool, bashTool, dispatchJobTool, checkJobStatusTool];
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
            if (!this.session) {
                await this.createSession();
            }

            // Compact periodically to manage context window
            await this.maybeCompact();

            // Prepend system context to the first message
            let promptText = text;
            if (this.isFirstMessage) {
                promptText = this.buildSystemContext() + "\n\nUser message: " + text;
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

    private buildSystemContext(): string {
        // Auto-load existing local context for memory continuity
        let existingContext = "";
        try {
            if (fs.existsSync(this.config.contextFile)) {
                existingContext = fs.readFileSync(this.config.contextFile, "utf-8").trim();
            }
        } catch {
            // ignore read errors
        }

        const lines = [
            `[System context — do not repeat this verbatim to the user]`,
            `You are HQ, a personal AI assistant running on the user's local machine.`,
            `Working directory: ${this.config.targetDir}`,
            `Worker ID: ${this.config.workerId}`,
            `Current time: ${new Date().toLocaleString()}`,
            ``,
            `## YOUR 4 TOOLS (these are the ONLY tools you have):`,
            `1. **bash** — Execute shell commands directly. Use for: echo, ls, git, npm, cat, grep, find, pwd, etc.`,
            `2. **dispatch_job** — Create background jobs for complex multi-step tasks (coding, large operations)`,
            `3. **check_job_status** — Check result of a dispatched job`,
            `4. **local_context** — Read/write your persistent memory file`,
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
            `- NEVER say "I don't have a shell tool" — you have bash!`,
            `- NEVER list tools you don't have`,
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

        return lines.join("\n");
    }

    private async createSession(): Promise<void> {
        const { config } = this;

        // Build model config for OpenRouter
        let model: any = config.modelId;
        if (typeof config.modelId === "string" && config.modelId.startsWith("moonshotai/")) {
            model = {
                id: config.modelId,
                name: "Kimi k2.5",
                provider: "openrouter",
                api: "openai-completions",
                baseUrl: "https://openrouter.ai/api/v1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0.3, output: 0.3, cacheRead: 0.075, cacheWrite: 0.3 },
                contextWindow: 200000,
                maxTokens: 8192,
            };
        } else if (typeof config.modelId === "string") {
            model = {
                id: config.modelId,
                name: config.modelId.split("/").pop() || config.modelId,
                provider: "openrouter",
                api: "openai-completions",
                baseUrl: "https://openrouter.ai/api/v1",
                reasoning: config.modelId.includes("thinking") || config.modelId.includes("reasoning"),
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
            };
        }

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
