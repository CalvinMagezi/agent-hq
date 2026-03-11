/**
 * Custom agent tools — LocalContext, Heartbeat, MCPBridge, SubmitResult, ChatWithUser.
 *
 * These tools interact with the agent's local state and vault adapter.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import type { AgentAdapter } from "@repo/vault-client/agent-adapter";

// ─── State shared with index.ts ─────────────────────────────────────

/** Mutable state injected from index.ts so tools can read/write job context. */
export interface AgentToolState {
    currentJobId: string | null;
    rpcResult: any;
    pendingUserResponse: string | null;
}

// ─── LocalContext Tool ──────────────────────────────────────────────

const LocalContextSchema = Type.Object({
    action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
    content: Type.Optional(Type.String())
});

export function createLocalContextTool(contextFile: string): AgentTool<typeof LocalContextSchema> {
    return {
        name: "local_context",
        description: "Read or write to the local persistent memory file (agent-hq-context.md). Use this to remember things across sessions.",
        parameters: LocalContextSchema,
        label: "Local Context",
        execute: async (_toolCallId, args) => {
            if (args.action === "read") {
                if (!fs.existsSync(contextFile)) return { content: [{ type: "text", text: "No local context found." }], details: {} };
                return { content: [{ type: "text", text: fs.readFileSync(contextFile, "utf-8") }], details: {} };
            } else {
                fs.writeFileSync(contextFile, args.content || "");
                return { content: [{ type: "text", text: "Context updated." }], details: {} };
            }
        }
    };
}

// ─── Heartbeat Tool ─────────────────────────────────────────────────

const HeartbeatSchema = Type.Object({
    action: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("append")]),
    content: Type.Optional(Type.String({ description: "New content for 'write', or text to append for 'append'" }))
});

export function createHeartbeatTool(adapter: AgentAdapter): AgentTool<typeof HeartbeatSchema> {
    return {
        name: "heartbeat",
        description: "Read, write, or append to the HQ Heartbeat note. This note is processed by a server-side cron every 2 minutes — any actionable content will be dispatched as a background job to an available worker. Use 'write' to replace the entire content, 'append' to add a task, or 'read' to check current content.",
        parameters: HeartbeatSchema,
        label: "Heartbeat",
        execute: async (_toolCallId, args) => {
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
}

// ─── MCP Bridge Tool ────────────────────────────────────────────────

const MCPBridgeSchema = Type.Object({
    toolName: Type.String(),
    arguments: Type.Any()
});

export function createMCPBridgeTool(): AgentTool<typeof MCPBridgeSchema> {
    return {
        name: "mcp_bridge",
        description: "Call cloud-hosted MCP servers (Knowledge Graphs, Browser Tools) via the Convex MCP gateway.",
        parameters: MCPBridgeSchema,
        label: "MCP Bridge",
        execute: async (_toolCallId, args) => {
            const mcpGatewayUrl = process.env.MCP_GATEWAY_URL || "";
            const mcpGatewayToken = process.env.MCP_GATEWAY_TOKEN;
            if (!mcpGatewayUrl || !mcpGatewayToken) {
                return { content: [{ type: "text", text: "MCP Bridge not configured: set MCP_GATEWAY_URL and MCP_GATEWAY_TOKEN env vars." }], details: {} };
            }

            try {
                const response = await fetch(mcpGatewayUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${mcpGatewayToken}`,
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
}

// ─── Submit Result Tool (RPC mode) ─────────────────────────────────

const SubmitResultSchema = Type.Object({
    result: Type.Any()
});

export function createSubmitResultTool(state: AgentToolState): AgentTool<typeof SubmitResultSchema> {
    return {
        name: "submit_result",
        description: "Submit the final result of an RPC job. Use this ONLY when the user asks for a direct return value (RPC mode).",
        parameters: SubmitResultSchema,
        label: "Submit Result",
        execute: async (_toolCallId, args) => {
            if (state.currentJobId) {
                state.rpcResult = args.result;
                return { content: [{ type: "text", text: "Result submitted. You may now stop." }], details: {} };
            }
            return { content: [{ type: "text", text: "Error: No active job." }], details: {} };
        }
    };
}

// ─── Chat With User Tool (Interactive mode) ─────────────────────────

const ChatWithUserSchema = Type.Object({
    message: Type.String({ description: "The message or question to ask the user" }),
    waitForResponse: Type.Optional(Type.Boolean({ description: "Whether to wait for the user to respond before continuing" }))
});

export function createChatWithUserTool(
    adapter: AgentAdapter,
    state: AgentToolState,
): AgentTool<typeof ChatWithUserSchema> {
    return {
        name: "chat_with_user",
        description: "Send a message to the user and optionally wait for a response. Use this to ask clarifying questions, confirm actions, or provide updates during long-running tasks. For interactive jobs, set waitForResponse=true to pause execution until the user replies.",
        parameters: ChatWithUserSchema,
        label: "Chat with User",
        execute: async (_toolCallId, args) => {
            console.log(`[Agent -> User]: ${args.message}`);

            if (args.waitForResponse && state.currentJobId) {
                await adapter.updateJobStatus({
                    jobId: state.currentJobId,
                    status: "waiting_for_user" as any,
                    conversationHistory: []
                });

                await adapter.addJobLog({
                    jobId: state.currentJobId,
                    type: "info",
                    content: `Agent: ${args.message}`,
                });

                state.pendingUserResponse = null;
                const startTime = Date.now();
                const timeout = 30 * 60 * 1000;

                while (Date.now() - startTime < timeout) {
                    const job = await adapter.getJob({ jobId: state.currentJobId });

                    if (job && job.status === "running" && job.pendingUserMessage) {
                        state.pendingUserResponse = job.pendingUserMessage;
                        await adapter.updateJobStatus({
                            jobId: state.currentJobId,
                            status: "running" as any,
                            conversationHistory: job.conversationHistory
                        });
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                if (state.pendingUserResponse) {
                    return {
                        content: [{ type: "text", text: state.pendingUserResponse }],
                        details: { received: true, message: state.pendingUserResponse }
                    };
                } else {
                    return {
                        content: [{ type: "text", text: "No response received within timeout period." }],
                        details: { timeout: true }
                    };
                }
            }

            return {
                content: [{ type: "text", text: `Message sent to user: "${args.message}"` }],
                details: { acknowledged: true }
            };
        }
    };
}
