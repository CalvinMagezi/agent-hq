import { Job, JobStatus, JobType, SecurityProfile, ThinkingLevel } from "@repo/vault-client";
import { FbmqPriority, MessageCodec, ParsedHeaders } from "../types";

export function getPriority(agentPriority: number): FbmqPriority {
    if (agentPriority >= 75) return "critical";
    if (agentPriority >= 50) return "high";
    if (agentPriority >= 25) return "normal";
    return "low";
}

export function parsePriority(fbmqPriority: string | undefined): number {
    switch (fbmqPriority) {
        case "critical": return 80;
        case "high": return 60;
        case "normal": return 30;
        case "low": return 10;
        default: return 30;
    }
}

export const jobCodec: MessageCodec<Job> = {
    serialize(job: Job) {
        const custom: Record<string, string> = {
            jobId: job.jobId,
            type: job.type,
            status: job.status,
            securityProfile: job.securityProfile,
        };

        if (job.modelOverride) custom.modelOverride = job.modelOverride;
        if (job.thinkingLevel) custom.thinkingLevel = job.thinkingLevel;
        if (job.workerId) custom.workerId = job.workerId;
        if (job.threadId) custom.threadId = job.threadId;
        if (job.spanId) custom.spanId = job.spanId;
        if (job.createdAt) custom.createdAt = job.createdAt;
        if (job.updatedAt) custom.updatedAt = job.updatedAt;

        if (job.result) custom.result = encodeURIComponent(job.result);
        if (job.streamingText) custom.streamingText = encodeURIComponent(job.streamingText);
        if (job.steeringMessage) custom.steeringMessage = encodeURIComponent(job.steeringMessage);
        if (job.stats) custom.stats = encodeURIComponent(JSON.stringify(job.stats));
        if (job.conversationHistory) custom.conversationHistory = encodeURIComponent(JSON.stringify(job.conversationHistory));

        return {
            body: job.instruction,
            priority: getPriority(job.priority),
            tags: `${job.type},${job.securityProfile}`,
            correlationId: job.traceId,
            custom
        };
    },

    deserialize(claimedPath: string, body: string, headers: ParsedHeaders): Job {
        const custom = headers.custom || {};

        const job: Job = {
            jobId: custom.jobId || "unknown",
            type: (custom.type as JobType) || "background",
            status: (custom.status as JobStatus) || "pending",
            priority: parsePriority(headers.priority),
            securityProfile: (custom.securityProfile as SecurityProfile) || "standard",
            modelOverride: custom.modelOverride || null,
            thinkingLevel: (custom.thinkingLevel as ThinkingLevel) || null,
            workerId: custom.workerId || null,
            threadId: custom.threadId || null,
            instruction: body,
            createdAt: custom.createdAt || new Date().toISOString(),
            updatedAt: custom.updatedAt,
            traceId: headers.correlationId,
            spanId: custom.spanId,
            _filePath: claimedPath
        };

        if (custom.result) job.result = decodeURIComponent(custom.result);
        if (custom.streamingText) job.streamingText = decodeURIComponent(custom.streamingText);
        if (custom.steeringMessage) job.steeringMessage = decodeURIComponent(custom.steeringMessage);
        if (custom.stats) {
            try { job.stats = JSON.parse(decodeURIComponent(custom.stats)); } catch (e) { }
        }
        if (custom.conversationHistory) {
            try { job.conversationHistory = JSON.parse(decodeURIComponent(custom.conversationHistory)); } catch (e) { }
        }

        return job;
    }
};
