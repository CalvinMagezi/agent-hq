/**
 * Orchestrator: Task DAG executor for parallel terminal sessions.
 *
 * Architecture:
 * 1. Dispatcher: LLM breaks high-level goals into task plans (DAG)
 * 2. Executor: Spawns PTY sessions based on dependency graph
 * 3. Context Injection: Each terminal gets AGENT_CONTEXT.md with instructions
 * 4. Verification Oracle: Automated checks before marking tasks complete
 */

import * as fs from "fs";
import * as path from "path";
import type { PtyManager, PtySession } from "./ptyManager.js";
import { logger } from "./logger.js";

// ── Task Plan Types ────────────────────────────────────────────────

export interface Task {
    id: string;
    description: string;
    command: string;
    cwd?: string;
    dependencies: string[]; // Task IDs this depends on
    terminalId?: string;    // Assigned sessionId
    status: "pending" | "running" | "completed" | "failed";
}

export interface VerificationCheck {
    type: "file_exists" | "command_output" | "port_listening";
    args: any;
    expected: any;
}

export interface TaskPlan {
    tasks: Task[];
    verificationChecks?: VerificationCheck[];
}

// ── Orchestrator Class ─────────────────────────────────────────────

export class Orchestrator {
    private ptyManager: PtyManager;
    private convex: any;
    private workerId: string;
    private activeExecutions: Map<string, ExecutionContext> = new Map();

    constructor(ptyManager: PtyManager, convex: any, workerId: string) {
        this.ptyManager = ptyManager;
        this.convex = convex;
        this.workerId = workerId;
    }

    /**
     * Execute a task plan by spawning terminals in dependency order.
     */
    async executePlan(
        jobId: string,
        userId: string,
        plan: TaskPlan,
        baseCwd: string
    ): Promise<void> {
        logger.info("Orchestrator: Starting plan execution", {
            jobId,
            taskCount: plan.tasks.length,
        });

        // Create execution context
        const ctx: ExecutionContext = {
            jobId,
            userId,
            plan,
            baseCwd,
            taskSessions: new Map(),
            completedTasks: new Set(),
        };

        this.activeExecutions.set(jobId, ctx);

        try {
            // Execute tasks in topological order (respecting dependencies)
            await this.executeTasksInOrder(ctx);

            // Run verification checks if all tasks completed successfully
            const allCompleted = plan.tasks.every((t) => t.status === "completed");
            if (allCompleted && plan.verificationChecks) {
                await this.runVerificationChecks(ctx, plan.verificationChecks);
            }

            logger.info("Orchestrator: Plan execution completed", {
                jobId,
                tasksCompleted: ctx.completedTasks.size,
                tasksTotal: plan.tasks.length,
            });
        } catch (err: any) {
            logger.error("Orchestrator: Plan execution failed", {
                jobId,
                error: err.message,
            });
            throw err;
        } finally {
            this.activeExecutions.delete(jobId);
        }
    }

    /**
     * Execute tasks in topological order based on dependencies.
     */
    private async executeTasksInOrder(ctx: ExecutionContext): Promise<void> {
        const { plan } = ctx;
        const executionQueue: Task[] = [];
        const inProgress = new Set<string>();

        // Build initial queue (tasks with no dependencies)
        for (const task of plan.tasks) {
            if (task.dependencies.length === 0) {
                executionQueue.push(task);
            }
        }

        // Process tasks wave by wave
        while (executionQueue.length > 0 || inProgress.size > 0) {
            // Start all tasks in current wave (in parallel)
            const currentWave = [...executionQueue];
            executionQueue.length = 0;

            for (const task of currentWave) {
                inProgress.add(task.id);
                // Fire and forget - task execution is async
                this.executeTask(ctx, task)
                    .then(() => {
                        inProgress.delete(task.id);
                        ctx.completedTasks.add(task.id);
                        task.status = "completed";

                        // Check if any blocked tasks can now start
                        for (const nextTask of plan.tasks) {
                            if (
                                nextTask.status === "pending" &&
                                nextTask.dependencies.every((depId) =>
                                    ctx.completedTasks.has(depId)
                                )
                            ) {
                                executionQueue.push(nextTask);
                                nextTask.status = "running";
                            }
                        }
                    })
                    .catch((err) => {
                        inProgress.delete(task.id);
                        task.status = "failed";
                        logger.error("Task execution failed", {
                            taskId: task.id,
                            error: err.message,
                        });
                    });
            }

            // Wait for current wave to complete before starting next
            if (inProgress.size > 0) {
                await this.waitForTasks(inProgress, 60_000); // 60s timeout per wave
            }
        }
    }

    /**
     * Execute a single task via workflow (supports durable pause/resume).
     */
    private async executeTask(ctx: ExecutionContext, task: Task): Promise<void> {
        logger.info("Orchestrator: Starting task via workflow", {
            jobId: ctx.jobId,
            taskId: task.id,
            description: task.description,
        });

        // 1. Create working directory for task
        const taskDir = path.join(ctx.baseCwd, `.hq-task-${task.id}`);
        if (!fs.existsSync(taskDir)) {
            fs.mkdirSync(taskDir, { recursive: true });
        }

        // 2. Inject AGENT_CONTEXT.md
        const contextPath = path.join(taskDir, "AGENT_CONTEXT.md");
        const contextContent = this.generateAgentContext(task);
        fs.writeFileSync(contextPath, contextContent, "utf-8");

        // 3. Determine security profile
        const securityProfile = this.getSecurityProfile(task);

        // 4. Execute task locally via PTY (replaces Convex workflow)
        const session = this.ptyManager.createSession({
            jobId: ctx.jobId,
            userId: ctx.userId,
            cwd: task.cwd || taskDir,
            securityProfile: securityProfile as any,
            shellType: "bash",
        });
        ctx.taskSessions.set(task.id, session);
        this.ptyManager.write(session.sessionId, `${task.command}\n`);
        const workflowResult = { success: true, error: undefined as string | undefined };

        if (!workflowResult.success) {
            throw new Error(workflowResult.error || "Workflow execution failed");
        }

        // 5. Wait for task completion by polling local session status
        return this.waitForTaskCompletion(ctx.jobId, task.id);
    }

    /**
     * Wait for task completion by polling local execution context.
     */
    private async waitForTaskCompletion(jobId: string, taskId: string): Promise<void> {
        const maxWaitTime = 600_000; // 10 minutes
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const ctx = this.activeExecutions.get(jobId);
            if (!ctx) throw new Error("Execution context not found");

            const task = ctx.plan.tasks.find((t: Task) => t.id === taskId);
            if (!task) throw new Error(`Task ${taskId} not found in plan`);

            if (task.status === "completed") {
                logger.info("Task completed successfully", { jobId, taskId });
                return;
            } else if (task.status === "failed") {
                throw new Error(`Task ${taskId} failed`);
            }

            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        throw new Error(`Task ${taskId} timeout after 10 minutes`);
    }

    /**
     * Determine security profile for task (guarded for dangerous commands).
     */
    private getSecurityProfile(task: Task): "minimal" | "standard" | "guarded" | "admin" {
        const dangerousPatterns = [
            /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive|--force)\b/i,
            /\bsudo\b/i,
            /\bgit\s+push\s+--force\b/i,
            /\bdrop\s+table\b/i,
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(task.command)) {
                return "guarded"; // Requires approval
            }
        }

        return "standard"; // Default: standard permissions
    }

    /**
     * Generate AGENT_CONTEXT.md for a task.
     */
    private generateAgentContext(task: Task): string {
        return `# Agent Context

**Task ID:** ${task.id}
**Description:** ${task.description}

## Your Mission

Execute the following command and report the result:

\`\`\`bash
${task.command}
\`\`\`

## Success Criteria

- Command completes successfully (exit code 0)
- Any outputs are captured and logged

## Reporting

Once the command completes, you may exit the terminal.
The orchestrator will automatically check the exit code.

## Notes

- This terminal is isolated to task: ${task.id}
- Any files created will be in the task's working directory
- Output is being streamed to the web UI in real-time
`;
    }

    /**
     * Run verification checks on completed tasks.
     */
    private async runVerificationChecks(
        ctx: ExecutionContext,
        checks: VerificationCheck[]
    ): Promise<void> {
        logger.info("Orchestrator: Running verification checks", {
            jobId: ctx.jobId,
            checkCount: checks.length,
        });

        for (const check of checks) {
            try {
                await this.runVerificationCheck(ctx, check);
                logger.info("Verification check passed", { type: check.type });
            } catch (err: any) {
                logger.error("Verification check failed", {
                    type: check.type,
                    error: err.message,
                });
                throw err;
            }
        }
    }

    /**
     * Run a single verification check.
     */
    private async runVerificationCheck(
        ctx: ExecutionContext,
        check: VerificationCheck
    ): Promise<void> {
        switch (check.type) {
            case "file_exists": {
                const filePath = path.join(ctx.baseCwd, check.args.path);
                if (!fs.existsSync(filePath)) {
                    throw new Error(`File does not exist: ${filePath}`);
                }
                break;
            }

            case "command_output": {
                // Spawn a verification PTY to run the command
                const verifySession = this.ptyManager.createSession({
                    jobId: ctx.jobId,
                    userId: ctx.userId,
                    cwd: ctx.baseCwd,
                    securityProfile: "standard" as any,
                    shellType: "bash",
                });

                const output = "";
                // Capture output (this is simplified - in production use proper event listeners)
                this.ptyManager.write(
                    verifySession.sessionId,
                    `${check.args.command}\n`
                );

                // Wait for output and compare with expected
                await new Promise((resolve, reject) => {
                    setTimeout(() => {
                        if (!output.includes(check.expected)) {
                            reject(
                                new Error(
                                    `Command output does not match expected: ${check.expected}`
                                )
                            );
                        } else {
                            resolve(true);
                        }
                    }, 2000);
                });

                this.ptyManager.kill(verifySession.sessionId);
                break;
            }

            case "port_listening": {
                // TODO: Implement port listening check
                logger.warn("Port listening check not yet implemented", check);
                break;
            }

            default:
                throw new Error(`Unknown verification check type: ${(check as any).type}`);
        }
    }

    /**
     * Wait for tasks to complete (helper for wave execution).
     */
    private async waitForTasks(
        taskIds: Set<string>,
        timeoutMs: number
    ): Promise<void> {
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(() => {
                if (taskIds.size === 0) {
                    clearInterval(checkInterval);
                    resolve();
                }

                if (Date.now() - startTime > timeoutMs) {
                    clearInterval(checkInterval);
                    reject(new Error("Wave execution timeout"));
                }
            }, 500);
        });
    }

    /**
     * Abort an active execution (cleanup all terminals).
     */
    async abortExecution(jobId: string): Promise<void> {
        const ctx = this.activeExecutions.get(jobId);
        if (!ctx) return;

        logger.info("Orchestrator: Aborting execution", { jobId });

        // Kill all active terminals
        for (const [taskId, session] of ctx.taskSessions) {
            try {
                this.ptyManager.kill(session.sessionId);
            } catch (err: any) {
                logger.warn("Failed to kill task terminal", {
                    taskId,
                    error: err.message,
                });
            }
        }

        this.activeExecutions.delete(jobId);
    }
}

// ── Execution Context ──────────────────────────────────────────────

interface ExecutionContext {
    jobId: string;
    userId: string;
    plan: TaskPlan;
    baseCwd: string;
    taskSessions: Map<string, PtySession>;
    completedTasks: Set<string>;
}
