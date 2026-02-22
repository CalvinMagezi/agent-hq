/**
 * PtyManager: Manages multiple PTY (pseudo-terminal) sessions for the agent.
 * Integrates with governance.ts for security, provides lifecycle management, and
 * broadcasts PTY output via WebSocket.
 */

import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { randomUUID } from "crypto";
import { SecurityProfile, createSecuritySpawnHook } from "../governance.js";
import { logger } from "./logger.js";

export interface PtySessionConfig {
    jobId: string;
    userId: string;
    cwd: string;
    securityProfile: SecurityProfile;
    shellType?: "bash" | "zsh" | "sh";
    rows?: number;
    cols?: number;
}

export interface PtySession {
    sessionId: string;
    jobId: string;
    userId: string;
    pty: IPty;
    shellType: string;
    cwd: string;
    securityProfile: SecurityProfile;
    status: "starting" | "running" | "exited" | "error";
    exitCode?: number;
    pid?: number;
    rows: number;
    cols: number;
    commandCount: number;
    lastActivity: number;
    createdAt: number;
}

/**
 * Callback for broadcasting PTY output to WebSocket clients.
 * (sessionId, data) => void
 */
export type PtyOutputCallback = (sessionId: string, data: Buffer) => void;

/**
 * Callback for PTY exit events.
 * (sessionId, exitCode) => void
 */
export type PtyExitCallback = (sessionId: string, exitCode: number) => void;

export class PtyManager {
    private sessions: Map<string, PtySession> = new Map();
    private onOutput?: PtyOutputCallback;
    private onExit?: PtyExitCallback;
    private readonly maxSessions: number = 10; // Safety limit

    constructor(
        onOutput?: PtyOutputCallback,
        onExit?: PtyExitCallback
    ) {
        this.onOutput = onOutput;
        this.onExit = onExit;
    }

    /**
     * Create a new PTY session with security profile integration.
     */
    createSession(config: PtySessionConfig): PtySession {
        // Enforce resource limits
        if (this.sessions.size >= this.maxSessions) {
            throw new Error(`Maximum PTY sessions reached (${this.maxSessions})`);
        }

        const sessionId = randomUUID();
        const shellType = config.shellType || this.detectShell();
        const rows = config.rows || 24;
        const cols = config.cols || 80;

        // Apply security restrictions based on profile
        const shell = this.getSecureShell(config.securityProfile, shellType);
        const env = this.getSanitizedEnv(config.securityProfile);

        logger.info("Creating PTY session", {
            sessionId,
            jobId: config.jobId,
            shell,
            cwd: config.cwd,
            securityProfile: config.securityProfile,
        });

        // Spawn PTY with security-hardened environment
        const ptyInstance = pty.spawn(shell, [], {
            name: "xterm-256color",
            cols,
            rows,
            cwd: config.cwd,
            env,
        });

        const session: PtySession = {
            sessionId,
            jobId: config.jobId,
            userId: config.userId,
            pty: ptyInstance,
            shellType: shell,
            cwd: config.cwd,
            securityProfile: config.securityProfile,
            status: "starting",
            pid: ptyInstance.pid,
            rows,
            cols,
            commandCount: 0,
            lastActivity: Date.now(),
            createdAt: Date.now(),
        };

        // Hook PTY output
        ptyInstance.onData((data) => {
            session.lastActivity = Date.now();
            session.status = "running";
            if (this.onOutput) {
                this.onOutput(sessionId, Buffer.from(data, "utf-8"));
            }
        });

        // Hook PTY exit
        ptyInstance.onExit((event) => {
            session.status = "exited";
            session.exitCode = event.exitCode;
            logger.info("PTY session exited", {
                sessionId,
                exitCode: event.exitCode,
            });
            if (this.onExit) {
                this.onExit(sessionId, event.exitCode);
            }
        });

        this.sessions.set(sessionId, session);

        return session;
    }

    /**
     * Write data to a PTY session.
     */
    write(sessionId: string, data: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`PTY session not found: ${sessionId}`);
        }

        if (session.status === "exited") {
            throw new Error(`PTY session has exited: ${sessionId}`);
        }

        session.pty.write(data);
        session.lastActivity = Date.now();

        // Track command count (simple heuristic: count newlines)
        if (data.includes("\n") || data.includes("\r")) {
            session.commandCount++;
        }
    }

    /**
     * Resize a PTY session.
     */
    resize(sessionId: string, rows: number, cols: number): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`PTY session not found: ${sessionId}`);
        }

        session.pty.resize(cols, rows);
        session.rows = rows;
        session.cols = cols;
        logger.info("PTY resized", { sessionId, rows, cols });
    }

    /**
     * Kill a PTY session.
     */
    kill(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.warn("Attempted to kill non-existent PTY session", { sessionId });
            return;
        }

        try {
            session.pty.kill();
            logger.info("PTY session killed", { sessionId });
        } catch (err: any) {
            logger.error("Error killing PTY", { sessionId, error: err.message });
        } finally {
            this.sessions.delete(sessionId);
        }
    }

    /**
     * Get a session by ID.
     */
    getSession(sessionId: string): PtySession | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Get all sessions for a job.
     */
    getSessionsByJob(jobId: string): PtySession[] {
        return Array.from(this.sessions.values()).filter((s) => s.jobId === jobId);
    }

    /**
     * Cleanup idle sessions (called by cron or on-demand).
     */
    cleanupIdle(maxIdleMs: number = 30 * 60 * 1000): number {
        const now = Date.now();
        let cleaned = 0;

        for (const [sessionId, session] of this.sessions.entries()) {
            const idleMs = now - session.lastActivity;
            if (idleMs > maxIdleMs) {
                logger.info("Cleaning up idle PTY session", {
                    sessionId,
                    idleMs,
                    maxIdleMs,
                });
                this.kill(sessionId);
                cleaned++;
            }
        }

        return cleaned;
    }

    /**
     * Get statistics for monitoring.
     */
    getStats() {
        return {
            totalSessions: this.sessions.size,
            maxSessions: this.maxSessions,
            sessionsByStatus: {
                starting: Array.from(this.sessions.values()).filter((s) => s.status === "starting").length,
                running: Array.from(this.sessions.values()).filter((s) => s.status === "running").length,
                exited: Array.from(this.sessions.values()).filter((s) => s.status === "exited").length,
                error: Array.from(this.sessions.values()).filter((s) => s.status === "error").length,
            },
        };
    }

    /**
     * Detect the default shell for the current user.
     */
    private detectShell(): "bash" | "zsh" | "sh" {
        const shellEnv = process.env.SHELL || "/bin/bash";
        if (shellEnv.includes("zsh")) return "zsh";
        if (shellEnv.includes("bash")) return "bash";
        return "sh";
    }

    /**
     * Get the appropriate shell based on security profile.
     * MINIMAL/STANDARD profiles use rbash (restricted bash) for additional security.
     */
    private getSecureShell(profile: SecurityProfile, requested: string): string {
        // For MINIMAL and STANDARD profiles, use restricted bash if available
        if (profile === SecurityProfile.MINIMAL || profile === SecurityProfile.STANDARD) {
            // Check if rbash exists
            const rbashPath = "/bin/rbash";
            try {
                require("fs").accessSync(rbashPath);
                return rbashPath;
            } catch {
                // rbash not available, fall back to regular shell with warning
                logger.warn("rbash not available, using regular shell with restricted profile", { profile });
            }
        }

        // Return requested shell for GUARDED and ADMIN profiles
        if (requested === "zsh") return process.env.SHELL?.includes("zsh") ? process.env.SHELL : "/bin/zsh";
        if (requested === "sh") return "/bin/sh";
        return "/bin/bash";
    }

    /**
     * Sanitize environment variables based on security profile.
     * Strips sensitive credentials that should never be exposed to PTY sessions.
     */
    private getSanitizedEnv(profile: SecurityProfile): NodeJS.ProcessEnv {
        const env = { ...process.env };

        // ALWAYS strip sensitive env vars regardless of profile
        const sensitiveVars = [
            "OPENROUTER_API_KEY",
            "GEMINI_API_KEY",
            "AGENTHQ_API_KEY",
            "MCP_GATEWAY_TOKEN",
            "DISCORD_BOT_TOKEN",
            "VAULT_PATH",
        ];

        for (const key of sensitiveVars) {
            delete env[key];
        }

        // For MINIMAL profile, restrict PATH and other capabilities
        if (profile === SecurityProfile.MINIMAL) {
            env.PATH = "/usr/bin:/bin"; // No /usr/local/bin, no user paths
            delete env.HOME; // Prevent access to home directory
        }

        return env;
    }

    /**
     * Cleanup all sessions (used on agent shutdown).
     */
    shutdown(): void {
        logger.info("Shutting down PtyManager", { sessionCount: this.sessions.size });
        for (const sessionId of this.sessions.keys()) {
            this.kill(sessionId);
        }
    }
}
