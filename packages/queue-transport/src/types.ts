export type FbmqPriority = "critical" | "high" | "normal" | "low";

export interface QueueConfig {
    queueRoot: string;        // absolute path to fbmq queue dir
    fbmqBin?: string;         // default: "fbmq"
    usePriority?: boolean;
    leaseTimeoutSecs?: number;
    maxRetries?: number;
}

export interface ParsedHeaders {
    priority?: string;
    tags?: string[];
    correlationId?: string;
    ttl?: number;
    createdBy?: string;
    custom?: Record<string, string>;
    raw?: Map<string, string>;
}

export interface MessageCodec<T> {
    serialize(item: T): {
        body: string;
        priority: FbmqPriority;
        tags?: string;
        correlationId?: string;
        ttl?: number;
        createdBy?: string;
        custom?: Record<string, string>
    };
    deserialize(claimedPath: string, body: string, headers: ParsedHeaders): T;
}
