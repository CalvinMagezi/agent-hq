import { DelegatedTask, TaskStatus, HarnessType, DelegationSecurityConstraints } from "@repo/vault-client";
import { FbmqPriority, MessageCodec, ParsedHeaders } from "../types";
import { getPriority, parsePriority } from "./jobCodec";

export const delegationCodec: MessageCodec<DelegatedTask> = {
    serialize(task: DelegatedTask) {
        const custom: Record<string, string> = {
            taskId: task.taskId,
            jobId: task.jobId,
            targetHarnessType: task.targetHarnessType,
            status: task.status,
            deadlineMs: task.deadlineMs.toString(),
            createdAt: task.createdAt,
        };

        if (task.dependsOn && task.dependsOn.length > 0) {
            custom.dependsOn = task.dependsOn.join(",");
        }
        if (task.claimedBy) custom.claimedBy = task.claimedBy;
        if (task.claimedAt) custom.claimedAt = task.claimedAt;
        if (task.spanId) custom.spanId = task.spanId;
        if (task.parentSpanId) custom.parentSpanId = task.parentSpanId;
        if (task.result) custom.result = encodeURIComponent(task.result);
        if (task.error) custom.error = encodeURIComponent(task.error);
        if (task.securityConstraints) {
            custom.securityConstraints = encodeURIComponent(JSON.stringify(task.securityConstraints));
        }

        return {
            body: task.instruction,
            priority: getPriority(task.priority),
            correlationId: task.traceId,
            custom
        };
    },

    deserialize(claimedPath: string, body: string, headers: ParsedHeaders): DelegatedTask {
        const custom = headers.custom || {};

        const task: DelegatedTask = {
            taskId: custom.taskId || "unknown",
            jobId: custom.jobId || "unknown",
            targetHarnessType: (custom.targetHarnessType as HarnessType) || "any",
            status: (custom.status as TaskStatus) || "pending",
            priority: parsePriority(headers.priority),
            deadlineMs: parseInt(custom.deadlineMs || "0", 10),
            dependsOn: custom.dependsOn ? custom.dependsOn.split(",").filter(Boolean) : [],
            claimedBy: custom.claimedBy || null,
            claimedAt: custom.claimedAt || null,
            instruction: body,
            createdAt: custom.createdAt || new Date().toISOString(),
            traceId: headers.correlationId,
            spanId: custom.spanId,
            parentSpanId: custom.parentSpanId,
            _filePath: claimedPath
        };

        if (custom.result) task.result = decodeURIComponent(custom.result);
        if (custom.error) task.error = decodeURIComponent(custom.error);
        if (custom.securityConstraints) {
            try {
                task.securityConstraints = JSON.parse(decodeURIComponent(custom.securityConstraints));
            } catch (e) { }
        }

        return task;
    }
};
