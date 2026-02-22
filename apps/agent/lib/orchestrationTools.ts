/**
 * Orchestration Tools: LLM-callable tools for dispatching parallel tasks.
 * These tools allow the agent to break down high-level goals into DAG-based task plans.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { logger } from "./logger.js";

// ── Tool Schemas ───────────────────────────────────────────────────

export const DispatchParallelTasksSchema = Type.Object({
    tasks: Type.Array(Type.Object({
        id: Type.String({ description: "Unique task identifier (e.g., 'build', 'test', 'deploy')" }),
        description: Type.String({ description: "Human-readable description of what this task does" }),
        command: Type.String({ description: "Shell command to execute" }),
        cwd: Type.Optional(Type.String({ description: "Working directory (optional, defaults to task-specific dir)" })),
        dependencies: Type.Array(Type.String(), { description: "Array of task IDs this task depends on (for DAG ordering)" }),
    })),
    verificationChecks: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([
            Type.Literal("file_exists"),
            Type.Literal("command_output"),
            Type.Literal("port_listening"),
        ]),
        args: Type.Any({ description: "Type-specific arguments" }),
        expected: Type.Any({ description: "Expected result" }),
    })))
});

// ── Tool Definitions ───────────────────────────────────────────────

/**
 * dispatch_parallel_tasks: Break down a complex goal into parallel terminal tasks.
 *
 * Usage Example:
 * User: "Build the frontend and backend in parallel, then deploy"
 *
 * Agent calls:
 * dispatch_parallel_tasks({
 *   tasks: [
 *     { id: "build-frontend", command: "cd apps/web && npm run build", dependencies: [] },
 *     { id: "build-backend", command: "cd apps/agent && npm run build", dependencies: [] },
 *     { id: "deploy", command: "./deploy.sh", dependencies: ["build-frontend", "build-backend"] }
 *   ],
 *   verificationChecks: [
 *     { type: "file_exists", args: { path: "apps/web/dist/index.html" }, expected: true }
 *   ]
 * })
 */
export function createDispatchParallelTasksTool(
    onDispatch: (taskPlan: any, jobId: string) => Promise<void>
): AgentTool<typeof DispatchParallelTasksSchema> {
    return {
        name: "dispatch_parallel_tasks",
        description: `Dispatch multiple terminal tasks to run in parallel or sequentially based on dependencies.

Use this when you need to:
- Run multiple commands in parallel (e.g., build frontend + backend simultaneously)
- Chain tasks with dependencies (e.g., run tests THEN deploy)
- Execute a complex multi-step workflow with verification

Each task spawns its own isolated terminal session. Tasks with no dependencies run in parallel.
Tasks with dependencies wait for their prerequisites to complete.

The orchestrator automatically:
1. Creates a working directory for each task (.hq-task-{id})
2. Injects AGENT_CONTEXT.md with task instructions
3. Streams output from all terminals to the web UI
4. Runs verification checks after all tasks complete
5. Reports success/failure back to the user`,
        parameters: DispatchParallelTasksSchema,
        label: "Dispatch Parallel Tasks",
        execute: async (toolCallId, args) => {
            try {
                logger.info("Dispatching parallel tasks", {
                    taskCount: args.tasks.length,
                    toolCallId,
                });

                // Validate task plan
                const validation = validateTaskPlan(args);
                if (!validation.valid) {
                    return {
                        content: [{
                            type: "text",
                            text: `❌ Task plan validation failed: ${validation.error}`
                        }],
                        details: {}
                    };
                }

                // Trigger orchestrator (this will be set by the main agent loop)
                // The onDispatch callback will receive the task plan and job ID
                const jobId = (global as any).__currentJobId || "unknown";
                await onDispatch(args, jobId);

                // Build success response
                const taskList = args.tasks.map((t, i) =>
                    `${i + 1}. **${t.id}**: ${t.description}\n   Command: \`${t.command}\`\n   Dependencies: ${t.dependencies.length > 0 ? t.dependencies.join(", ") : "none"}`
                ).join("\n\n");

                return {
                    content: [{
                        type: "text",
                        text: `✅ Dispatched ${args.tasks.length} parallel tasks:\n\n${taskList}\n\n🔄 Tasks are now executing. You can monitor progress in the web UI terminal grid.`
                    }],
                    details: {
                        taskCount: args.tasks.length,
                        tasks: args.tasks.map(t => ({ id: t.id, description: t.description }))
                    }
                };
            } catch (err: any) {
                logger.error("Failed to dispatch parallel tasks", {
                    error: err.message,
                    toolCallId,
                });
                return {
                    content: [{
                        type: "text",
                        text: `❌ Failed to dispatch tasks: ${err.message}`
                    }],
                    details: { error: err.message }
                };
            }
        }
    };
}

/**
 * Validate a task plan for common errors.
 */
function validateTaskPlan(plan: any): { valid: boolean; error?: string } {
    // Check for empty tasks
    if (!plan.tasks || plan.tasks.length === 0) {
        return { valid: false, error: "Task plan must contain at least one task" };
    }

    // Check for duplicate task IDs
    const taskIds = new Set<string>();
    for (const task of plan.tasks) {
        if (taskIds.has(task.id)) {
            return { valid: false, error: `Duplicate task ID: ${task.id}` };
        }
        taskIds.add(task.id);
    }

    // Check for invalid dependencies (referencing non-existent tasks)
    for (const task of plan.tasks) {
        for (const depId of task.dependencies) {
            if (!taskIds.has(depId)) {
                return {
                    valid: false,
                    error: `Task "${task.id}" depends on non-existent task "${depId}"`
                };
            }
        }
    }

    // Check for circular dependencies (simplified check)
    const hasCycle = detectCycle(plan.tasks);
    if (hasCycle) {
        return { valid: false, error: "Task plan contains circular dependencies" };
    }

    return { valid: true };
}

/**
 * Detect circular dependencies in task graph (DFS-based cycle detection).
 */
function detectCycle(tasks: any[]): boolean {
    const graph = new Map<string, string[]>();
    for (const task of tasks) {
        graph.set(task.id, task.dependencies);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();

    function dfs(taskId: string): boolean {
        if (recStack.has(taskId)) return true; // Cycle detected
        if (visited.has(taskId)) return false;

        visited.add(taskId);
        recStack.add(taskId);

        const deps = graph.get(taskId) || [];
        for (const dep of deps) {
            if (dfs(dep)) return true;
        }

        recStack.delete(taskId);
        return false;
    }

    for (const task of tasks) {
        if (dfs(task.id)) return true;
    }

    return false;
}
