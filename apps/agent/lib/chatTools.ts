/**
 * Lightweight tools for the persistent chat session.
 * These tools allow the chat LLM to dispatch background jobs
 * and check their status without having direct file/bash access.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { logger } from "./logger.js";

/** Callback fired when a job is dispatched, so the Discord bot can track it */
export type OnJobDispatched = (jobId: string) => void;

// --- dispatch_job Tool ---

const DispatchJobSchema = Type.Object({
    instruction: Type.String({ description: "What the background job should do" }),
    priority: Type.Optional(Type.Number({ description: "Priority 0-100, higher = sooner. Default 50" })),
    securityProfile: Type.Optional(Type.String({ description: "Security profile: minimal, standard, guarded, admin. Default guarded" })),
});

export function createDispatchJobTool(config: {
    baseUrl?: string;
    apiKey?: string;
    vaultClient?: any;
    discordChannelId?: string;
    discordIsDM?: boolean;
    onJobDispatched?: OnJobDispatched;
}): AgentTool<typeof DispatchJobSchema> {
    return {
        name: "dispatch_job",
        description: "Create a background job for tasks that need file operations, coding, bash commands, or complex multi-step work. The job runs asynchronously — results will be sent to the user when complete. Use this for anything that requires tools you don't have (bash, file read/write/edit, grep, find, etc.).",
        parameters: DispatchJobSchema,
        label: "Dispatch Job",
        execute: async (toolCallId, args) => {
            logger.info("dispatch_job CALLED", { instruction: args.instruction.substring(0, 100), baseUrl: config.baseUrl ?? "vault" });
            try {
                // Vault mode: use VaultClient directly
                if (config.vaultClient) {
                    const jobId = await config.vaultClient.createJob({
                        instruction: args.instruction,
                        type: "background",
                        priority: args.priority ?? 50,
                        securityProfile: args.securityProfile ?? "guarded",
                    });
                    config.onJobDispatched?.(jobId);
                    return {
                        content: [{ type: "text", text: `Job dispatched (ID: ${jobId}). Running in the background.` }],
                        details: { jobId },
                    };
                }

                // HTTP fallback: use Convex HTTP endpoint
                const body: Record<string, unknown> = {
                    instruction: args.instruction,
                    type: "background",
                    priority: args.priority ?? 50,
                    securityProfile: args.securityProfile ?? "guarded",
                };

                // Include Discord context so the job watcher can send results back
                if (config.discordChannelId) {
                    body.discordChannelId = config.discordChannelId;
                    body.discordIsDM = config.discordIsDM ?? false;
                }

                const res = await fetch(`${config.baseUrl}/api/jobs/create`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": config.apiKey ?? "",
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(15000),
                });

                if (!res.ok) {
                    const errorText = await res.text();
                    logger.error("dispatch_job failed", { status: res.status, error: errorText, url: `${config.baseUrl}/api/jobs/create` });
                    if (res.status === 401) {
                        return {
                            content: [{ type: "text", text: `dispatch_job FAILED: API key is invalid or not registered. The user needs to check the AGENTHQ_API_KEY and Convex apiKeys table. Tell the user about this error.` }],
                            details: { error: "API key invalid", status: 401 },
                        };
                    }
                    return {
                        content: [{ type: "text", text: `dispatch_job FAILED (HTTP ${res.status}): ${errorText}. Tell the user about this error so they can fix it.` }],
                        details: { error: errorText, status: res.status },
                    };
                }

                const result: any = await res.json();
                const jobId = result.jobId;

                logger.info("Job dispatched from chat", { jobId, instruction: args.instruction.substring(0, 100) });

                // Notify Discord bot to track this job for result delivery
                config.onJobDispatched?.(jobId);

                return {
                    content: [{
                        type: "text",
                        text: `Job dispatched (ID: ${jobId}). The task is now running in the background and results will be sent when complete.`,
                    }],
                    details: { jobId },
                };
            } catch (error: any) {
                logger.error("dispatch_job error", { error: error.message, url: `${config.baseUrl}/api/jobs/create` });
                return {
                    content: [{ type: "text", text: `dispatch_job FAILED (network error): ${error.message}. The endpoint at ${config.baseUrl ?? "vault"} may be unreachable. Tell the user about this error.` }],
                    details: { error: error.message },
                };
            }
        },
    };
}

// --- check_job_status Tool ---

const CheckJobStatusSchema = Type.Object({
    jobId: Type.String({ description: "The job ID to check" }),
});

export function createCheckJobStatusTool(config: {
    baseUrl?: string;
    apiKey?: string;
    vaultClient?: any;
}): AgentTool<typeof CheckJobStatusSchema> {
    return {
        name: "check_job_status",
        description: "Check the status of a previously dispatched background job. Returns the current status and result if completed.",
        parameters: CheckJobStatusSchema,
        label: "Check Job Status",
        execute: async (toolCallId, args) => {
            try {
                // Vault mode: check job status via VaultClient
                if (config.vaultClient) {
                    const job = await config.vaultClient.getJob(args.jobId);
                    if (!job) {
                        return {
                            content: [{ type: "text", text: `Job ${args.jobId} not found in vault.` }],
                            details: {},
                        };
                    }
                    return {
                        content: [{ type: "text", text: `Job ${args.jobId}: **${job.status}**` }],
                        details: job,
                    };
                }

                // HTTP fallback: use Convex HTTP endpoint
                const res = await fetch(`${config.baseUrl}/api/jobs/status`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": config.apiKey ?? "",
                    },
                    body: JSON.stringify({ jobId: args.jobId }),
                    signal: AbortSignal.timeout(10000),
                });

                if (!res.ok) {
                    return {
                        content: [{ type: "text", text: `Failed to check job status: HTTP ${res.status}` }],
                        details: {},
                    };
                }

                const data: any = await res.json();

                if (!data.ok) {
                    return {
                        content: [{ type: "text", text: `Job not found or error: ${JSON.stringify(data)}` }],
                        details: data,
                    };
                }

                let statusText = `Job ${args.jobId}: **${data.status}**`;
                if (data.status === "done" && data.streamingText) {
                    // Include the actual job output
                    const output = data.streamingText.trim();
                    statusText += `\nResult:\n${output.length > 1500 ? output.substring(0, 1500) + "..." : output}`;
                } else if (data.status === "done" && data.result) {
                    statusText += `\nResult: ${typeof data.result === "string" ? data.result : JSON.stringify(data.result)}`;
                }
                if (data.status === "failed") {
                    statusText += "\nThe job failed. Check logs for details.";
                }

                return {
                    content: [{ type: "text", text: statusText }],
                    details: data,
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Error checking job: ${error.message}` }],
                    details: { error: error.message },
                };
            }
        },
    };
}
