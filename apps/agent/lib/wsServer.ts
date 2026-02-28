/**
 * WebSocket server for the local HQ agent.
 * Provides real-time chat to the web UI using the same ChatSessionManager
 * that Discord uses. Binds to 127.0.0.1 only (local-only, no auth needed).
 *
 * Protocol: simple JSON frames (req/res/event) inspired by OpenClaw.
 */

import { WebSocketServer, WebSocket } from "ws";
import { ChatSessionManager, type StreamCallbacks } from "./chatSession.js";
import { classifyIntent, type IntentRule } from "@repo/discord-core";
import { logger } from "./logger.js";
import { PtyManager, type PtySessionConfig } from "./ptyManager.js";
import { SecurityProfile } from "../governance.js";

// ── Protocol Types (mirrored from apps/web/lib/ws-protocol.ts) ──

interface WsRequest {
    type: "req";
    id: string;
    method: string;
    params?: Record<string, unknown>;
}

interface WsResponse {
    type: "res";
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: string;
}

interface WsEvent {
    type: "event";
    event: string;
    payload: unknown;
}

// ── Server ──────────────────────────────────────────────────────

export interface AgentWsServerConfig {
    port: number;
    chatSession: ChatSessionManager;
    agentContext: () => Record<string, unknown>;
    intentRules?: IntentRule[];
    ptyManager: PtyManager;
    convexMutate: (name: string, args: Record<string, unknown>) => Promise<any>;
    convexQuery: (name: string, args: Record<string, unknown>) => Promise<any>;
}

export class AgentWsServer {
    private wss: WebSocketServer | null = null;
    private clients: Set<WebSocket> = new Set();
    private config: AgentWsServerConfig;
    /** Server-level guard — prevents concurrent chat processing for ALL paths (instant + LLM) */
    private processing = false;

    constructor(config: AgentWsServerConfig) {
        this.config = config;
    }

    start(): void {
        this.wss = new WebSocketServer({
            port: this.config.port,
            host: "127.0.0.1",
        });

        this.wss.on("connection", (ws) => {
            this.clients.add(ws);
            logger.info("WS client connected", { total: this.clients.size });

            ws.on("message", (data) => {
                this.handleRawMessage(ws, data);
            });

            ws.on("close", () => {
                this.clients.delete(ws);
                logger.info("WS client disconnected", { total: this.clients.size });
            });

            ws.on("error", (err) => {
                logger.warn("WS client error", { error: err.message });
                this.clients.delete(ws);
            });
        });

        this.wss.on("error", (err) => {
            logger.error("WS server error", { error: err.message });
        });

        logger.info("WebSocket server started", { port: this.config.port, host: "127.0.0.1" });
    }

    stop(): void {
        if (!this.wss) return;

        for (const ws of this.clients) {
            try {
                ws.close(1001, "Server shutting down");
            } catch (_e) {
                // Ignore errors closing websockets during shutdown
            }
        }
        this.clients.clear();

        this.wss.close();
        this.wss = null;
        logger.info("WebSocket server stopped");
    }

    // ── Message routing ─────────────────────────────────────────

    private handleRawMessage(ws: WebSocket, data: unknown): void {
        // Binary frames: PTY input (first 36 bytes = sessionId UUID, rest = input)
        if (data instanceof Buffer) {
            if (data.length < 36) {
                logger.warn("Invalid binary frame: too short", { length: data.length });
                return;
            }
            const sessionId = data.subarray(0, 36).toString("utf-8");
            const ptyInput = data.subarray(36).toString("utf-8");
            try {
                this.config.ptyManager.write(sessionId, ptyInput);
            } catch (err: any) {
                logger.error("Failed to write to PTY", { sessionId, error: err.message });
            }
            return;
        }

        // Text frames: JSON-RPC
        let req: WsRequest;
        try {
            const text = typeof data === "string" ? data : (data as any).toString();
            req = JSON.parse(text) as WsRequest;
        } catch {
            this.sendResponse(ws, "unknown", false, undefined, "Invalid JSON");
            return;
        }

        if (req.type !== "req" || !req.id || !req.method) {
            this.sendResponse(ws, req.id || "unknown", false, undefined, "Invalid request frame");
            return;
        }

        switch (req.method) {
            case "chat.send":
                this.handleChatSend(ws, req);
                break;
            case "chat.abort":
                this.handleChatAbort(ws, req);
                break;
            case "chat.reset":
                this.handleChatReset(ws, req);
                break;
            case "status":
                this.handleStatus(ws, req);
                break;
            case "terminal.create":
                this.handleTerminalCreate(ws, req);
                break;
            case "terminal.write":
                this.handleTerminalWrite(ws, req);
                break;
            case "terminal.resize":
                this.handleTerminalResize(ws, req);
                break;
            case "terminal.kill":
                this.handleTerminalKill(ws, req);
                break;
            default:
                this.sendResponse(ws, req.id, false, undefined, `Unknown method: ${req.method}`);
        }
    }

    // ── chat.send ───────────────────────────────────────────────

    private async handleChatSend(ws: WebSocket, req: WsRequest): Promise<void> {
        const text = (req.params?.text as string)?.trim();
        if (!text) {
            this.sendResponse(ws, req.id, false, undefined, "Missing params.text");
            return;
        }

        // Server-level guard covers BOTH instant and LLM paths
        if (this.processing || this.config.chatSession.busy) {
            this.sendResponse(ws, req.id, false, undefined, "Still processing a previous message");
            return;
        }

        this.processing = true;

        // Acknowledge the request immediately
        this.sendResponse(ws, req.id, true, { accepted: true });

        // Broadcast busy state
        this.broadcast({ type: "event", event: "chat.busy", payload: { busy: true } });

        try {
            // 1. Try instant classification first (regex-based, no LLM)
            const ctx = this.config.agentContext();
            const classification = classifyIntent(text, this.config.intentRules, ctx);

            if (classification.tier === "instant" && classification.instantResponse) {
                logger.info("WS instant reply", { reason: classification.reason });
                this.broadcast({
                    type: "event",
                    event: "chat.final",
                    payload: { text: classification.instantResponse },
                });
                return;
            }

            // 2. Chat session (LLM-backed, with streaming)
            let accumulated = "";

            const callbacks: StreamCallbacks = {
                onDelta: (delta) => {
                    accumulated += delta;
                    this.broadcast({
                        type: "event",
                        event: "chat.delta",
                        payload: { text: accumulated },
                    });
                },
                onToolStart: (name) => {
                    this.broadcast({
                        type: "event",
                        event: "chat.tool",
                        payload: { name, status: "start" },
                    });
                },
                onToolEnd: (name) => {
                    this.broadcast({
                        type: "event",
                        event: "chat.tool",
                        payload: { name, status: "end" },
                    });
                },
            };

            const finalText = await this.config.chatSession.handleMessage(text, callbacks);

            this.broadcast({
                type: "event",
                event: "chat.final",
                payload: { text: finalText },
            });
        } catch (err: any) {
            logger.error("WS chat error", { error: err.message });
            this.broadcast({
                type: "event",
                event: "chat.error",
                payload: { message: err.message || "Chat session error" },
            });
        } finally {
            this.processing = false;
            this.broadcast({ type: "event", event: "chat.busy", payload: { busy: false } });
        }
    }

    // ── chat.abort ──────────────────────────────────────────────

    private handleChatAbort(ws: WebSocket, req: WsRequest): void {
        // Reset the chat session to abort current processing
        this.config.chatSession.reset();
        this.sendResponse(ws, req.id, true, { aborted: true });
        this.broadcast({ type: "event", event: "chat.busy", payload: { busy: false } });
        logger.info("WS chat aborted");
    }

    // ── chat.reset ──────────────────────────────────────────────

    private handleChatReset(ws: WebSocket, req: WsRequest): void {
        this.config.chatSession.reset();
        this.sendResponse(ws, req.id, true, { reset: true });
        logger.info("WS chat reset");
    }

    // ── status ──────────────────────────────────────────────────

    private handleStatus(ws: WebSocket, req: WsRequest): void {
        const ctx = this.config.agentContext();
        this.sendResponse(ws, req.id, true, {
            agent: ctx.isBusy ? "busy" : "online",
            targetDir: ctx.targetDir,
            workerId: ctx.workerId,
        });
    }

    // ── Helpers ─────────────────────────────────────────────────

    private sendResponse(ws: WebSocket, id: string, ok: boolean, payload?: unknown, error?: string): void {
        const frame: WsResponse = { type: "res", id, ok };
        if (payload !== undefined) frame.payload = payload;
        if (error !== undefined) frame.error = error;

        try {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(frame));
            }
        } catch (err: any) {
            logger.warn("Failed to send WS response", { error: err.message });
        }
    }

    broadcast(msg: WsEvent): void {
        const data = JSON.stringify(msg);
        for (const ws of this.clients) {
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(data);
                }
            } catch (_e) {
                // Ignore websocket send errors
            }
        }
    }

    /**
     * Broadcast binary PTY data to all connected clients.
     * Frame format: [36-byte sessionId UUID][PTY data]
     */
    broadcastBinary(sessionId: string, data: Buffer): void {
        const sessionIdBuffer = Buffer.from(sessionId, "utf-8");
        if (sessionIdBuffer.length !== 36) {
            logger.error("Invalid sessionId length for binary frame", { sessionId, length: sessionIdBuffer.length });
            return;
        }
        const frame = Buffer.concat([sessionIdBuffer, data]);

        for (const ws of this.clients) {
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(frame);
                }
            } catch (err: any) {
                logger.warn("Failed to broadcast binary frame", { error: err.message });
            }
        }
    }

    // ── terminal.create ─────────────────────────────────────────

    private async handleTerminalCreate(ws: WebSocket, req: WsRequest): Promise<void> {
        const { jobId, cwd, securityProfile, shellType, rows, cols } = req.params as {
            jobId: string;
            cwd?: string;
            securityProfile?: SecurityProfile;
            shellType?: "bash" | "zsh" | "sh";
            rows?: number;
            cols?: number;
        };

        if (!jobId) {
            this.sendResponse(ws, req.id, false, undefined, "Missing jobId");
            return;
        }

        try {
            const ctx = this.config.agentContext();
            const config: PtySessionConfig = {
                jobId,
                userId: "local-user",
                cwd: cwd || (ctx.targetDir as string) || process.cwd(),
                securityProfile: securityProfile || SecurityProfile.STANDARD,
                shellType,
                rows,
                cols,
            };

            const session = this.config.ptyManager.createSession(config);

            // Register session in Convex
            await this.config.convexMutate("agent:createTerminalSession", {
                jobId,
                sessionId: session.sessionId,
                workerId: ctx.workerId,
                shellType: session.shellType,
                cwd: session.cwd,
                securityProfile: session.securityProfile,
                rows: session.rows,
                cols: session.cols,
                pid: session.pid,
            });

            this.sendResponse(ws, req.id, true, {
                sessionId: session.sessionId,
                pid: session.pid,
            });

            // Broadcast creation event
            this.broadcast({
                type: "event",
                event: "terminal.created",
                payload: {
                    sessionId: session.sessionId,
                    jobId,
                    pid: session.pid,
                },
            });
        } catch (err: any) {
            logger.error("Failed to create terminal", { error: err.message });
            this.sendResponse(ws, req.id, false, undefined, err.message);
        }
    }

    // ── terminal.write ──────────────────────────────────────────

    private handleTerminalWrite(ws: WebSocket, req: WsRequest): void {
        const { sessionId, data } = req.params as { sessionId: string; data: string };

        if (!sessionId || data === undefined) {
            this.sendResponse(ws, req.id, false, undefined, "Missing sessionId or data");
            return;
        }

        try {
            this.config.ptyManager.write(sessionId, data);
            this.sendResponse(ws, req.id, true, { ok: true });
        } catch (err: any) {
            logger.error("Failed to write to terminal", { sessionId, error: err.message });
            this.sendResponse(ws, req.id, false, undefined, err.message);
        }
    }

    // ── terminal.resize ─────────────────────────────────────────

    private handleTerminalResize(ws: WebSocket, req: WsRequest): void {
        const { sessionId, rows, cols } = req.params as {
            sessionId: string;
            rows: number;
            cols: number;
        };

        if (!sessionId || !rows || !cols) {
            this.sendResponse(ws, req.id, false, undefined, "Missing sessionId, rows, or cols");
            return;
        }

        try {
            this.config.ptyManager.resize(sessionId, rows, cols);
            this.sendResponse(ws, req.id, true, { ok: true });
        } catch (err: any) {
            logger.error("Failed to resize terminal", { sessionId, error: err.message });
            this.sendResponse(ws, req.id, false, undefined, err.message);
        }
    }

    // ── terminal.kill ───────────────────────────────────────────

    private async handleTerminalKill(ws: WebSocket, req: WsRequest): Promise<void> {
        const { sessionId } = req.params as { sessionId: string };

        if (!sessionId) {
            this.sendResponse(ws, req.id, false, undefined, "Missing sessionId");
            return;
        }

        try {
            this.config.ptyManager.kill(sessionId);

            // Update status in Convex
            await this.config.convexMutate("agent:updateTerminalStatus", {
                sessionId,
                status: "exited",
                exitCode: 143, // SIGTERM
            });

            this.sendResponse(ws, req.id, true, { ok: true });

            // Broadcast exit event
            this.broadcast({
                type: "event",
                event: "terminal.exit",
                payload: {
                    sessionId,
                    exitCode: 143,
                },
            });
        } catch (err: any) {
            logger.error("Failed to kill terminal", { sessionId, error: err.message });
            this.sendResponse(ws, req.id, false, undefined, err.message);
        }
    }
}
